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
