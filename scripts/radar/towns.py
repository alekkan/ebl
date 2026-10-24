#!/usr/bin/env python3
"""Радар, малые города и сёла (25.10): точки для `sweep_2gis.py --points` из населённых пунктов OSM.

  # пункты — Overpass (зеркало maps.mail.ru), двумя запросами: одним большим зеркало отвечает 504
  #   area["ISO3166-1"="RU"][admin_level=2]->.r;(node["place"~"^(city|town)$"](area.r););out tags center;   → p_town.json
  #   … node["place"="village"]["population"~"^([3-9][0-9]{3}|[1-9][0-9]{4,})$"](area.r) …                   → p_village.json
  python3 scripts/radar/towns.py RUN/p_town.json RUN/p_village.json --regions RUN/dgis_regions.json > RUN/points.json

Берём города, посёлки и сёла от 3000 жителей; крупные — первыми (ключ кончится — главное уже пройдено). Пропускаем, что уже
прочёсано 24.10: регион 2ГИС размером с город целиком, у большого — 40 км от центра, сеткой — четыре региона, Москва и область.
Пункт ближе 15 км к уже взятому не берём: круг 12 км от соседа его почти накрывает.
"""
import argparse, json, math, re, sys

GRID = {"Краснодарский край", "Крым", "Ленинградская область", "Республика Алтай", "Москва", "Московская область"}


def km(a, b):
    return math.hypot((a[0] - b[0]) * 111, (a[1] - b[1]) * 111 * math.cos(math.radians(a[0])))


def boxes(path):
    out = []
    for r in json.load(open(path, encoding="utf-8")):
        xs = [float(v) for v in re.findall(r"-?\d+\.\d+", r.get("bounds") or "")]
        lng0, lat0, lng1, lat1 = min(xs[0::2]), min(xs[1::2]), max(xs[0::2]), max(xs[1::2])
        half = ((lat1 - lat0) * 111 + (lng1 - lng0) * 111 * 0.56) / 2
        whole = r["name"] in GRID or half <= 50
        out.append((lat0, lng0, lat1, lng1, whole, ((lat0 + lat1) / 2, (lng0 + lng1) / 2)))
    return out


def swept(p, bx):
    for lat0, lng0, lat1, lng1, whole, c in bx:
        if lat0 <= p[0] <= lat1 and lng0 <= p[1] <= lng1 and (whole or km(p, c) < 40): return True
    return False


def pop(t):
    m = re.match(r"\d+", (t.get("population") or "").replace(" ", ""))
    return int(m.group()) if m else {"city": 50000, "town": 10000}.get(t.get("place"), 0)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("files", nargs="+"); ap.add_argument("--regions", required=True)
    a = ap.parse_args()
    els = [e for f in a.files for e in json.load(open(f, encoding="utf-8"))["elements"]]
    bx, took, out, skip = boxes(a.regions), [], [], 0
    for e in sorted(els, key=lambda e: -pop(e.get("tags", {}))):
        p, t = (e["lat"], e["lon"]), e.get("tags", {})
        if swept(p, bx): skip += 1; continue
        if any(km(p, q) < 15 for q in took): continue
        took.append(p)
        out.append({"id": f"osm{e['id']}", "name": t.get("name"), "lat": p[0], "lng": p[1], "pop": pop(t),
                    "region": t.get("addr:region") or t.get("is_in:region") or None})
    json.dump(out, sys.stdout, ensure_ascii=False, indent=0)
    print(f"пунктов {len(els)}, уже прочёсаны {skip}, точек {len(out)}", file=sys.stderr)


if __name__ == "__main__":
    main()
