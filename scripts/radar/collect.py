#!/usr/bin/env python3
"""Радар, шаг 1: кандидаты региона из OpenStreetMap, без того, что уже есть в лиге.

  python3 scripts/radar/collect.py "Московская область" scripts/radar/runs/2026-10-23

Пишет <папка>/candidates.json: [{key, name, region, lat, lng, addr, website, hours, tag, league_hint}]. Ключ — объект OSM
(osm:n123), он одинаков между прогонами. Мусор (остановки «Баня», ручьи «Банька», магазины, терминалы) отсеивается правилами.
Справочники (2ГИС «Парная: Общественная», Яндекс Карты) добавляй руками в <папка>/directory.txt строками «название|адрес|рубрика».
"""
import json, re, sys, urllib.parse, urllib.request, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import UA, league_baths, league_match, real_point

# зеркало VK: основной overpass-api.de часто отвечает 500/406
OVERPASS = ["https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"]
QUERY = """[out:json][timeout:240];
area["name"="{region}"]["admin_level"="4"]->.a;
(nwr["amenity"="public_bath"](area.a); nwr["leisure"="sauna"](area.a); nwr["amenity"="sauna"](area.a);
 nwr["name"~"([Бб]ан[яиь]|[Сс]аун|[Хх]амам|[Тт]ерм)"]["amenity"!="pharmacy"](area.a););
out tags center;"""
JUNK = re.compile(r"(терминал|строительств|магазин|печи|поликлиник|больниц|отель|гостиниц|hotel|урбанист|посольств|терменвокс|термояд|"
                  r"институт|автобус|маршрут|склад|завод|улица|переулок|проезд|тупик|аллея|станци|всё для бани|все для бани)", re.I)
BATH = re.compile(r"(бан[яиьн]|банно|парн|терм|хамам|hammam|русская)", re.I)
NOT_BATH_TAGS = ("highway", "railway", "public_transport", "waterway", "natural", "place", "landuse", "shop", "route")


def overpass(region):
    q = QUERY.replace("{region}", region)
    for url in OVERPASS:
        try:
            req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": q}).encode(), headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)["elements"]
        except Exception as e:
            print(f"  {url}: {e}", file=sys.stderr)
    sys.exit("Overpass не ответил — повтори позже")


def main():
    region, out = sys.argv[1], pathlib.Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    league = [b for b in league_baths() if b.get("status") != "rejected"]
    cands, skipped = [], {"без названия": 0, "мусор": 0, "уже в лиге": 0}
    for e in overpass(region):
        t = e.get("tags", {})
        lat = e.get("lat") or e.get("center", {}).get("lat"); lng = e.get("lon") or e.get("center", {}).get("lon")
        name = t.get("name", "")
        tagged = t.get("amenity") in ("public_bath", "sauna") or t.get("leisure") == "sauna"
        if not name or not lat: skipped["без названия"] += 1; continue
        if JUNK.search(name) or any(t.get(k) for k in NOT_BATH_TAGS) and not tagged or (not tagged and not BATH.search(name)):
            skipped["мусор"] += 1; continue
        sure, hint = league_match(name, lat, lng, league)
        if sure: skipped["уже в лиге"] += 1; continue
        cands.append({"key": f"osm:{e['type'][0]}{e['id']}", "name": name, "region": region, "lat": lat, "lng": lng,
                      "addr": " ".join(filter(None, [t.get("addr:city") or t.get("addr:place"), t.get("addr:street"), t.get("addr:housenumber")])),
                      "website": t.get("website") or t.get("contact:website") or "", "hours": t.get("opening_hours", ""),
                      "tag": "public_bath" if t.get("amenity") == "public_bath" else "sauna" if tagged else "по названию",
                      "osm_note": "; ".join(f"{k}={v}" for k, v in t.items() if k in ("male", "female", "fee", "access", "description", "note"))[:200],
                      "league_hint": hint["id"] if hint else None})
    d = out / "directory.txt"
    if d.exists():
        for line in d.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.startswith("#"): continue
            name, addr, rub = (line.split("|") + ["", ""])[:3]
            sure, hint = league_match(name, None, None, league)
            cands.append({"key": "dir:" + re.sub(r"[^а-яa-z0-9]", "", (name + addr).lower())[:60], "name": name, "region": region,
                          "addr": addr, "rubric_hint": rub, "league_hint": (sure or hint or {}).get("id")})
    (out / "candidates.json").write_text(json.dumps(cands, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{region}: кандидатов {len(cands)}, отсеяно {skipped}")


if __name__ == "__main__":
    main()
