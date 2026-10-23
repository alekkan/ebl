#!/usr/bin/env python3
"""Радар, шаг 1в: прочёс 2ГИС через Places API (23.10, демо-ключ Лехи: 1000 запросов в месяц, 600 в минуту).
Агенты через веб-поиск видят только то, что поисковик проиндексировал (Назарьевские бани не нашлись); API отдаёт всё по
запросу «общественная баня» в круге до 50 км (демо-ключ — по 10 за запрос). Москву и область покрываем сеткой кругов по 40 км.

  python3 scripts/radar/sweep_2gis.py $R [--max-requests 300] [--only 55.67,37.04]   # → $R/sweep/out_2gis.json
  python3 scripts/radar/sweep.py merge $R                                             # дальше как с агентами

Ключ — строка DGIS_KEY=… в ~/.config/ebl/keys (или переменная окружения DGIS_KEY): не в git, не в чат, не в логи.
Условия 2ГИС ограничивают хранение данных справочника — что из ответа идёт на бой, решает владелец (docs/radar.md).
"""
import argparse, json, os, pathlib, re, sys, time, urllib.parse, urllib.request

API = "https://catalog.api.2gis.com/3.0/items"
FIELDS = "items.point,items.address_name,items.full_address_name,items.rubrics,items.adm_div"
PAGE, PAGES = 10, 5   # демо-ключ: 10 организаций на запрос и 5 страниц — 50 мест на круг (23.10); платный — больше
BATH = re.compile(r"(бан[яиьн]|банно|парн|терм|хамам|hammam)", re.I)
# сетка центров: Москва и область, круги по 40 км с перекрытием (рамка 54.2–57.0 с. ш., 35.1–40.3 в. д.)
GRID = [(round(lat, 2), round(lng, 2)) for lat in (54.45, 54.9, 55.35, 55.8, 56.25, 56.7) for lng in (35.6, 36.3, 37.0, 37.7, 38.4, 39.1, 39.8)]
# крупные города, где лига ходит чаще всего (24.10): центр и радиус круга, регион радара
CITIES = {
    "Санкт-Петербург": (59.94, 30.31, 30000, "Санкт-Петербург"), "Саратов": (51.53, 46.03, 20000, "Саратовская область"),
    "Краснодар": (45.04, 38.98, 20000, "Краснодарский край"), "Сочи": (43.59, 39.73, 30000, "Краснодарский край"),
    "Калуга": (54.51, 36.26, 15000, "Калужская область"), "Тверь": (56.86, 35.9, 15000, "Тверская область"),
    "Калининград": (54.71, 20.51, 25000, "Калининградская область"), "Новосибирск": (55.03, 82.92, 25000, "Новосибирская область"),
    "Екатеринбург": (56.84, 60.6, 25000, "Свердловская область"), "Иркутск": (52.29, 104.28, 20000, "Иркутская область"),
    "Самара": (53.2, 50.15, 25000, "Самарская область"), "Тула": (54.19, 37.62, 15000, "Тульская область"),
    "Мурманск": (68.97, 33.07, 15000, "Мурманская область"), "Киров": (58.6, 49.66, 15000, "Кировская область"),
    "Ярославль": (57.63, 39.87, 15000, "Ярославская область"), "Нижний Новгород": (56.3, 43.94, 25000, "Нижегородская область"),
    "Казань": (55.79, 49.12, 25000, "Татарстан"), "Челябинск": (55.16, 61.4, 20000, "Челябинская область"),
}


def key():
    k = os.environ.get("DGIS_KEY")
    f = pathlib.Path.home() / ".config" / "ebl" / "keys"
    if not k and f.exists():
        k = next((l.split("=", 1)[1].strip() for l in f.read_text().splitlines() if l.startswith("DGIS_KEY=")), None)
    if not k: sys.exit("Нет ключа: строка DGIS_KEY=… в ~/.config/ebl/keys")
    return k


