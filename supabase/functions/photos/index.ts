// Фото из походов (docs/photos.md): перекладывает файлы из Telegram в бакет ebl-photos в Яндексе.
// Бот только записывает, какое фото к какому походу (visit_photos), — качать в вебхуке некогда: Telegram ждёт ответа.
//   ?sync=<id> — одно фото: зовёт триггер, как только фото попало в поход;
//   ?sync=all  — все недокачанные, до 5 попыток: pg_cron раз в 10 минут (ebl-photos-sync), если есть что докачать.
// Пережимать ничего не нужно: Telegram сам хранит фото в нескольких размерах и уже без метаданных (GPS) —
// бот выбрал большой (до 1600 px) и превью. Повторная перекачка безопасна: тот же ключ, те же байты.
// Ключ к бакету (PHOTOS_S3_KEY_ID, PHOTOS_S3_SECRET) кладёт владелец скриптом scripts/setup-photos-bucket.sh — он пишет только сюда.
import { createClient } from "npm:@supabase/supabase-js@2";
import { AwsClient } from "npm:aws4fetch@1.0.20";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const TELEGRAM_API = (Deno.env.get("TELEGRAM_API_URL") || "https://api.telegram.org").replace(/\/+$/, "");
const S3 = (Deno.env.get("S3_URL") || "https://storage.yandexcloud.net").replace(/\/+$/, "");
const BUCKET = Deno.env.get("PHOTOS_BUCKET") ?? "ebl-photos";
const KEY_ID = Deno.env.get("PHOTOS_S3_KEY_ID") ?? "", SECRET = Deno.env.get("PHOTOS_S3_SECRET") ?? "";
const TRIES = 5;
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

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

Deno.serve(async (req) => {
  const sync = new URL(req.url).searchParams.get("sync") ?? "";
  if (sync !== "all" && !/^\d+$/.test(sync)) return json({ error: "?sync=<id> или ?sync=all" }, 400);
  if (!KEY_ID || !SECRET) return json({ error: "нет ключа к бакету — scripts/setup-photos-bucket.sh" }, 500);
  const aws = new AwsClient({ accessKeyId: KEY_ID, secretAccessKey: SECRET, service: "s3", region: "ru-central1" });
  // адрес файла не меняется никогда (новое фото — новый ключ), поэтому браузер может держать его в кэше хоть год
  const put = async (name: string, body: Uint8Array) => {
    const r = await aws.fetch(`${S3}/${BUCKET}/${name}`, {
      method: "PUT", body, headers: { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000, immutable" },
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
