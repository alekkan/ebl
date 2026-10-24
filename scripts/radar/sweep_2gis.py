#!/usr/bin/env python3
"""Радар, шаг 1в: прочёс 2ГИС через Places API (23.10, демо-ключ Лехи: 1000 запросов в месяц, 600 в минуту).
Агенты через веб-поиск видят только то, что поисковик проиндексировал (Назарьевские бани не нашлись); API отдаёт всё по
запросу «общественная баня» в круге до 50 км (демо-ключ — по 10 за запрос). Москву и область покрываем сеткой кругов по 40 км.

  python3 scripts/radar/sweep_2gis.py $R [--max-requests 300] [--only 55.67,37.04]   # → $R/sweep/out_2gis.json
  python3 scripts/radar/sweep.py merge $R                                             # дальше как с агентами

Ключ — строка DGIS_KEY=… в ~/.config/ebl/keys (или переменная окружения DGIS_KEY): не в git, не в чат, не в логи.
Условия 2ГИС ограничивают хранение данных справочника — что из ответа идёт на бой, решает владелец (docs/radar.md).
"""
import urllib.error, argparse, json, os, pathlib, re, sys, time, urllib.parse, urllib.request

API = "https://catalog.api.2gis.com/3.0/items"
FIELDS = "items.point,items.address_name,items.full_address_name,items.rubrics,items.adm_div,items.attribute_groups"
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


def keys():
    """все ключи 2ГИС: DGIS_KEY, DGIS_KEY2, … из ~/.config/ebl/keys (или переменной DGIS_KEY) — по порядку, кончился — следующий"""
    f = pathlib.Path.home() / ".config" / "ebl" / "keys"
    ks = [os.environ["DGIS_KEY"]] if os.environ.get("DGIS_KEY") else []
    if f.exists():
        ks += [l.split("=", 1)[1].strip() for l in f.read_text().splitlines() if re.match(r"DGIS_KEY\d*=", l)]
    ks = [k for i, k in enumerate(ks) if k and k not in ks[:i]]
    if not ks: sys.exit("Нет ключа: строка DGIS_KEY=… в ~/.config/ebl/keys")
    return ks


def key():
    return keys()[0]


class KeysOut(Exception):
    """все ключи упёрлись в лимит — сохраняем сделанное и просим новый ключ"""


_ki = 0


def page_any(ks, lat, lng, n, radius, region_id=None):
    """page() с текущим ключом; ключ упёрся в лимит (403/429/«limit», «blocked») — следующий"""
    global _ki
    tries = 0
    while _ki < len(ks):
        try:
            return page(ks[_ki], lat, lng, n, radius, region_id)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:   # сеть моргнула (25.10 упали на 575-м пункте)
            tries += 1
            if tries > 4: raise
            print(f"  сеть: {e}, повтор через {10 * tries} с", file=sys.stderr); time.sleep(10 * tries)
        except RuntimeError as e:
            if not re.search(r"(403|429|limit|лимит|block|блок)", str(e), re.I): raise
            print(f"  ключ {_ki + 1} кончился: {e}", file=sys.stderr); _ki += 1
    raise KeysOut()


