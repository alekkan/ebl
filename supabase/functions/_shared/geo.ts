// Координаты бани из того, что прислал участник: координаты текстом, ссылка на Яндекс Карты, Google Maps, 2ГИС или OSM.
// Короткие ссылки (maps.app.goo.gl, yandex.ru/maps/-/…, go.2gis.com) раскрываем по редиректам.
// Ссылка Google на место без координат (короткая maps.app.goo.gl раскрывается в /maps/place/<название, адрес>/…) —
// ищем адрес из самой ссылки. Геокодер OpenStreetMap edge-функциям не отвечает — тогда спрашиваем через сервер базы
// (useDbGeocoder: pg_net, geo_search/geo_result).
import { NOMINATIM } from "./hosts.ts";

// deno-lint-ignore no-explicit-any
let db: any = null;
// deno-lint-ignore no-explicit-any
export function useDbGeocoder(sb: any) { db = sb; }

export type Point = { lat: number; lng: number };

const valid = (lat: number, lng: number): Point | null =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0) ? { lat, lng } : null;

function fromUrl(raw: string): Point | null {
  const u = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
  let m: RegExpMatchArray | null;
  // Google: !3d<lat>!4d<lng> точнее, чем центр карты @lat,lng
  if ((m = u.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/))) return valid(+m[1], +m[2]);
  if (/google\.|goo\.gl/.test(u)) {
    if ((m = u.match(/[?&](?:q|query|ll|center|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/))) return valid(+m[1], +m[2]);
    if ((m = u.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/))) return valid(+m[1], +m[2]);
  }
  // Яндекс: pt/ll/whatshere[point] = долгота,широта
  if (/yandex\.|ya\.ru/.test(u)) {
    if ((m = u.match(/(?:[?&]pt=|whatshere\[point\]=)(-?\d+\.\d+),(-?\d+\.\d+)/))) return valid(+m[2], +m[1]);
    if ((m = u.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/))) return valid(+m[2], +m[1]);
  }
  // 2ГИС: m=долгота,широта или /geo/долгота,широта
  if (/2gis\./.test(u)) {
    if ((m = u.match(/[?&]m=(-?\d+\.\d+),(-?\d+\.\d+)/) ?? u.match(/\/geo\/(?:\d+\/)?(-?\d+\.\d+),(-?\d+\.\d+)/))) return valid(+m[2], +m[1]);
  }
  // OpenStreetMap
  if ((m = u.match(/mlat=(-?\d+\.\d+).*?mlon=(-?\d+\.\d+)/))) return valid(+m[1], +m[2]);
  if ((m = u.match(/map=\d+\/(-?\d+\.\d+)\/(-?\d+\.\d+)/))) return valid(+m[1], +m[2]);
  return null;
}

// короткие ссылки раскрываем по редиректам и берём координаты только из итогового адреса:
// разметка страницы организации ненадёжна (в ней бывают чужие координаты — например, региона посетителя)
async function fromRedirect(url: string): Promise<Point | null> {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; EBL-bot)" } });
    await r.body?.cancel();
    return r.url && r.url !== url ? fromUrl(r.url) : null;
  } catch {
    return null;
  }
}

