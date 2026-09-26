// Фото профиля из Telegram → наше хранилище (бакет avatars, публичный).
// Сначала через Bot API (актуальное фото и его file_unique_id — по нему видно, менялось ли фото),
// иначе — по ссылке photo_url из данных входа. Перекачиваем, только если фото поменялось.
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const PUBLIC_URL = Deno.env.get("SUPABASE_URL") ?? "";
const TG_PHOTO = /^https:\/\/(t\.me|telegram\.org|[a-z0-9-]+\.telegram\.org|[a-z0-9-]+\.telesco\.pe)\//;

type Account = { tg_id: number; tg_photo_src: string | null };
type Stored = { url: string; src: string };

// последняя причина, почему Bot API не дал фото — для диагностики, без секретов
export let lastBotApiNote = "";

async function fromBotApi(tgId: number): Promise<{ src: string; download: string } | null> {
  if (!TOKEN) { lastBotApiNote = "нет токена бота"; return null; }
  const api = `https://api.telegram.org/bot${TOKEN}`;
  try {
    const r = await (await fetch(`${api}/getUserProfilePhotos?user_id=${tgId}&limit=1`)).json();
    if (!r.ok) { lastBotApiNote = `Telegram: ${r.error_code} ${r.description}`; return null; }
    const sizes = r.result.total_count ? r.result.photos[0] : null;
    if (!sizes?.length) { lastBotApiNote = "фото нет или скрыто приватностью"; return null; }
    lastBotApiNote = "ok";
    const pick = sizes.find((s: { width: number }) => s.width >= 320) ?? sizes[sizes.length - 1];
    const f = await (await fetch(`${api}/getFile?file_id=${pick.file_id}`)).json();
    if (!f.ok) return null;
    return { src: pick.file_unique_id, download: `https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}` };
  } catch {
    return null;
  }
}

// deno-lint-ignore no-explicit-any
export async function syncAvatar(sb: any, acc: Account, photoUrl?: string | null): Promise<Stored | null> {
  let source = await fromBotApi(acc.tg_id);
  if (!source && photoUrl && TG_PHOTO.test(photoUrl)) source = { src: photoUrl, download: photoUrl };
  if (!source || source.src === acc.tg_photo_src) return null;

  const r = await fetch(source.download, { redirect: "follow" });
  if (!r.ok) { lastBotApiNote = `скачивание: ${r.status}`; return null; }
  const bytes = new Uint8Array(await r.arrayBuffer());
  // Telegram отдаёт файлы как application/octet-stream — тип определяем по сигнатуре
  const type = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg"
    : bytes[0] === 0x89 && bytes[1] === 0x50 ? "image/png"
    : bytes[8] === 0x57 && bytes[9] === 0x45 ? "image/webp" : null;
  if (!type || bytes.length > 1_000_000) { lastBotApiNote = "это не картинка или файл больше 1 МБ"; return null; }

  const path = `tg/${acc.tg_id}.jpg`;
  const { error } = await sb.storage.from("avatars").upload(path, bytes, { contentType: type, upsert: true, cacheControl: "604800" });
  if (error) { lastBotApiNote = `хранилище: ${error.message}`; return null; }
  // версия в ссылке — чтобы браузеры и CDN сразу увидели новое фото
  return { url: `${PUBLIC_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`, src: source.src };
}
