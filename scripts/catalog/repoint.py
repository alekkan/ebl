#!/usr/bin/env python3
"""Повторный поиск точки (02.11, Леха): бани, которые Комиссия в Сверке приняла без точки (агенты нашли баню, но координат
не достали — OSM отвечал 429, капча, на сайте нет), ищем по найденному адресу и названию в OpenStreetMap и возвращаем
в Сверку новым прогоном. Чего не нашли — спросит бот у тех, кто был (point_ask_candidates).

  python3 scripts/catalog/repoint.py scripts/catalog/runs/2026-11-02-recheck   # all.json → found.json и catalog.json
  python3 scripts/catalog/push.py scripts/catalog/runs/2026-11-02-recheck > /tmp/catalog.sql   # на бой — с согласия владельца

all.json — бани с походами без точной точки и их последнее решённое предложение (как выгрузить — docs/catalog.md).
Порядок поиска: Nominatim по адресу, Nominatim по названию с городом и страной, Photon по названию у нашей точки. Точку
берём, только если она в радиусе от нашей примерной (как в osm.py) и это здание или заведение, а не улица или город.
Найденное смотрим глазами: чужое место (другой город, филиал, отель сети) — в found.json как {"rejected": "почему"};
не найденное (null) следующий запуск ищет снова.
"""
import json, math, re, sys, time, pathlib, urllib.parse, urllib.request

run = pathlib.Path(sys.argv[1]); rows = json.loads((run / "all.json").read_text(encoding="utf-8"))
found_f = run / "found.json"; found = json.loads(found_f.read_text(encoding="utf-8")) if found_f.exists() else {}
UA = "EBL-catalog/0.1 (bath league catalog; contact a.kanaev)"
RADIUS = {"auto": 50, "city": 60, "region": 400, "country": 1500}
AREA = {"city", "town", "village", "hamlet", "suburb", "neighbourhood", "quarter", "county", "state", "country", "postcode",
        "administrative", "municipality", "island", "locality", "district", "city_district", "street", "road", "residential", "tertiary", "secondary", "primary", "pedestrian",
        "footway", "service", "unclassified"}


def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 6371 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))


GENERIC = {"spa", "sauna", "hotel", "hostel", "resort", "баня", "бани", "сауна", "отель", "the", "and", "hamam", "onsen", "club"}


def toks(t): return {w for w in re.findall(r"\w{4,}", (t or "").lower().replace("ё", "е"))} - GENERIC


def fetch(url):
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ru,en"}), timeout=25) as r:
                return json.load(r)
        except Exception:
            time.sleep(5 * (i + 1))
    return None


def nominatim(q):
    time.sleep(1.2)   # правило Nominatim — не чаще раза в секунду
    res = fetch("https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": 5})) or []
    return [{"lat": float(r["lat"]), "lng": float(r["lon"]), "kind": r.get("addresstype") or r.get("type"), "label": r.get("display_name", "")[:160]}
            for r in res]


def photon(q, here):
    time.sleep(1.2)
    p = {"q": q, "limit": 5}
    if here: p.update(lat=here[0], lon=here[1])
    res = (fetch("https://photon.komoot.io/api/?" + urllib.parse.urlencode(p)) or {}).get("features", [])
    out = []
    for f in res:
        pr = f["properties"]; lng, lat = f["geometry"]["coordinates"]
        out.append({"lat": lat, "lng": lng, "kind": pr.get("type") or pr.get("osm_value"),
                    "label": ", ".join(str(pr[k]) for k in ("name", "street", "housenumber", "city", "country") if pr.get(k))[:160]})
    return out


for b in rows:
    if b["prev_status"] not in ("accepted", "kept") or found.get(str(b["id"])): continue   # пустое — ищем снова
    p = b["prop"]; here = (b["blat"], b["blng"]) if b.get("blat") is not None else None
    radius = RADIUS.get(b.get("precision") or "country", 1500)
    name, city = p.get("found_name") or b["name"], p.get("city") or ""
    tries = []
    if p.get("address"): tries.append(("адрес", lambda: nominatim(f'{p["address"]}, {b["country"]}')))
    tries.append(("название", lambda: nominatim(f"{name.split('(')[0].strip()}, {city}, {b['country']}".replace(", ,", ","))))
    tries.append(("название у нашей точки", lambda: photon(name.split("(")[0].strip(), here)))
    tries.append(("название", lambda: nominatim(name.split("(")[0].strip())))
    tries.append(("название и город", lambda: photon(f"{name.split('(')[0].strip()} {city}", None)))
    hit = None
    for how, go in tries:
        for c in go():
            d = km(here, (c["lat"], c["lng"])) if here else 0
            # наша примерная точка бывает не в том городе (Арчена стояла в Мадриде) — дальше радиуса берём, если сошлось название
            near = d <= radius or (d <= 1500 and toks(name) & toks(c["label"]))
            if near and (c["kind"] or "") not in AREA:
                hit = dict(c, how=how, km=round(d, 1)); break
        if hit: break
    found[str(b["id"])] = hit
    print(b["id"], b["name"], "→", f'{hit["how"]}: {hit["label"]} ({hit["kind"]}, {hit["km"]} км)' if hit else "не нашли", flush=True)
    found_f.write_text(json.dumps(found, ensure_ascii=False, indent=1), encoding="utf-8")

# catalog.json для push.py: данные прежнего предложения (их Комиссия уже приняла) и новая точка
cat = []
for b in rows:
    hit = found.get(str(b["id"]))
    if not hit or "lat" not in hit: continue   # не нашли или отбраковали глазами ({"rejected": почему})
    p = dict(b["prop"])
    # что это та баня, Комиссия уже решила («Принять») — индекс не ниже 70, чтобы точка попала в «Проверить», а не в «Не нашли»
    p["match_why"] = f'Баню Комиссия уже приняла (прогон {b["prev_run"]}, индекс агентов {p.get("match")}); точку нашли 02.11 в OSM. ' + (p.get("match_why") or "")
    p["match"] = max(70, p.get("match") or 0)
    p.update(id=b["id"], status=p.get("place_status"), lat=round(hit["lat"], 6), lng=round(hit["lng"], 6), point_src="osm", bin="confirm",
             note=f'Повторный поиск точки 02.11 ({hit["how"]}): {hit["label"]}. Прежде — {p.get("note") or "без заметки"}')
    cat.append(p)
(run / "catalog.json").write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")
print(len(cat), "с точкой из", sum(1 for b in rows if b["prev_status"] in ("accepted", "kept")))
