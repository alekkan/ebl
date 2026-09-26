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

  // PostgREST отдаёт не больше 1000 строк за раз
  async function all(table: string, select: string, filter?: (q: any) => any) {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(select).range(from, from + 999);
      if (filter) q = filter(q);
      const { data, error } = await q;
      if (error) throw new Error(`${table}: ${error.message}`);
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  try {
    const [settings, baths, legacyVisits, legacyStandings, visits] = await Promise.all([
      all("settings", "key, value"),
      all("baths", "id, type, country, region"),
      all("legacy_visits", "bath_id, year, nick, n"),
      all("legacy_standings", "*"),
      all("visits", "id, bath_id, entered_at, posted_at, duration_min, visit_players(players(nick))", (q) => q.eq("status", "ok")),
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
    const { error } = await sb.from("standings").upsert(standings.map((s) => ({ ...s, updated_at: now })));
    if (error) throw new Error(error.message);
    const points = Object.entries(breakdown).flatMap(([visitId, byNick]: [string, any]) =>
      Object.entries(byNick).map(([nick, b]: [string, any]) => ({ visit_id: Number(visitId), nick, total: b.total, lines: b.lines })));
    await sb.from("visit_points").delete().gte("visit_id", 0);
    if (points.length) {
      const { error: pErr } = await sb.from("visit_points").insert(points);
      if (pErr) throw new Error(pErr.message);
    }
    return new Response(JSON.stringify({ ok: true, players: standings.length, currentWeek, updated_at: now }), { headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers });
  }
});
