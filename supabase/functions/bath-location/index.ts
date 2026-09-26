// Уточнить точку бани с сайта: участник лиги присылает ссылку на карту или координаты.
// Участник может поставить точку, только если сейчас она примерная; Комиссия — любую.
import { createClient } from "npm:@supabase/supabase-js@2";
import { parseLocation } from "../_shared/geo.ts";

const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://ebl.su,https://www.ebl.su,https://alekkan.github.io,http://localhost:8765")
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
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return fail(401, "Войди через Telegram");
  const { data: acc } = await sb.from("player_accounts").select("player_id, players(is_commission)").eq("auth_user", user.id).maybeSingle();
  if (!acc?.player_id) return fail(403, "Точки ставят участники лиги");

  const body = await req.json().catch(() => ({}));
  const p = await parseLocation(String(body.input ?? ""));
  if (!p) return fail(422, "Не получилось достать координаты. В ссылке на карточку организации их нет — нажми на саму точку бани на карте, скопируй ссылку «Поделиться» или вставь координаты вида 55.7558, 37.6173");
  const { data: b } = await sb.from("baths").select("id, precision, lat").eq("id", Number(body.bath_id)).maybeSingle();
  if (!b) return fail(404, "Баня не найдена");
  // deno-lint-ignore no-explicit-any
  if (b.precision === "exact" && b.lat != null && !(acc.players as any)?.is_commission) return fail(409, "Точная точка уже стоит — поменять её может Комиссия");
  const { error } = await sb.from("baths").update({ lat: p.lat, lng: p.lng, precision: "exact" }).eq("id", b.id);
  if (error) return fail(500, error.message);
  return new Response(JSON.stringify(p), { headers });
});
