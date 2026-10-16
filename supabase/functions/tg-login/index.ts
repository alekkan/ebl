// Вход на сайт через Telegram — два пути, сессия выдаётся одинаково (issue):
// • код из бота (16.10): ?code=new — сайт заводит одноразовый код и секрет; человек подтверждает код в боте
//   («✅ Да, это я», tg-bot); ?code=poll — сайт опрашивает код своим секретом и после подтверждения получает сессию;
// • Telegram Login Widget (запасной, «другие способы»): проверяем подпись данных от Telegram (HMAC-SHA256 с ключом sha256(bot_token)).
// Дальше: находим аккаунт участника по telegram id или заранее вписанному Комиссией username, заводим пользователя
// Supabase Auth и отдаём одноразовый token_hash — сайт меняет его на сессию через verifyOtp.
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

const CODE_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // без 0/O и 1/I — код могут переписывать с экрана
const CODE_TTL_MIN = 10;
const CONFIRMED_TTL_MIN = 10;   // подтвердил в боте, а сайт был в фоне (телефон) — забрать сессию можно ещё 10 минут
const MAX_PENDING = 300;        // кодов за 10 минут — больше не заводим: таблицу не засыпать

const FRESH_SEC = 3600; // данные входа живут час: утёкшей ссылкой #tgAuthResult (история браузера, скриншот) потом не войти

// hash — hex HMAC-SHA256 с ключом sha256(bot_token); crypto.subtle.verify сравнивает подпись за постоянное время
async function validTelegram(data: Record<string, string>) {
  const { hash, ...rest } = data;
  if (!hash || !BOT_TOKEN || !/^[0-9a-f]{64}$/i.test(hash)) return false;
  const age = Date.now() / 1000 - Number(rest.auth_date);
  if (!(age < FRESH_SEC && age > -300)) return false;   // NaN сюда тоже не пройдёт
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const secret = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BOT_TOKEN));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const sig = new Uint8Array(hash.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(check));
}

// в ilike «_» и «%» — шаблоны: без экранирования «v_tek1987» входил в чужой заранее вписанный «vitek1987»
const likeExact = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("Origin")), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status, headers });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { headers });

  let body: Record<string, unknown>;
  try {
    body = await req.json() ?? {};
  } catch {
    return fail(400, "Пустой запрос");
  }
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const mode = new URL(req.url).searchParams.get("code");
  try {
    if (mode === "new") return await newCode(sb, req.headers.get("User-Agent") ?? "", ok, fail);
    if (mode === "poll") return await pollCode(sb, String(body.code ?? ""), String(body.secret ?? ""), ok, fail);

    const tg = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
    if (!(await validTelegram(tg))) return fail(401, "Telegram не подтвердил вход — попробуй ещё раз");
    const name = [tg.first_name, tg.last_name].filter(Boolean).join(" ");
    return ok(await issue(sb, Number(tg.id), tg.username ?? null, name, tg.photo_url));
  } catch (e) {
    return fail(500, (e as Error).message);
  }
});

type Reply = (body: unknown) => Response;
type Fail = (status: number, error: string) => Response;

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

// «Chrome, Mac» из User-Agent — бот показывает, куда входят (подсказка, не защита: заголовок задаёт сам браузер)
function deviceOf(ua: string) {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const br = /YaBrowser/.test(ua) ? "Яндекс Браузер" : /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [br, os].filter(Boolean).join(", ") || null;
}

