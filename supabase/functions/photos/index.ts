// Фото из походов (docs/photos.md): перекладывает файлы из Telegram в бакет ebl-photos в Яндексе.
// Бот только записывает, какое фото к какому походу (visit_photos), — качать в вебхуке некогда: Telegram ждёт ответа.
//   ?sync=<id> — одно фото: зовёт триггер, как только фото попало в поход;
//   ?sync=all  — все недокачанные, до 5 попыток: pg_cron раз в 10 минут (ebl-photos-sync), если есть что докачать.
// С сайта (POST, вход участника): браузер сам уменьшает фото и кладёт прямо в бакет — тяжёлые файлы через функцию не гоняем:
//   ?upload {visit_id, files: [{w, h}]} — места под фото: строки visit_photos (ready = false) и одноразовые ссылки на запись;
//   ?done {ids} — браузер залил: проверяем, что оба файла в бакете, и показываем фото (ready).
// Пережимать ничего не нужно: Telegram сам хранит фото в нескольких размерах и уже без метаданных (GPS) —
// бот выбрал большой (до 1600 px) и превью. Повторная перекачка безопасна: тот же ключ, те же байты.
// Ключ к бакету (PHOTOS_S3_KEY_ID, PHOTOS_S3_SECRET) кладёт владелец скриптом scripts/setup-photos-bucket.sh — он пишет только сюда.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AwsClient } from "npm:aws4fetch@1.0.20";
import { TELEGRAM_API, YANDEX_S3 as S3 } from "../_shared/hosts.ts";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const BUCKET = Deno.env.get("PHOTOS_BUCKET") ?? "ebl-photos";
const KEY_ID = Deno.env.get("PHOTOS_S3_KEY_ID") ?? "", SECRET = Deno.env.get("PHOTOS_S3_SECRET") ?? "";
const TRIES = 5;
const CACHE = "public, max-age=31536000, immutable";   // файл не меняется никогда: новое фото — новый ключ
const PER_CALL = 10, PER_VISIT = 30;   // за раз и всего на поход — с сайта; бот не ограничен (альбом в Telegram — до 10)
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://ebl.su,https://www.ebl.su,http://ebl.su,http://www.ebl.su,https://alekkan.github.io,http://localhost:8765")
  .split(",").map((s) => s.trim());
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
let cors: Record<string, string> = {};
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { ...cors, "Content-Type": "application/json" } });

