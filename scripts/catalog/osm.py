#!/usr/bin/env python3
"""Единый каталог, шаг 2: кандидаты из OpenStreetMap (Photon, без ключей и без лимита веб-поиска агентов).

  python3 scripts/catalog/osm.py scripts/catalog/runs/2026-10-19

Для каждой бани из input.json — поиск по названию с уклоном к её текущей точке; берём только заведения (не улицы и не
города) в пределах радиуса по точности точки (точная/среднеточная — 50 км, город — 60, регион — 400, страна — 1500).
Пишет osm.json: {id: [кандидаты: name, lat, lng, km, osm, kind, street, city, state, country, sim]}. Раз в ~1,2 с.
"""
import json, math, re, sys, time, pathlib, urllib.parse, urllib.request

run = pathlib.Path(sys.argv[1]); rows = json.loads((run / "input.json").read_text(encoding="utf-8"))
out_f = run / "osm.json"; out = json.loads(out_f.read_text(encoding="utf-8")) if out_f.exists() else {}
UA = "EBL-catalog/0.1 (bath league catalog; contact a.kanaev)"
RADIUS = {"exact": 50, "auto": 50, "city": 60, "region": 400, "country": 1500}
POI = {"amenity", "leisure", "tourism", "building", "shop", "club", "healthcare"}
JUNK = re.compile(r"\b(\d+\s*(р|вр|отд\.?)|вр|высш\w*|мужск\w*|женск\w*|баня|бани|бань|сауна|отделение|частная)\b", re.I)
def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 6371 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
def toks(s): return {t for t in re.findall(r"\w{3,}", (s or "").lower().replace("ё", "е"))}
def get(q, lat, lng):
    p = {"q": q, "limit": 8}
    if lat is not None: p.update(lat=lat, lon=lng)
    url = "https://photon.komoot.io/api/?" + urllib.parse.urlencode(p)
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=25) as r: return json.load(r)
        except Exception as e:
            time.sleep(4 * (i + 1))
    return {"features": []}
for n, b in enumerate(rows):
    if str(b["id"]) in out: continue
    name = b["name"]; parts = [x.strip() for x in name.split(",")]
    clean = re.sub(r"\s+", " ", JUNK.sub(" ", name.replace(",", " "))).strip()
    ctx = b.get("region") or b.get("country") or ""
    here = (b["lat"], b["lng"]) if b.get("lat") is not None else None
    cands = {}
    for q in {f"{clean} {ctx}".strip(), f"баня {clean}".strip(), f"{clean} sauna".strip()}:
        for f in get(q, *(here or (None, None))).get("features", []):
            pr = f["properties"]; lng, lat = f["geometry"]["coordinates"]
            if pr.get("osm_key") not in POI: continue
            d = km(here, (lat, lng)) if here else None
            if d is not None and d > RADIUS.get(b.get("precision") or "region", 400): continue
            key = f'{pr.get("osm_type")}{pr.get("osm_id")}'
            sim = len(toks(clean) & toks(pr.get("name"))) / max(1, len(toks(clean)))
            cands[key] = {"name": pr.get("name"), "lat": round(lat, 6), "lng": round(lng, 6), "km": round(d, 2) if d is not None else None,
                          "osm": key, "kind": f'{pr.get("osm_key")}={pr.get("osm_value")}', "street": " ".join(filter(None, [pr.get("street"), pr.get("housenumber")])) or None,
                          "city": pr.get("city"), "state": pr.get("state"), "country": pr.get("country"), "sim": round(sim, 2)}
        time.sleep(1.2)
    out[str(b["id"])] = sorted(cands.values(), key=lambda c: (-c["sim"], c["km"] if c["km"] is not None else 9e9))[:5]
    if n % 20 == 0:
        out_f.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8"); print(n, name, "→", len(out[str(b["id"])]), flush=True)
out_f.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
print("готово:", len(out), "бань;", sum(1 for v in out.values() if v and v[0]["sim"] >= 0.5), "с хорошим кандидатом")
