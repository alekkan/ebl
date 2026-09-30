// Страна и регион бани по точке — в тех же написаниях, что у Комиссии в таблице («Кировская обл», «Татарстан»).
// Бонусы за новый регион и страну (п. 14) сравнивают названия, поэтому «Кировская область» из OpenStreetMap
// приводим к написанию, которое у лиги уже встречалось; не встречалось — сокращаем по-таблично.
import { regionKey } from "./scoring.js";
import { NOMINATIM } from "./hosts.ts";

export type Place = { country: string | null; region: string | null };
type Known = { country: string | null; region: string | null; n?: number };

// Геокодер OpenStreetMap с облачных адресов Supabase иногда отказывает (429/403 или страница вместо JSON) — спрашиваем
// ещё раз через пару секунд; не ответил и тогда — пусто: повторы по расписанию (fillPlaces), Комиссии висит пометка
export async function reversePlace(lat: number, lng: number, tries = 3): Promise<Place> {
  const url = `${NOMINATIM}/reverse?` +
    new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "5", "accept-language": "ru" });
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "EBL-bot/1.0 (https://ebl.su)" } });
      const a = r.ok ? (await r.json())?.address : null;
      if (a?.country) return { country: a.country ?? null, region: a.state ?? a.region ?? a.city ?? null };
    } catch { /* сеть или не JSON — ещё раз */ }
    if (i + 1 < tries) await new Promise((res) => setTimeout(res, 2000));
  }
  return { country: null, region: null };
}

// deno-lint-ignore no-explicit-any
type Sb = any;
// Страна и регион бани по точке — только по координатам, через геокодер (по соседним баням не угадываем — решение
// Лехи, 30.09); название приводим к написанию Комиссии (matchPlace). Заполненное (have) не трогаем — только недостающее.
export async function placeByPoint(sb: Sb, p: { lat: number; lng: number }, have: Partial<Place> = {}): Promise<Partial<Place>> {
  const { data: known } = await sb.from("bath_places").select("country, region, n").limit(5000);
  const pl = matchPlace(await reversePlace(p.lat, p.lng), known ?? []);
  return { ...(!have?.country && pl.country ? { country: pl.country } : {}), ...(!have?.region && pl.region ? { region: pl.region } : {}) };
}

const stem = (s: string | null) => regionKey(s).split(/[\s-]/)[0].slice(0, 7);
const tableStyle = (r: string) => r.replace(/\s+область$/i, " обл").replace(/^Республика\s+/i, "").trim();

// known — пары страна/регион из справочника, самые частые первыми (представление bath_places)
export function matchPlace(p: Place, known: Known[]): Place {
  const country = known.find((k) => k.country && regionKey(k.country) === regionKey(p.country))?.country ?? p.country;
  if (!p.region) return { country, region: null };
  const same = known.filter((k) => k.country === country && k.region);
  const hit = same.find((k) => regionKey(k.region) === regionKey(p.region)) ?? same.find((k) => stem(k.region) === stem(p.region));
  return { country, region: hit?.region ?? tableStyle(p.region) };
}