// файл из Telegram; тип отдаёт как octet-stream — что это JPEG, проверяем по сигнатуре
async function tgFile(fileId: string): Promise<Uint8Array> {
  const info = await fetch(`${TELEGRAM_API}/bot${TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`).then((r) => r.json()).catch(() => null);
  if (!info?.ok) throw new Error(`getFile: ${info?.description ?? "нет ответа"}`);
  const r = await fetch(`${TELEGRAM_API}/file/bot${TOKEN}/${info.result.file_path}`);
  if (!r.ok) throw new Error(`файл: HTTP ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error("не JPEG");
  return b;
}

// кто зовёт с сайта: участник лиги по его входу
async function playerOf(req: Request): Promise<string | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return null;
  const { data: acc } = await sb.from("player_accounts").select("player_id").eq("auth_user", user.id).maybeSingle();
  return acc?.player_id ?? null;
}

// места под фото с сайта: только тому, кто был в этом походе (как в боте: фото ответом на карточку — только от участников похода)
async function slots(aws: AwsClient, player: string, body: { visit_id?: unknown; files?: unknown }) {
  const visitId = Number(body.visit_id), files = Array.isArray(body.files) ? body.files.slice(0, PER_CALL) : [];
  const size = (x: unknown) => Math.round(Number(x));
  const ok = (f: { w?: unknown; h?: unknown }) => size(f?.w) > 0 && size(f?.w) <= 4000 && size(f?.h) > 0 && size(f?.h) <= 4000;
  if (!visitId || !files.length || !files.every(ok)) return json({ error: "Нужны поход и размеры фото" }, 400);
  // и Комиссии, которая внесла этот поход за участника на сайте: фото из формы грузит она
  const { data: v } = await sb.from("visits").select("id, created_by, entered_by, visit_players(player_id)").eq("id", visitId).maybeSingle();
  // deno-lint-ignore no-explicit-any
  if (!v || (v.created_by !== player && v.entered_by !== player && !(v.visit_players as any[]).some((x) => x.player_id === player))) {
    return json({ error: "Фото добавляют те, кто был в этом походе" }, 403);
  }
  // брошенные загрузки (вкладку закрыли до конца) — подметаем свои старше суток, чтобы не занимали лимит
  await sb.from("visit_photos").delete().eq("added_by", player).eq("source", "site").eq("ready", false)
    .lt("created_at", new Date(Date.now() - 864e5).toISOString());
  const { count } = await sb.from("visit_photos").select("id", { count: "exact", head: true }).eq("visit_id", visitId);
  if ((count ?? 0) + files.length > PER_VISIT) return json({ error: `К одному походу — не больше ${PER_VISIT} фото` }, 409);
  const { data: rows, error } = await sb.from("visit_photos")
    .insert(files.map((f: { w: unknown; h: unknown }) => ({ visit_id: visitId, added_by: player, source: "site", w: size(f.w), h: size(f.h) })))
    .select("id, key");
  if (error) return json({ error: error.message }, 500);
  // одноразовая ссылка на запись: 15 минут, Cache-Control подписан — браузер обязан прислать ровно его
  const link = async (name: string) => {
    const u = new URL(`${S3}/${BUCKET}/${name}`);
    u.searchParams.set("X-Amz-Expires", "900");
    return (await aws.sign(u.toString(), { method: "PUT", headers: { "Cache-Control": CACHE }, aws: { signQuery: true } })).url;
  };
  const photos = await Promise.all(rows!.map(async (r) => ({ id: r.id, put: await link(`${r.key}.jpg`), put_s: await link(`${r.key}_s.jpg`) })));
  return json({ photos, cache: CACHE });
}

// браузер залил: фото показываем, только если в бакете лежат оба файла — большой и превью
async function markReady(aws: AwsClient, player: string, body: { ids?: unknown }) {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Boolean).slice(0, PER_CALL);
  const { data: rows } = await sb.from("visit_photos").select("id, key")
    .in("id", ids.length ? ids : [0]).eq("added_by", player).eq("source", "site").eq("ready", false);
  const there = async (name: string) => (await aws.fetch(`${S3}/${BUCKET}/${name}`, { method: "HEAD" })).ok;
  const ready: number[] = [];
  for (const r of rows ?? []) if (await there(`${r.key}.jpg`) && await there(`${r.key}_s.jpg`)) ready.push(r.id);
  if (ready.length) await sb.from("visit_photos").update({ ready: true }).in("id", ready);
  return json({ ready });
}

Deno.serve(async (req) => {
  const url = new URL(req.url), origin = req.headers.get("Origin");
  cors = {
    "Access-Control-Allow-Origin": origin && ALLOWED.includes(origin) ? origin : ALLOWED[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Vary": "Origin",
  };
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!KEY_ID || !SECRET) return json({ error: "нет ключа к бакету — scripts/setup-photos-bucket.sh" }, 500);
  const aws = new AwsClient({ accessKeyId: KEY_ID, secretAccessKey: SECRET, service: "s3", region: "ru-central1" });
  if (url.searchParams.has("upload") || url.searchParams.has("done")) {
    const player = await playerOf(req);
    if (!player) return json({ error: "Фото добавляют участники лиги — войди через Telegram" }, 401);
    const body = await req.json().catch(() => ({}));
    return url.searchParams.has("upload") ? slots(aws, player, body) : markReady(aws, player, body);
  }
  const sync = url.searchParams.get("sync") ?? "";
  if (sync !== "all" && !/^\d+$/.test(sync)) return json({ error: "?sync=<id>, ?sync=all, ?upload или ?done" }, 400);
  // адрес файла не меняется никогда (новое фото — новый ключ), поэтому браузер может держать его в кэше хоть год
  const put = async (name: string, body: Uint8Array) => {
    const r = await aws.fetch(`${S3}/${BUCKET}/${name}`, {
      method: "PUT", body, headers: { "Content-Type": "image/jpeg", "Cache-Control": CACHE },
    });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  };
  let q = sb.from("visit_photos").select("id, key, tries, tg_file_id, tg_thumb_id")
    .eq("ready", false).not("visit_id", "is", null).not("tg_file_id", "is", null).lt("tries", TRIES);
  q = sync === "all" ? q.order("id").limit(30) : q.eq("id", Number(sync));
  const { data: rows, error } = await q;
  if (error) return json({ error: error.message }, 500);
  let done = 0;
  const failed: { id: number; error: string }[] = [];
  for (const p of rows ?? []) {
    await sb.from("visit_photos").update({ tries: p.tries + 1 }).eq("id", p.id);
    try {
      await put(`${p.key}.jpg`, await tgFile(p.tg_file_id));
      await put(`${p.key}_s.jpg`, await tgFile(p.tg_thumb_id ?? p.tg_file_id));
      await sb.from("visit_photos").update({ ready: true }).eq("id", p.id);
      done++;
    } catch (e) {
      console.error("photos", p.id, e);
      failed.push({ id: p.id, error: String((e as Error)?.message ?? e) });
    }
  }
  return json({ done, failed });
});
