#!/usr/bin/env python3
"""Страна и регион по точной точке — разовая сверка уже стоящих бань (21.10, решение Лехи: Москва по точке — «Москва»,
область — «Московская обл»). Новые точки определяет сам сервер (`placePatch`); старые до этого жили с регионом из таблицы.

  supabase db query --linked -o json "select id, name, lat, lng, country, region from baths
    where status <> 'rejected' and precision = 'exact' and lat is not null order by id" > /tmp/exact.json
  supabase db query --linked -o json "select country, region, n from bath_places" > /tmp/places.json
  python3 scripts/places_by_point.py /tmp/exact.json /tmp/places.json scripts/catalog/runs/places-2026-10-21

Спрашивает геокодер OpenStreetMap раз в 1,1 с (его правило), ответы кладёт в cache.json — повторный запуск не спрашивает
заново. Пишет diff.md (что поменяется — показать владельцу) и apply.sql (на бой — только с его согласия, потом recompute).
Написание — как у лиги (то же, что `matchPlace` в `_shared/place.ts`).
"""
import json, pathlib, re, sys, time, urllib.parse, urllib.request


def rows(path):
    d = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    return d["rows"] if isinstance(d, dict) else d


def region_key(s):
    s = " " + (s or "").lower().replace("ё", "е")
    s = re.sub(r'[.,«»"()]', " ", s) + " "
    s = s.replace(" область ", " обл ")
    s = re.sub(r" (республика|респ|город|г) ", " ", s)
    s = s.replace(" автономный округ ", " ао ")
    return re.sub(r"\s+", " ", s).strip()


def stem(s):
    return re.split(r"[\s-]", region_key(s))[0][:7]


COUNTRY_ALIAS = {"объединенные арабские эмираты": "ОАЭ", "соединенные штаты америки": "США",
                 "соединенное королевство": "Великобритания", "республика корея": "Корея"}   # как в _shared/place.ts
REGION_ALIAS = {"алтай": "Горный Алтай"}


def match_place(country, region, known):
    country = COUNTRY_ALIAS.get(region_key(country), country)
    c = next((k["country"] for k in known if k["country"] and region_key(k["country"]) == region_key(country)), country)
    if not region:
        return c, None
    if c == "Россия":
        region = REGION_ALIAS.get(region_key(region), region)
    same = [k for k in known if k["country"] == c and k["region"]]
    hit = next((k["region"] for k in same if region_key(k["region"]) == region_key(region)), None) \
        or next((k["region"] for k in same if stem(k["region"]) == stem(region)), None)
    return c, hit or re.sub(r"^Республика\s+", "", re.sub(r"\s+область$", " обл", region, flags=re.I), flags=re.I).strip()


def reverse(lat, lng):
    q = urllib.parse.urlencode({"lat": lat, "lon": lng, "format": "jsonv2", "zoom": 5, "accept-language": "ru"})
    req = urllib.request.Request(f"https://nominatim.openstreetmap.org/reverse?{q}", headers={"User-Agent": "EBL-bot/1.0 (https://ebl.su)"})
    a = json.load(urllib.request.urlopen(req, timeout=20)).get("address") or {}
    return a.get("country"), a.get("province") or a.get("state") or a.get("region") or a.get("city")


def lit(v):
    return "null" if v is None else "'" + str(v).replace("'", "''") + "'"


def main():
    baths, known, out = rows(sys.argv[1]), rows(sys.argv[2]), pathlib.Path(sys.argv[3])
    known.sort(key=lambda k: -(k.get("n") or 0))
    out.mkdir(parents=True, exist_ok=True)
    cache_f = out / "cache.json"
    cache = json.loads(cache_f.read_text()) if cache_f.exists() else {}
    for i, b in enumerate(baths):
        key = f"{b['lat']:.6f},{b['lng']:.6f}"
        if key in cache:
            continue
        try:
            cache[key] = reverse(b["lat"], b["lng"])
        except Exception as e:   # 429 и прочее — не обходим: пропуск, следующий запуск спросит снова
            print(f"{b['id']}: {e}", file=sys.stderr)
        if i % 20 == 0:
            cache_f.write_text(json.dumps(cache, ensure_ascii=False))
            print(f"{i}/{len(baths)}", file=sys.stderr)
        time.sleep(1.1)
    cache_f.write_text(json.dumps(cache, ensure_ascii=False))

    diff, sql, missing = [], ["begin;"], 0
    for b in baths:
        raw = cache.get(f"{b['lat']:.6f},{b['lng']:.6f}")
        if not raw or not raw[0]:
            missing += 1
            continue
        c, r = match_place(raw[0], raw[1], known)
        if r is None and c == b["country"]:
            r = b["region"]
        if (c, r) != (b["country"], b["region"]):
            diff.append((b, c, r))
            sql.append(f"update public.baths set country = {lit(c)}, region = {lit(r)}, place_lat = lat, place_lng = lng "
                       f"where id = {b['id']} and country is not distinct from {lit(b['country'])} and region is not distinct from {lit(b['region'])};")
    sql.append("commit;")
    diff.sort(key=lambda x: (x[0]["country"] or "", x[0]["region"] or "", x[0]["name"]))
    md = [f"# Регион по точке: {len(diff)} из {len(baths)} бань с точной точкой поменяются (геокодер не ответил — {missing})", "",
          "| id | баня | сейчас | по точке |", "|---|---|---|---|"]
    md += [f"| {b['id']} | {b['name']} | {', '.join(x for x in (b['region'], b['country']) if x) or '—'} | {', '.join(x for x in (r, c) if x)} |" for b, c, r in diff]
    (out / "diff.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    (out / "apply.sql").write_text("\n".join(sql) + "\n", encoding="utf-8")
    print(f"поменяются {len(diff)} из {len(baths)}, геокодер не ответил — {missing}: {out / 'diff.md'}")


if __name__ == "__main__":
    main()
