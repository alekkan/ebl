// Координаты бани из того, что прислал участник: координаты текстом, ссылка на Яндекс Карты, Google Maps, 2ГИС или OSM.
// Короткие ссылки (maps.app.goo.gl, yandex.ru/maps/-/…, go.2gis.com) раскрываем по редиректам.
// Ссылка Google на место без координат (короткая maps.app.goo.gl раскрывается в /maps/place/<название, адрес>/…) —
// ищем адрес из самой ссылки. Геокодер OpenStreetMap edge-функциям не отвечает — тогда спрашиваем через сервер базы
// (useDbGeocoder: pg_net, geo_search/geo_result).
import { NOMINATIM, PHOTON, YANDEX_GEOCODER } from "./hosts.ts";

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
export const distKm = km;
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

// Геокодер Яндекса (30.10, ключ Лехи — секрет YANDEX_GEOCODER_KEY, 1000 запросов в день): адреса по-русски находит там, где
// OpenStreetMap — нет («Ризе, Пиричелеби, улица 2 Парк, 1», «село Архыз, Банковская 53»). Нет ключа — пропускаем.
// Ответ — в виде Nominatim (lat, lon, addresstype, display_name)
async function yandexSearch(q: string): Promise<any[] | null> {
  const key = Deno.env.get("YANDEX_GEOCODER_KEY");
  if (!key) return null;
  try {
    const r = await fetch(`${YANDEX_GEOCODER}/1.x/?` + new URLSearchParams({ apikey: key, geocode: q, format: "json", lang: "ru_RU", results: "3" }));
    if (!r.ok) return null;
    const j = await r.json();
    // только дом или улица: нашёлся лишь город или район — это не точка бани
    return (j?.response?.GeoObjectCollection?.featureMember ?? [])
      .filter((m: any) => ["house", "street", "entrance"].includes(m.GeoObject?.metaDataProperty?.GeocoderMetaData?.kind)).map((m: any) => {
      const o = m.GeoObject ?? {}, meta = o.metaDataProperty?.GeocoderMetaData ?? {};
      const [lon, lat] = String(o.Point?.pos ?? "").split(" ");
      return { lat, lon, addresstype: meta.kind, category: meta.kind, display_name: meta.text ?? "" };
    });
  } catch { return null; }
}

// Photon (тот же OpenStreetMap, поиск помягче) — когда Nominatim не нашёл: 30.10 «2 Nolu Park Sokak, Rize» Nominatim не знал,
// Photon нашёл. Ответ — в виде Nominatim (lat, lon, addresstype, display_name), чтобы сверять одинаково
async function photonSearch(q: string): Promise<any[] | null> {
  let j: any = null;
  try {
    const r = await fetch(`${PHOTON}/api?` + new URLSearchParams({ q, limit: "3" }), { headers: { "User-Agent": "EBL-bot/1.0 (https://ebl.su)" } });
    if (r.ok) j = await r.json();
  } catch { /* через базу */ }
  if (!j?.features && db) {
    const { data: id } = await db.rpc("geo_photon", { p_q: q });
    for (let i = 0; id != null && i < 16 && !j?.features; i++) {
      await new Promise((res) => setTimeout(res, 500));
      const r = (await db.rpc("geo_result", { p_id: id })).data?.[0];
      if (r) { try { j = r.status === 200 ? JSON.parse(r.content) : {}; } catch { j = {}; } }
    }
  }
  return (j?.features ?? []).map((f: any) => {
    const p = f.properties ?? {}, [lon, lat] = f.geometry?.coordinates ?? [];
    return { lat: String(lat), lon: String(lon), addresstype: p.type, category: p.osm_key, class: p.osm_key,
      display_name: [p.name, [p.street, p.housenumber].filter(Boolean).join(" "), p.district, p.city, p.state, p.country].filter(Boolean).join(", ") };
  });
}

// латиница и кириллица к одному виду: «Bansko» = «Банско», «Asanitsa» = «Асаница» — чтобы сверить находку с адресом Google
const LAT: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht",
  ъ: "a", ы: "y", ь: "", э: "e", ю: "yu", я: "ya" };
const flat = (s: string) => (s ?? "").toLowerCase().replace(/[а-яё]/g, (c) => LAT[c] ?? c).replace(/kh/g, "h").replace(/[^a-z0-9]/g, "");

/** near/maxKm — защита от промахов: найденное дальше maxKm от примерной точки бани не принимаем;
 *  specific — только конкретное место (здание, заведение, улица), не город и не регион целиком;
 *  must — слова, которые должны быть в найденном адресе (город, улица из ссылки Google): то же место, а не тёзка */
export async function geocodeAddress(q: string, near?: Point | null, maxKm = 300, specific = false, must: string[] = []): Promise<Point | null> {
  const clean = q.replace(/\s+/g, " ").trim();
  const noBuilding = clean.replace(/,?\s*(строение|стр\.?|корпус|корп\.?|к\.|с\.)\s*\d+\S*/gi, "");
  // «село Архыз», «пос. Мозжинка»: с типом населённого пункта OpenStreetMap адрес не находит, без него — находит (30.10)
  const noKind = noBuilding.replace(/(^|[\s,])(село|с\.|посёлок|поселок|пос\.|п\.|пгт|деревня|дер\.|станица|ст-ца|хутор|аул|город|г\.)\s*(?=\p{Lu})/gu, "$1");
  const variants = [...new Set([clean, noBuilding, noBuilding.replace(/\b(ул\.?|улица)\s*/gi, ""), noKind])].filter((v) => v.length > 4);
  for (const search of [yandexSearch, nominatimSearch, photonSearch]) {
    for (const v of variants) {
      for (const hit of (await search(v)) ?? []) {
        if (specific && (ADMIN.has(hit.addresstype) || hit.category === "boundary" || hit.class === "boundary")) continue;
        if (must.length && !must.every((w) => flat(hit.display_name ?? "").includes(flat(w)))) continue;
        const p = valid(+hit.lat, +hit.lon);
        if (p && (!near || km(p, near) <= maxKm)) return p;
      }
    }
  }
  return null;
}

