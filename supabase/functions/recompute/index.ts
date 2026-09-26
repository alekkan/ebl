// Пересчёт турнирной таблицы из входящего остатка и журнала подтверждённых походов.
// Вызывается сайтом после модерации и по расписанию (закрытие недели в воскресенье в 23:00 МСК).
// Расчёт детерминированный: повторный вызов ничего не ломает.
import { createClient } from "npm:@supabase/supabase-js@2";
import { computeStandings } from "../_shared/scoring.js";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Content-Type": "application/json",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  // PostgREST отдаёт не больше 1000 строк за раз; порядок по первичному ключу обязателен —
  // без него строки на стыке страниц могут задвоиться или потеряться
  async function all(table: string, select: string, order: string[], filter?: (q: any) => any) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(select);
      for (const col of order) q = q.order(col);
      q = q.range(from, from + 999);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  try {
    const [settings, baths, legacyVisits, legacyStandings, visits] = await Promise.all([
      all("settings", "key, value", ["key"]),
      all("baths", "id, type, country, region", ["id"]),
      all("legacy_visits", "bath_id, year, nick, n", ["bath_id", "year", "nick"]),
      all("legacy_standings", "*", ["nick"]),
      all("visits", "id, bath_id, entered_at, posted_at, duration_min, visit_players(players(nick))", ["id"], (q) => q.eq("status", "ok")),
    ]);
    const cfg = Object.fromEntries(settings.map((s) => [s.key, s.value]));
    const { standings, breakdown, currentWeek } = computeStandings({
      season: Number(cfg.season ?? 2026),
      cutoverWeek: Number(cfg.cutover_week ?? 40),
      now: new Date(),
      baths: new Map(baths.map((b) => [b.id, b])),
      legacyVisits,
      legacyStandings,
      visits: visits.map((v) => ({ ...v, players: v.visit_players.map((vp: any) => ({ nick: vp.players.nick })) })),
    });
    const now = new Date().toISOString();
    const points = Object.entries(breakdown).flatMap(([visitId, byNick]: [string, any]) =>
      Object.entries(byNick).map(([nick, b]: [string, any]) => ({ visit_id: Number(visitId), nick, total: b.total, lines: b.lines })));
    // таблица и очки походов — одной транзакцией и по очереди с другими пересчётами (см. миграцию recompute_apply)
    const { error } = await sb.rpc("recompute_apply", {
      p_standings: standings.map((s) => ({ ...s, updated_at: now })), p_points: points,
    });
    if (error) throw new Error(error.message);
    return new Response(JSON.stringify({ ok: true, players: standings.length, currentWeek, updated_at: now }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers });
  }
});
