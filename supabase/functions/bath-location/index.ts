// Уточнить точку бани с сайта: участник лиги присылает ссылку на карту или координаты.
// Участник может поставить точку, только если сейчас она примерная; Комиссия — любую.
import { createClient } from "npm:@supabase/supabase-js@2";
import { locate, useDbGeocoder } from "../_shared/geo.ts";
import { placeByPoint } from "../_shared/place.ts";

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://ebl.su,https://www.ebl.su,http://ebl.su,http://www.ebl.su,https://alekkan.github.io,http://localhost:8765")
  .split(",").map((s) => s.trim());

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Origin": origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json", "Vary": "Origin",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  useDbGeocoder(sb);   // геокодер edge-функциям не отвечает — запасной путь через сервер базы
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return fail(401, "Войди через Telegram");
  const { data: acc } = await sb.from("player_accounts").select("player_id, players(is_commission)").eq("auth_user", user.id).maybeSingle();
  if (!acc?.player_id) return fail(403, "Точки ставят участники лиги");

  const body = await req.json().catch(() => ({}));
  // новая баня ещё не создана — просто находим точку по ссылке или адресу
  if (!body.bath_id) {
    const p = await locate(String(body.input ?? ""));
    return p ? new Response(JSON.stringify(p), { headers }) : fail(422, "Не нашёл, где это. Вставь ссылку на баню в картах, адрес с номером дома или координаты");
  }
  const { data: b } = await sb.from("baths").select("id, precision, lat, lng, country, region").eq("id", Number(body.bath_id)).maybeSingle();
  if (!b) return fail(404, "Баня не найдена");
  // адрес сверяем с примерной точкой бани, чтобы не уехать в другой город
  const near = b.lat != null && b.precision !== "exact" ? { lat: b.lat, lng: b.lng } : null;
  const maxKm = ({ city: 80, region: 400, country: 1500 } as Record<string, number>)[b.precision ?? ""] ?? 400;
  const p = await locate(String(body.input ?? ""), near, maxKm);
  if (!p) return fail(422, "Не нашёл, где это. Вставь ссылку на баню в Яндекс/Google Картах, адрес с номером дома или координаты вида 55.7558, 37.6173");
  // deno-lint-ignore no-explicit-any
  if (b.precision === "exact" && b.lat != null && !(acc.players as any)?.is_commission) return fail(409, "Точная точка уже стоит — поменять её может Комиссия");
  // страну и регион не знали — берём по точке в написании Комиссии: без них не посчитать бонусы за регион и страну (п. 14)
  // только по координатам, через геокодер (_shared/place.ts); не ответил — пусто, ночью спросим снова
  const place = !b.country || !b.region ? await placeByPoint(sb, p, b) : {};
  const { error } = await sb.from("baths").update({ lat: p.lat, lng: p.lng, precision: "exact", ...place }).eq("id", b.id);
  if (error) return fail(500, error.message);
  return new Response(JSON.stringify(p), { headers });
});
