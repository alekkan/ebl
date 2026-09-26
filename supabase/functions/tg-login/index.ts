// Вход через Telegram Login Widget.
// 1) проверяем подпись данных от Telegram (HMAC-SHA256 с ключом sha256(bot_token));
// 2) находим аккаунт участника по telegram id или заранее вписанному Комиссией username;
// 3) заводим пользователя Supabase Auth и отдаём одноразовый token_hash — сайт меняет его на сессию через verifyOtp.
import { createClient } from "npm:@supabase/supabase-js@2";
import { syncAvatar } from "../_shared/avatar.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://ebl.su,https://www.ebl.su,http://ebl.su,http://www.ebl.su,https://alekkan.github.io,https://akanaev87.github.io,http://localhost:8765")
  .split(",").map((s) => s.trim());

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function validTelegram(data: Record<string, string>) {
  const { hash, ...rest } = data;
  if (!hash || !BOT_TOKEN) return false;
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(check)));
  const fresh = Date.now() / 1000 - Number(rest.auth_date) < 86400;
  return sig === hash && fresh;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("Origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers });

  let tg: Record<string, string>;
  try {
    const body = await req.json();
    tg = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
  } catch {
    return fail(400, "Пустой запрос");
  }
  if (!(await validTelegram(tg))) return fail(401, "Telegram не подтвердил вход — попробуй ещё раз");

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const tgId = Number(tg.id);
  const username = tg.username ?? null;
  const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ");

  // аккаунт: по telegram id, иначе по username, который Комиссия вписала заранее
  let { data: acc } = await sb.from("player_accounts").select("*").eq("tg_id", tgId).maybeSingle();
  if (!acc && username) {
    const { data } = await sb.from("player_accounts").select("*").is("tg_id", null).ilike("tg_username", username).maybeSingle();
    acc = data;
  }
  if (!acc) {
    const { data, error } = await sb.from("player_accounts").insert({ tg_id: tgId, tg_username: username, tg_name: name }).select().single();
    if (error) return fail(500, error.message);
    acc = data;
  }

  // пользователь Supabase Auth — служебный адрес, письма никуда не уходят
  const email = `tg${tgId}@users.ebl.app`;
  let authId = acc.auth_user as string | null;
  if (!authId) {
    const { data: created, error } = await sb.auth.admin.createUser({ email, email_confirm: true, user_metadata: { tg_id: tgId, username, name } });
    if (created?.user) authId = created.user.id;
    else if (error) {
      // пользователь уже есть (например, аккаунт пересоздали) — ищем по адресу
      for (let page = 1; !authId && page < 20; page++) {
        const { data: list } = await sb.auth.admin.listUsers({ page, perPage: 200 });
        authId = list?.users.find((u) => u.email === email)?.id ?? null;
        if (!list?.users.length) break;
      }
      if (!authId) return fail(500, error.message);
    }
  }
  // фото профиля — в наше хранилище, если в Telegram оно поменялось (фото есть не у всех и не всем открыто)
  const avatar = await syncAvatar(sb, { tg_id: tgId, tg_photo_src: acc.tg_photo_src }, tg.photo_url).catch(() => null);
  await sb.from("player_accounts").update({
    tg_id: tgId, tg_username: username, tg_name: name, auth_user: authId,
    ...(avatar ? { tg_photo: avatar.url, tg_photo_src: avatar.src } : {}),
  }).eq("id", acc.id);

  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr) return fail(500, linkErr.message);

  let nick: string | null = null;
  if (acc.player_id) {
    const { data: p } = await sb.from("players").select("nick").eq("id", acc.player_id).single();
    nick = p?.nick ?? null;
  }
  return new Response(JSON.stringify({ token_hash: link.properties.hashed_token, nick, claimed_nick: acc.claimed_nick }), { headers });
});
