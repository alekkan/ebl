#!/usr/bin/env python3
"""Единый каталог, шаг 4б: точка по адресу для ответов агентов без точки (24.10). Восемь агентов разом упирались в 429
геокодера OSM и оставляли точку пустой, а адрес с сайта бани у них был. Здесь — по одному запросу раз в 1,1 с.

  python3 scripts/catalog/geofill.py scripts/catalog/runs/2026-10-24-abroad     # дописывает lat/lng в out/*.json

Берём только дом или организацию (не центр улицы или города); point_src — «osm-address».
"""
import json, pathlib, sys, time, urllib.parse, urllib.request

OK = ("building", "amenity", "house", "leisure", "shop", "tourism", "office", "place")


def main():
    run = pathlib.Path(sys.argv[1]); n = got = 0
    for f in sorted(run.glob("out/*.json")):
        rows = json.loads(f.read_text(encoding="utf-8")); changed = False
        for r in rows:
            if r.get("lat") is not None or not r.get("address") or (r.get("match") or 0) < 50: continue
            q = ", ".join(filter(None, [r["address"], r.get("city") if r.get("city") and r["city"] not in r["address"] else None]))
            url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode({"q": q, "format": "jsonv2", "limit": 1})
            n += 1
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ebl.su-catalog/1.0 (+https://ebl.su)"}), timeout=20) as resp:
                    hit = (json.load(resp) or [None])[0]
            except Exception as e:
                print(f"  {r['id']}: {e}", file=sys.stderr); time.sleep(5); continue
            if hit and hit.get("addresstype") in OK:
                r["lat"], r["lng"], r["point_src"] = float(hit["lat"]), float(hit["lon"]), "osm-address"; got += 1; changed = True
            time.sleep(1.1)
        if changed: f.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"геокодер: спросили {n}, точка нашлась у {got}")


if __name__ == "__main__":
    main()