export async function parseLocation(input: string): Promise<Point | null> {
  const s = (input ?? "").trim();
  const url = s.match(/https?:\/\/[^\s<>"]+/)?.[0];
  // уже итоговая ссылка Google на место (/maps/place/…) — редиректов нет, координат в ней нет: адрес ищет locate
  if (url) return fromUrl(url) ?? (/\/maps\/place\//.test(url) ? null : await fromRedirect(url));
  const m = s.match(/(-?\d{1,2}[.,]\d{3,})\s*[,;\s]\s*(-?\d{1,3}[.,]\d{3,})/);
  return m ? valid(parseFloat(m[1].replace(",", ".")), parseFloat(m[2].replace(",", "."))) : null;
}

export const hasLocationHint = (s: string) => /https?:\/\/\S*(yandex|ya\.ru|google|goo\.gl|2gis|openstreetmap)/i.test(s ?? "")
  || /(-?\d{1,2}\.\d{4,})\s*,\s*(-?\d{1,3}\.\d{4,})/.test(s ?? "");

// ---------- адреса: «Неглинная ул., 14, стр. 5, Москва» → координаты (OpenStreetMap Nominatim) ----------
const km = (a: Point, b: Point) => {
  const r = Math.PI / 180, h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
const STREET = /(ул\.?|улица|пр-т|проспект|просп\.|пер\.?|переулок|ш\.|шоссе|наб\.?|набережная|бульвар|б-р|пл\.?|площадь|проезд|тупик|аллея|мкр|микрорайон|street|st\.|avenue|ave|road|straße|strasse|str\.)/i;
export const looksLikeAddress = (s: string) => (s ?? "").split(/\n/).some((l) => STREET.test(l) && /\d/.test(l));

// город, область, страна целиком — не точка бани: «St. George, Банско» не должен стать центром Банско
const ADMIN = new Set(["city", "town", "village", "hamlet", "suburb", "municipality", "county", "state", "region", "province",
  "country", "district", "city_district", "borough", "quarter", "neighbourhood", "postcode", "continent"]);

// ответ геокодера: напрямую, а не ответил (edge-функциям Supabase он отказывает) — через сервер базы
// deno-lint-ignore no-explicit-any
async function nominatimSearch(q: string): Promise<any[] | null> {
  try {
    const url = `${NOMINATIM}/search?` + new URLSearchParams({ q, format: "jsonv2", limit: "3", "accept-language": "ru" });
    const r = await fetch(url, { headers: { "User-Agent": "EBL-bot/1.0 (https://ebl.su)" } });
    if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) return j; }
  } catch { /* через базу */ }
  if (!db) return null;
  const { data: id } = await db.rpc("geo_search", { p_q: q });
  if (id == null) return null;
  for (let i = 0; i < 16; i++) {
    await new Promise((res) => setTimeout(res, 500));
    const { data } = await db.rpc("geo_result", { p_id: id });
    const r = data?.[0];
    if (!r) continue;
    try { return r.status === 200 ? JSON.parse(r.content) : null; } catch { return null; }
  }
  return null;
}

/** near/maxKm — защита от промахов: найденное дальше maxKm от примерной точки бани не принимаем;
 *  specific — только конкретное место (здание, заведение, улица), не город и не регион целиком */
export async function geocodeAddress(q: string, near?: Point | null, maxKm = 300, specific = false): Promise<Point | null> {
  const clean = q.replace(/\s+/g, " ").trim();
  const variants = [...new Set([clean,
    clean.replace(/,?\s*(строение|стр\.?|корпус|корп\.?|к\.|с\.)\s*\d+\S*/gi, ""),
    clean.replace(/,?\s*(строение|стр\.?|корпус|корп\.?|к\.|с\.)\s*\d+\S*/gi, "").replace(/\b(ул\.?|улица)\s*/gi, "")])].filter((v) => v.length > 4);
  for (const v of variants) {
    for (const hit of (await nominatimSearch(v)) ?? []) {
      if (specific && (ADMIN.has(hit.addresstype) || hit.category === "boundary" || hit.class === "boundary")) continue;
      const p = valid(+hit.lat, +hit.lon);
      if (p && (!near || km(p, near) <= maxKm)) return p;
    }
  }
  return null;
}

// Адрес из ссылки Google по-английски («12 Asanitsa Str, 2770 Bansko, Bulgaria») OpenStreetMap часто не находит (07.10),
// а улицу без номера и «Str» с городом — находит («Asanitsa, Bansko, Bulgaria»). Варианты — от точного к общему.
function placeVariants(place: string): string[] {
  const parts = place.split(",").map((s) => s.trim()).filter(Boolean);
  const [name, ...rest] = parts;
  const clean = (s: string) => s.replace(/\b\d{3,6}\b/g, " ").replace(/^\s*\d+[a-zа-я]?\s+/i, " ")
    .replace(/\b(str|st|ul|ulitsa|street|road|rd|ave|avenue|blvd|bul|ул|улица)\.?(?![\p{L}])/giu, " ").replace(/\s+/g, " ").trim();
  const cleaned = rest.map(clean).filter(Boolean);
  const city = cleaned.length >= 2 ? cleaned[cleaned.length - 2] : cleaned[0] ?? "";
  return [...new Set([place, rest.join(", "), cleaned.join(", "), cleaned.slice(0, -1).join(", "), city && name ? `${name}, ${city}` : ""])]
    .filter((q) => q.length >= 5);
}

// Google: итоговая ссылка на место — /maps/place/<Название, адрес, город, страна>/…; координат в ней может не быть
async function googlePlace(url: string): Promise<string | null> {
  let u = url;
  if (!/\/maps\/place\//.test(u)) {
    if (!/goo\.gl|google\./.test(u)) return null;
    try {
      const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; EBL-bot)" } });
      await r.body?.cancel();
      u = r.url || u;
    } catch { return null; }
  }
  const m = (() => { try { return decodeURIComponent(u); } catch { return u; } })().match(/\/maps\/place\/([^/?]+)/);
  return m ? m[1].replace(/\+/g, " ").trim() : null;
}

// заголовок страницы карточки организации: «Сандуновские бани, баня, Неглинная ул., 14, стр. 5, Москва — Яндекс Карты»
async function pageTitle(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "TelegramBot (like TwitterBot)", "Accept-Language": "ru" } });
    const html = (await r.text()).slice(0, 200_000);
    const t = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<title>([^<]+)<\/title>/i)?.[1];
    return t ? t.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s[—–-]\s(Яндекс ?Карты|Yandex ?Maps|Google ?Maps|2ГИС|2GIS).*$/i, "").trim() : null;
  } catch {
    return null;
  }
}