// deno-lint-ignore no-explicit-any
async function newCode(sb: any, ua: string, ok: Reply, fail: Fail) {
  const since = new Date(Date.now() - CODE_TTL_MIN * 60_000).toISOString();
  const { count } = await sb.from("login_codes").select("code", { count: "exact", head: true }).gt("created_at", since);
  if ((count ?? 0) >= MAX_PENDING) return fail(429, "Слишком много входов разом — попробуй через минуту");
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)));
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => CODE_ABC[b & 31]).join("");
    const expires = new Date(Date.now() + CODE_TTL_MIN * 60_000).toISOString();
    const { error } = await sb.from("login_codes").insert({ code, secret_hash: await sha256(secret), device: deviceOf(ua), expires_at: expires });
    if (!error) return ok({ code, secret, expires_at: expires });
    if (error.code !== "23505") throw new Error(error.message);   // 23505 — такой код уже есть, берём другой
  }
  throw new Error("Не получилось завести код — попробуй ещё раз");
}

// deno-lint-ignore no-explicit-any
async function pollCode(sb: any, code: string, secret: string, ok: Reply, fail: Fail) {
  code = code.toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code) || !/^[0-9a-f]{64}$/.test(secret)) return fail(400, "Нет кода");
  const { data: row } = await sb.from("login_codes").select("*").eq("code", code).maybeSingle();
  if (!row || row.secret_hash !== await sha256(secret)) return fail(404, "Код не найден — начни вход заново");
  if (row.used_at) return fail(410, "По этому коду уже вошли — начни вход заново");
  if (row.denied_at) return fail(403, "Вход отменён в боте");
  if (!row.confirmed_at) return new Date(row.expires_at) < new Date() ? fail(410, "Код устарел") : ok({ pending: true });
  if (Date.now() - new Date(row.confirmed_at).getTime() > CONFIRMED_TTL_MIN * 60_000) return fail(410, "Код устарел");
  // забираем код одним запросом: два опроса разом (вкладка проснулась) сессию получат только один раз
  const { data: taken } = await sb.from("login_codes").update({ used_at: new Date().toISOString() }).eq("code", code).is("used_at", null).select("code");
  if (!taken?.length) return fail(410, "По этому коду уже вошли — начни вход заново");
  return ok(await issue(sb, Number(row.tg_id), row.tg_username, row.tg_name ?? ""));
}

// аккаунт участника → пользователь Supabase Auth → одноразовый token_hash
// deno-lint-ignore no-explicit-any
async function issue(sb: any, tgId: number, username: string | null, name: string, photoUrl?: string) {
  // аккаунт: по telegram id, иначе по username, который Комиссия вписала заранее
  let { data: acc } = await sb.from("player_accounts").select("*").eq("tg_id", tgId).maybeSingle();
  if (!acc && username) {
    // точное совпадение без учёта регистра; сверяем ещё раз здесь — на случай шаблонов, которые PostgREST понимает сам («*»)
    const { data } = await sb.from("player_accounts").select("*").is("tg_id", null).ilike("tg_username", likeExact(username)).limit(5);
    acc = data?.find((a) => a.tg_username?.toLowerCase() === username.toLowerCase()) ?? null;
  }
  if (!acc) {
    const { data, error } = await sb.from("player_accounts").insert({ tg_id: tgId, tg_username: username, tg_name: name }).select().single();
    if (error) throw new Error(error.message);
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
      if (!authId) throw new Error(error.message);
    }
  }
  // фото профиля — в наше хранилище, если в Telegram оно поменялось (фото есть не у всех и не всем открыто)
  const avatar = await syncAvatar(sb, { tg_id: tgId, tg_photo_src: acc.tg_photo_src }, photoUrl).catch(() => null);
  await sb.from("player_accounts").update({
    tg_id: tgId, tg_username: username, tg_name: name, auth_user: authId,
    ...(avatar ? { tg_photo: avatar.url, tg_photo_src: avatar.src } : {}),
  }).eq("id", acc.id);

  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr) throw new Error(linkErr.message);

  let nick: string | null = null;
  if (acc.player_id) {
    const { data: p } = await sb.from("players").select("nick").eq("id", acc.player_id).single();
    nick = p?.nick ?? null;
  }
  return { token_hash: link.properties.hashed_token, nick, claimed_nick: acc.claimed_nick };
}