def page(k, lat, lng, n, radius, region_id=None):
    # «общественная баня» 2ГИС понимает как свой фильтр: в круге у Назарьево 78 мест вместо 537 по «баня», и Назарьевские
    # первыми; ближние — сначала (sort=distance), иначе выдача по популярности тянет сауны со всей Москвы
    where = {"region_id": region_id} if region_id else {"point": f"{lng},{lat}", "radius": int(radius), "sort": "distance"}
    q = urllib.parse.urlencode({"q": "общественная баня", "type": "branch", **where, "page": n, "page_size": PAGE, "fields": FIELDS, "key": k})
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
    ap.add_argument("--regions", help="файл регионов 2ГИС (region/list: id, name, bounds) — весь город целиком, 24.10")
    ap.add_argument("--skip", default="", help="регионы 2ГИС, которые не берём, через запятую")
    ap.add_argument("--points", help="файл [{id, name, lat, lng}] — населённые пункты, круг 12 км вокруг каждого (25.10)")
    ap.add_argument("--grid", help="регионы 2ГИС через запятую — сеткой кругов по 35 км по рамке (регионы-области: край, Ленобласть, Крым)")
    a = ap.parse_args()
    run, ks = pathlib.Path(a.run), keys()
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
            # признаки карточки («Общественная баня», «До 10 человек», «Цена от 500 ₽») — подсказка агенту разбора (25.10)
            attrs = [x.get("name") for g in it.get("attribute_groups", []) for x in g.get("attributes", []) if x.get("name")]
            attrs = [x for x in attrs if re.search(r"(обществ|человек|цена|парн|веник|купел|бассейн|номер|отделени|женск|мужск)", x, re.I)]
            out.append({"region": reg, "area": city_region or "2gis", "name": it.get("name"), "city": city,
                        "address": it.get("address_name") or it.get("full_address_name"), "lat": p.get("lat"), "lng": p.get("lon"),
                        "map_url": f"https://2gis.ru/moscow/firm/{fid}", "src": "2gis_api",
                        "rubric": "; ".join(filter(None, [", ".join(rubrics)[:80], ", ".join(attrs)[:160]])) or None})

    def circle(lat, lng, r, creg=None):
        """круг целиком, если в нём до 50 мест; больше — первые 50 ближних и четыре круга поменьше вокруг"""
        nonlocal used
        if used >= a.max_requests: return
        items, total = page_any(ks, lat, lng, 1, r); used += 1; take(items, creg)
        if total > PAGE * PAGES and r > 1500:
            dlat, dlng = r / 2 / 111000, r / 2 / (111000 * 0.56)
            for sy in (-1, 1):
                for sx in (-1, 1): circle(lat + sy * dlat, lng + sx * dlng, r * 0.72, creg)
            return
        for n in range(2, min(PAGES, -(-total // PAGE)) + 1):
            if used >= a.max_requests: return
            items, _ = page_any(ks, lat, lng, n, r); used += 1; take(items, creg); time.sleep(0.15)
        of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    if a.points:   # 25.10: города и сёла России из OSM — круг 12 км вокруг каждого; сделанное помним, ключ кончился — продолжим
        df = run / "sweep" / "done_points.json"
        done = set(json.loads(df.read_text())) if df.exists() else set()
        if of.exists(): out.extend(json.loads(of.read_text(encoding="utf-8"))); seen.update(o["map_url"].rsplit("/", 1)[-1] for o in out)
        pts = json.loads(pathlib.Path(a.points).read_text(encoding="utf-8"))
        try:
            for i, t in enumerate(pts):
                if t["id"] in done or used >= a.max_requests: continue
                circle(t["lat"], t["lng"], 12000, t.get("region") or t["name"])
                done.add(t["id"])
                if len(done) % 25 == 0:
                    of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8"); df.write_text(json.dumps(sorted(done)))
                    print(f"  {len(done)}/{len(pts)} пунктов, бань {len(out)}, запросов {used}", file=sys.stderr)
        except KeysOut:
            print("КЛЮЧИ 2ГИС КОНЧИЛИСЬ — нужен новый: строка DGIS_KEY2=… (3, 4…) в ~/.config/ebl/keys, потом запусти снова", file=sys.stderr)
        of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8"); df.write_text(json.dumps(sorted(done)))
        print(f"2ГИС: пунктов {len(done)}/{len(pts)}, бань {len(out)}, запросов {used}")
        return
    if a.grid:   # 24.10: в регионе-области больше 50 бань — один круг у центра терял районные города
        names = {x.strip() for x in a.grid.split(",")}
        for r in json.loads(pathlib.Path(a.regions).read_text(encoding="utf-8")):
            if r["name"] not in names: continue
            xs = [float(v) for v in re.findall(r"-?\d+\.\d+", r.get("bounds") or "")]
            lng0, lat0, lng1, lat1 = min(xs[0::2]), min(xs[1::2]), max(xs[0::2]), max(xs[1::2])
            dlat, dlng = 50 / 111, 50 / (111 * 0.56)
            lat = lat0 + dlat / 2
            while lat < lat1 and used < a.max_requests:
                lng = lng0 + dlng / 2
                while lng < lng1 and used < a.max_requests:
                    circle(lat, lng, 35000, r["name"]); lng += dlng
                lat += dlat
            print(f"  {r['name']}: всего бань {len(out)}, запросов {used}", file=sys.stderr)
            of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        grid = []
    elif a.regions:
        skip = {x.strip() for x in a.skip.split(",") if x.strip()}
        for r in json.loads(pathlib.Path(a.regions).read_text(encoding="utf-8")):
            if r["name"] in skip or used >= a.max_requests: continue
            items, total = page_any(ks, 0, 0, 1, 0, r["id"]); used += 1; take(items, r["name"])
            if total > PAGE * PAGES:   # больше 50 — круги по рамке города
                xs = [float(v) for v in re.findall(r"-?\d+\.\d+", r.get("bounds") or "")]
                lng0, lat0 = min(xs[0::2]), min(xs[1::2]); lng1, lat1 = max(xs[0::2]), max(xs[1::2])
                half = ((lat1 - lat0) * 111000 + (lng1 - lng0) * 111000 * 0.56) / 2
                circle((lat0 + lat1) / 2, (lng0 + lng1) / 2, min(50000, half), r["name"])
            else:
                for n in range(2, -(-total // PAGE) + 1):
                    items, _ = page_any(ks, 0, 0, n, 0, r["id"]); used += 1; take(items, r["name"]); time.sleep(0.15)
            print(f"  {r['name']}: в городе {total}, всего бань {len(out)}, запросов {used}", file=sys.stderr)
            of.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
        grid = []
    elif a.cities:
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