/** Всё, чем участник может показать, где баня: координаты, ссылка с точкой, адрес в тексте, ссылка на карточку организации. */
export async function locate(text: string, near?: Point | null, maxKm = 300): Promise<Point | null> {
  const direct = await parseLocation(text);
  if (direct) return direct;
  // ссылка Google на место без координат: «St George Ski and Holiday Hotel, 12 Asanitsa Str, 2770 Bansko, Bulgaria» —
  // ищем целиком, потом без названия (адрес), потом без индекса (07.10 бот не принял такую ссылку Шурика)
  const gurl = (text ?? "").match(/https?:\/\/[^\s<>"]+/)?.[0];
  const place = gurl ? await googlePlace(gurl) : null;
  if (place) {
    for (const q of placeVariants(place)) {
      const p = await geocodeAddress(q, near, maxKm, true);
      if (p) return p;
    }
  }
  const lines = (text ?? "").replace(/https?:\/\/\S+/g, "\n").split("\n").map((s) => s.trim()).filter(Boolean);
  for (const line of lines.filter((l) => STREET.test(l) && /\d/.test(l))) {
    const p = await geocodeAddress(line, near, maxKm);
    if (p) return p;
  }
  const url = (text ?? "").match(/https?:\/\/[^\s<>"]+/)?.[0];
  if (url) {
    const title = await pageTitle(url);
    if (title) {
      const parts = title.split(",").map((s) => s.trim());
      // «Название, категория, улица, дом, …, город» — адрес начинается с первой части с цифрой или улицей
      const i = parts.findIndex((p, k) => k > 0 && (STREET.test(p) || /\d/.test(p)));
      for (const q of [i > 0 ? parts.slice(Math.max(1, i - 1)).join(", ") : null, i > 0 ? parts.slice(i).join(", ") : null, title]) {
        if (!q) continue;
        const p = await geocodeAddress(q, near, maxKm);
        if (p) return p;
      }
    }
  }
  if (lines.length > 1) return await geocodeAddress(lines.join(", "), near, maxKm);
  // одна строка «название, город, страна» («St. George, Банско, Болгария»): минимум три части — иначе «огонь, баня» в ответе
  // на карточку мог бы найти чужое заведение; и только конкретное место, не город целиком
  if (lines.length === 1 && lines[0].split(",").filter((x) => x.trim()).length >= 3 && lines[0].length <= 160) {
    return await geocodeAddress(lines[0], near, maxKm, true);
  }
  return null;
}