def page(k, lat, lng, n, radius):
    # «общественная баня» 2ГИС понимает как свой фильтр: в круге у Назарьево 78 мест вместо 537 по «баня», и Назарьевские
    # первыми; ближние — сначала (sort=distance), иначе выдача по популярности тянет сауны со всей Москвы
    q = urllib.parse.urlencode({"q": "общественная баня", "type": "branch", "point": f"{lng},{lat}", "radius": int(radius), "sort": "distance",
                                "page": n, "page_size": PAGE, "fields": FIELDS, "key": k})
    with urllib.request.urlopen(urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "ebl.su-radar/1.0"}), timeout=30) as r:
        d = json.load(r)
    code = d.get("meta", {}).get("code")
    if code == 404: return [], 0              # ничего не нашлось или страницы кончились
    if code != 200: raise RuntimeError(f"2ГИС ответил {code}: {d.get('meta', {}).get('error', {}).get('message', '')}")
    return d["result"]["items"], d["result"].get("total", 0)


def region_of(item, city_region=None):
    if city_region:   # прочёс по городу: регион — у самой организации, а если 2ГИС его не дал — регион города
        return next((a.get("name") for a in item.get("adm_div", []) if a.get("type") == "region"), None) or city_region
    names = [a.get("name", "") for a in item.get("adm_div", [])]
    return "Москва" if "Москва" in names and not any("область" in x for x in names) else \
        "Московская область" if any(x == "Московская область" for x in names) else None


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("run"); ap.add_argument("--max-requests", type=int, default=300)
    ap.add_argument("--only", help="одна точка «шир,долг» — проба")
    ap.add_argument("--cities", help="города из CITIES через запятую или all — вместо сетки Москвы и области")
    a = ap.parse_args()
    run, k = pathlib.Path(a.run), key()
    (run / "sweep").mkdir(parents=True, exist_ok=True)
    of = run / "sweep" / "out_2gis.json"
    seen, out, used = set(), [], 0

    def take(items, city_region=None):
        for it in items:
            fid = it["id"].split("_")[0]
            rubrics = [r.get("name", "") for r in it.get("rubrics", [])]
            if fid in seen or not (BATH.search(it.get("name", "")) or any("бан" in r.lower() for r in rubrics)): continue
            reg = region_of(it, city_region)
            if not reg: continue           # соседние области — не сейчас
            seen.add(fid)
            p = it.get("point") or {}
            city = next((x.get("name") for x in it.get("adm_div", []) if x.get("type") in ("city", "settlement")), None)
            out.append({"region": reg, "area": city_region or "2gis", "name": it.get("name"), "city": city,
                        "address": it.get("address_name") or it.get("full_address_name"), "lat": p.get("lat"), "lng": p.get("lon"),
                        "map_url": f"https://2gis.ru/moscow/firm/{fid}", "rubric": ", ".join(rubrics)[:120] or None, "src": "2gis_api"})

    def circle(lat, lng, r, creg=None):
        """круг целиком, если в нём до 50 мест; больше — первые 50 ближних и четыре круга поменьше вокруг"""
        nonlocal used
        if used >= a.max_requests: return
        items, total = page(k, lat, lng, 1, r); used += 1; take(items, creg)
        if total > PAGE * PAGES and r > 1500:
            dlat, dlng = r / 2 / 111000, r / 2 / (111000 * 0.56)
            for sy in (-1, 1):
                for sx in (-1, 1): circle(lat + sy * dlat, lng + sx * dlng, r * 0.72, creg)
            return
        for n in range(2, min(PAGES, -(-total // PAGE)) + 1):
            if used >= a.max_requests: return
            items, _ = page(k, lat, lng, n, r); used += 1; take(items, creg); time.sleep(0.15)
        of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    if a.cities:
        names = list(CITIES) if a.cities == "all" else [c.strip() for c in a.cities.split(",")]
        grid = [(CITIES[c][0], CITIES[c][1], CITIES[c][2], CITIES[c][3]) for c in names]
    else:
        grid = [(*map(float, a.only.split(",")), 40000, None)] if a.only else [(lat, lng, 40000, None) for lat, lng in GRID]
    for lat, lng, rad, creg in grid:
        circle(lat, lng, rad, creg)
        print(f"  {lat},{lng}: всего бань {len(out)}, запросов {used}", file=sys.stderr)
        if used >= a.max_requests: print("  упёрлись в --max-requests", file=sys.stderr); break
    of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"2ГИС: {len(out)} бань, запросов {used}")


if __name__ == "__main__":
    main()
