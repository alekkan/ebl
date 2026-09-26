// Координаты бани из того, что прислал участник: координаты текстом, ссылка на Яндекс Карты, Google Maps, 2ГИС или OSM.
// Короткие ссылки (maps.app.goo.gl, yandex.ru/maps/-/…, go.2gis.com) раскрываем по редиректам.
// Ссылка на карточку организации без координат в адресе не подходит — тогда просим геопозицию.
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
  if (url) return fromUrl(url) ?? (await fromRedirect(url));
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

/** near/maxKm — защита от промахов: найденное дальше maxKm от примерной точки бани не принимаем */
export async function geocodeAddress(q: string, near?: Point | null, maxKm = 300): Promise<Point | null> {
  const clean = q.replace(/\s+/g, " ").trim();
  const variants = [...new Set([clean,
    clean.replace(/,?\s*(строение|стр\.?|корпус|корп\.?|к\.|с\.)\s*\d+\S*/gi, ""),
    clean.replace(/,?\s*(строение|стр\.?|корпус|корп\.?|к\.|с\.)\s*\d+\S*/gi, "").replace(/\b(ул\.?|улица)\s*/gi, "")])].filter((v) => v.length > 4);
  for (const v of variants) {
    try {
      const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({ q: v, format: "jsonv2", limit: "3", "accept-language": "ru" });
      const res = await (await fetch(url, { headers: { "User-Agent": "EBL-bot/1.0 (https://ebl.su)" } })).json();
      for (const hit of res ?? []) {
        const p = valid(+hit.lat, +hit.lon);
        if (p && (!near || km(p, near) <= maxKm)) return p;
      }
    } catch { /* следующий вариант */ }
  }
  return null;
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
  return null;
}
