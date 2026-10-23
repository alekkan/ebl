#!/usr/bin/env python3
"""Единый каталог, шаг 2б: кандидаты из 2ГИС Places API для бань без точной точки (24.10, ключ Лехи — scripts/radar/sweep_2gis.py).

  python3 scripts/catalog/dgis.py scripts/catalog/runs/2026-10-24-ru        # → поле dgis в input.json

По названию бани (без города перед запятой и отделений) ищем рядом с нашей примерной точкой: круг по точности — город 30 км,
регион и среднеточная 50 км; без точки или «по стране» — не ищем (по всей стране тёзок десятки). Три кандидата: имя, адрес,
точка, карточка. Решает агент по prompt.md — сходятся ли название и город. Один запрос на баню.
"""
import json, pathlib, re, sys, time, urllib.parse, urllib.request
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "radar"))
from sweep_2gis import API, key

RADIUS = {"city": 30000, "region": 50000, "auto": 50000}
SECT = re.compile(r"\b(\d+\s*(р|вр|отд\.?|разряд)|вр|высш\w*|мужск\w*|женск\w*|номерн\w*|общ\w*)\b", re.I)


def query(name):
    """«Иркутск, баня 10» → «баня 10»; «Блядильня Марьино» — как есть (сленг лиги API не поймёт, но и не навредит)"""
    q = name.split(",", 1)[1] if "," in name else name
    return re.sub(r"\s+", " ", SECT.sub(" ", q)).strip() or name


def main():
    run = pathlib.Path(sys.argv[1]); k = key()
    f = run / "input.json"; rows = json.loads(f.read_text(encoding="utf-8"))
    used = 0
    for r in rows:
        rad = RADIUS.get(r.get("precision") or "")
        if not rad or r.get("lat") is None or "dgis" in r: continue
        q = urllib.parse.urlencode({"q": query(r["name"]), "type": "branch", "point": f"{r['lng']},{r['lat']}", "radius": rad,
                                    "page_size": 3, "fields": "items.point,items.address_name,items.rubrics,items.adm_div", "key": k})
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "ebl.su-catalog/1.0"}), timeout=30) as resp:
                d = json.load(resp)
        except Exception as e:
            print(f"  {r['id']}: {e}", file=sys.stderr); continue
        used += 1
        items = d.get("result", {}).get("items", []) if d.get("meta", {}).get("code") == 200 else []
        r["dgis"] = [{"name": it.get("name"), "address": it.get("address_name"),
                      "city": next((x.get("name") for x in it.get("adm_div", []) if x.get("type") in ("city", "settlement")), None),
                      "lat": (it.get("point") or {}).get("lat"), "lng": (it.get("point") or {}).get("lon"),
                      "rubrics": [x.get("name") for x in it.get("rubrics", [])][:3],
                      "card": f"https://2gis.ru/firm/{it['id'].split('_')[0]}"} for it in items]
        time.sleep(0.15)
    f.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"2ГИС: запросов {used}, с кандидатами {sum(1 for r in rows if r.get('dgis'))} из {len(rows)}")


if __name__ == "__main__":
    main()