// Адрес из ссылки Google по-английски («12 Asanitsa Str, 2770 Bansko, Bulgaria») OpenStreetMap часто не находит (07.10),
// а улицу без номера и «Str» с городом — находит («Asanitsa, Bansko, Bulgaria»). Варианты — от точного к общему.
// Улица — по слову «улица» на любом языке; 30.10 в турецком адресе первой частью шло название дома («Yinsa Apartmanı»),
// и его принимали за улицу. «NO:1/1» — номер дома по-турецки
const STREET_WORD = /(^|[\s.])(str|st|ul|ulitsa|street|road|rd|ave|avenue|blvd|bul|ул|улица|sokak|sokağı|sok|cadde|caddesi|cad|cd|bulvarı|calle|via|rua|straße|strasse)\.?(?![\p{L}])/iu;
const ADMIN_WORD = /(province|region|state|oblast|област|край|county|prefecture|governorate|district)/i;
function placeVariants(place: string): { variants: string[]; must: string[] } {
  const parts = place.split(",").map((s) => s.trim()).filter(Boolean);
  const [name, ...rest] = parts;
  const clean = (s: string) => s.replace(/\b\d{3,6}\b/g, " ").replace(/^\s*\d+[a-zа-я]?\s+/i, " ")
    .replace(/\b(str|st|ul|ulitsa|street|road|rd|ave|avenue|blvd|bul|ул|улица)\.?(?![\p{L}])/giu, " ").replace(/\s+/g, " ").trim();
  const cleaned = rest.map(clean).filter(Boolean);
  // город — последняя часть перед страной, но не провинция или область («Kathmandu, Bagmati Province 44600, Непал», 30.10);
  // «Rize Merkez/Rize» (район/провинция) — последнее
  const body = cleaned.length >= 2 ? cleaned.slice(0, -1) : cleaned;
  let ci = body.length - 1;
  while (ci > 0 && ADMIN_WORD.test(body[ci])) ci--;
  const city = (body[ci] ?? "").split("/").pop()!.trim();
  const area = ci > 0 ? body[ci - 1] : "";   // район или улица перед городом: «Chaksibari, Kathmandu» находится, когда весь адрес — нет
  // сверка: в найденном должны быть город и улица из ссылки Google (если они там есть). Улица — только по слову «улица»:
  // первой частью часто идёт здание («Yinsa Apartmanı», «Sherbhawan Building»)
  const streetRaw = rest.find((p) => STREET_WORD.test(p))?.replace(/\s*\b(no|nr|№)\s*[:.]?\s*[\d/]+.*$/i, "").trim() ?? "";
  const street = streetRaw ? clean(streetRaw) : "";
  const must = [city, street].filter((w) => w && flat(w).length >= 3);
  return {
    variants: [...new Set([place, rest.join(", "), cleaned.join(", "), cleaned.slice(0, -1).join(", "), city && name ? `${name}, ${city}` : "",
      streetRaw && city ? `${streetRaw}, ${city}` : "", area && city ? `${area}, ${city}` : ""])].filter((q) => q.length >= 5),
    must,
  };
}

// Google: итоговая ссылка на место — /maps/place/<Название, адрес, город, страна>/…; координат в ней может не быть.
// Делятся и иначе (30.10, ссылка Хвоста не нашлась): /maps/search/<запрос>, ?q=<название, адрес>, страница согласия с
// исходной ссылкой в continue, а бывает, что адрес — только внутри страницы (/maps/preview/place?…&q=<адрес>)
const GPLACE = /\/maps\/(?:place|search)\/([^/?#]+)/;
function googleText(raw: string): string | null {
  const t = raw.replace(/\+/g, " ");
  try { return decodeURIComponent(t).trim() || null; } catch { return t.trim() || null; }
}
function googleFromUrl(u: string): string | null {
  // раскодируем только само место: «NO:1%2F1» (номер дома по-турецки) иначе резал адрес на «/» (30.10)
  const m = u.match(GPLACE);
  if (m) return googleText(m[1]);
  try {
    const p = new URL(u).searchParams;
    const cont = p.get("continue");
    if (cont && cont !== u) return googleFromUrl(cont);
    const q = p.get("q") ?? p.get("query");
    if (q) return q.trim() || null;
  } catch { /* не ссылка */ }
  return null;
}
async function googlePlace(url: string): Promise<string | null> {
  if (!/goo\.gl|google\./.test(url)) return null;
  const direct = googleFromUrl(url);
  if (direct) return direct;
  try {
    const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; EBL-bot)" } });
    const fromUrl = googleFromUrl(r.url || url);
    if (fromUrl) { await r.body?.cancel(); return fromUrl; }
    const html = (await r.text()).slice(0, 500_000);
    const m = html.match(/\/maps\/preview\/place\?[^"']*?[?&;]q=([^"'&]+)/);
    return m ? googleText(m[1]) : null;
  } catch { return null; }
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
    const pc = await parseLocation(place);   // «?q=41.02,40.51» — координаты прямо в ссылке
    if (pc) return pc;
    const { variants, must } = placeVariants(place);
    for (const q of variants) {
      const p = await geocodeAddress(q, near, maxKm, true, must);
      if (p) return p;
    }
    return null;   // ссылка Google на место, но OpenStreetMap того же места не нашёл — не угадываем, просим геопозицию
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
