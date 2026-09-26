// Страна и регион бани по точке — в тех же написаниях, что у Комиссии в таблице («Кировская обл», «Татарстан»).
// Бонусы за новый регион и страну (п. 14) сравнивают названия, поэтому «Кировская область» из OpenStreetMap
// приводим к написанию, которое у лиги уже встречалось; не встречалось — сокращаем по-таблично.
import { regionKey } from "./scoring.js";

export type Place = { country: string | null; region: string | null };
type Known = { country: string | null; region: string | null; n?: number };

export async function reversePlace(lat: number, lng: number): Promise<Place> {
  const url = "https://nominatim.openstreetmap.org/reverse?" +
    new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "5", "accept-language": "ru" });
  try {
    const a = (await (await fetch(url, { headers: { "User-Agent": "EBL-bot/1.0 (https://ebl.su)" } })).json())?.address ?? {};
    return { country: a.country ?? null, region: a.state ?? a.region ?? a.city ?? null };
  } catch {
    return { country: null, region: null };
  }
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
