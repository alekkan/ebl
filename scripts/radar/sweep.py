#!/usr/bin/env python3
"""Радар, шаг 1б: прочёс справочников — Яндекс Карты и 2ГИС по округам и городам (23.10, просьба Лехи). В OpenStreetMap
есть не все бани: «Назарьевские бани» (Одинцовский округ) Радар не видел — в OSM их нет. Агенты ищут «общественная баня
<место>» по справочникам и выписывают все бани из выдачи; дальше — обычный разбор (batches.py → prompt.md → build.py).

  python3 scripts/radar/sweep.py plan  $R "Москва" "Московская область"   # sweep/area_N.json — места для агентов
  # агенты по scripts/radar/sweep_prompt.md — по одному на пачку мест, параллельно; ответы → $R/sweep/out_N.json
  supabase db query --linked -o json "select key, name, lat, lng from radar_places" > $R/radar_now.json   # только чтение
  python3 scripts/radar/sweep.py merge $R                                  # → candidates_dir.json для batches.py

Лимит поиска тот же — 200 за ход на всех агентов: два поиска на место (Яндекс и 2ГИС), 64 места — ~130 поисков.
merge выкидывает то, что уже есть в лиге (то же название ближе 1,5 км) и в Радаре (ближе 1 км), и склеивает дубли
из двух справочников (та же карточка или то же название ближе 300 м).
"""
import json, re, sys, time, pathlib, urllib.parse, urllib.request
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import UA, km, league_baths, league_match, same_name, real_point

# Москва и область — рамка для геокодера: адрес-тёзка из другого региона нам не нужен
BOX = "35.1,56.99,40.3,54.2"

AREAS = {
    # округа Москвы: в выдаче по всей Москве справочники показывают десяток самых известных — идём по округам
    "Москва": ["ЦАО", "САО", "СВАО", "ВАО", "ЮВАО", "ЮАО", "ЮЗАО", "ЗАО", "СЗАО", "Зеленоград", "Новомосковский округ",
               "Троицкий округ"],
    # городские округа Подмосковья — по главному городу (Ногинск, а не «Богородский»), так их ищут справочники
    "Московская область": [
        "Балашиха", "Ногинск", "Бронницы", "Волоколамск", "Воскресенск", "Дзержинский", "Дмитров", "Долгопрудный",
        "Домодедово", "Дубна", "Егорьевск", "Жуковский", "Зарайск", "Истра", "Кашира", "Клин", "Коломна", "Королёв",
        "Котельники", "Красногорск", "Видное", "Лобня", "Лосино-Петровский", "Лотошино", "Луховицы", "Лыткарино",
        "Люберцы", "Можайск", "Мытищи", "Наро-Фоминск", "Одинцово", "Орехово-Зуево", "Павловский Посад", "Подольск",
        "Пушкино", "Раменское", "Реутов", "Руза", "Сергиев Посад", "Серебряные Пруды", "Серпухов", "Солнечногорск",
        "Ступино", "Талдом", "Фрязино", "Химки", "Чехов", "Шатура", "Шаховская", "Щёлково", "Электрогорск",
        "Электросталь"],
}


def card_id(url):
    """одна и та же карточка из разных выдач: yandex.ru/maps/org/<имя>/<id>, 2gis.ru/…/firm/<id>"""
    m = re.search(r"/maps/org/(?:[^/]+/)?(\d{5,})", url or "") or re.search(r"/org/(?:[^/]+/)?(\d{5,})", url or "")
    if m: return "ya:" + m[1]
    m = re.search(r"/firm/(\d{8,})", url or "")
    return "2gis:" + m[1] if m else None


def flat_addr(a):
    """адрес без города и сокращений: «Одинцово, ул. Ленина, 5» и «улица Ленина 5» — один"""
    a = re.sub(r"\b(ул|улица|д|дом|пр|просп|проспект|ш|шоссе|г|город|мкр|корп|стр)\b\.?", " ", (a or "").lower().replace("ё", "е"))
    return "".join(re.findall(r"[а-яa-z]+|\d+", a.split(",", 1)[-1]))


def geocode(run, found):
    """точки по адресу из справочника — геокодер OpenStreetMap раз в 1,1 с, кэш в sweep/geocache.json. Справочники
    координаты почти не отдают (23.10: у 33 из 369), а без точки не понять, есть ли баня уже в лиге или в Радаре.
    Берём только дом или организацию: центр улицы или города — не точка бани."""
    cf = run / "sweep" / "geocache.json"
    cache = json.loads(cf.read_text(encoding="utf-8")) if cf.exists() else {}
    for p in found:
        if real_point(p.get("lat"), p.get("lng")) or not p.get("address"): continue
        q = f"{re.sub(r'[(].*?[)]', '', p['address']).strip()}, {p.get('city') or p.get('area')}"
        if q not in cache:
            url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
                {"q": q, "format": "jsonv2", "limit": 1, "countrycodes": "ru", "viewbox": BOX, "bounded": 1})
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20) as r:
                    hit = (json.load(r) or [None])[0]
                cache[q] = [float(hit["lat"]), float(hit["lon"])] if hit and hit.get("addresstype") in (
                    "building", "amenity", "house", "leisure", "shop", "tourism", "office", "place") else None
            except Exception as e:   # 429 и прочее — не обходим: без точки, следующий запуск спросит снова
                print(f"  {q}: {e}", file=sys.stderr); continue
            cf.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            time.sleep(1.1)
        if cache.get(q): p["lat"], p["lng"] = cache[q]


def plan(run, regions, per=8):
    areas = [(r, a) for r in regions for a in AREAS[r]]
    (run / "sweep").mkdir(parents=True, exist_ok=True)
    for old in (run / "sweep").glob("area_*.json"): old.unlink()
    n = -(-len(areas) // per)
    for k in range(n):
        part = [{"region": r, "area": a} for r, a in areas[k::n]]
        (run / "sweep" / f"area_{k + 1}.json").write_text(json.dumps(part, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"мест {len(areas)}, пачек {n} — агентов столько же; поисков до {2 * len(areas)}")


def merge(run):
    found = []
    for f in sorted((run / "sweep").glob("out_*.json")):
        found += [p for p in json.loads(f.read_text(encoding="utf-8")) if p.get("name")]
    geocode(run, found)
    league = [b for b in league_baths() if b.get("status") != "rejected"]
    rf = run / "radar_now.json"
    radar = json.loads(rf.read_text(encoding="utf-8")) if rf.exists() else []
    radar = radar["rows"] if isinstance(radar, dict) else radar
    radar_keys = {r["key"] for r in radar}   # та же карточка справочника уже в Радаре (прочёс агентами и API дают одни ключи)
    cands, skip = [], {"дубль": 0, "уже в лиге": 0, "уже в Радаре": 0}
    for p in found:
        lat, lng = p.get("lat"), p.get("lng")
        pt = (lat, lng) if real_point(lat, lng) else None
        key = card_id(p.get("map_url")) or "dir:" + re.sub(r"[^а-яa-z0-9]", "", (p["name"] + (p.get("address") or "")).lower())[:60]
        addr = " ".join(filter(None, [p.get("city"), p.get("address")]))
        # по точке, если она есть у обоих; по адресу — только без точек: «улица Ленина, 1» есть в каждом городе (24.10 «Баня №1»
        # в Саратове получила вторую карточку самарской)
        dup = next((c for c in cands if c["key"] == key or same_name(p["name"], c["name"]) and (
                    km(pt, (c["lat"], c["lng"])) < 0.3 if pt and c.get("lat") else flat_addr(addr) and flat_addr(addr) == flat_addr(c["addr"]))), None)
        if dup:   # вторая карточка того же места — добавим ссылку, если её не было
            dup["map_url_2"] = dup.get("map_url_2") or (p.get("map_url") if p.get("map_url") != dup.get("map_url") else None)
            skip["дубль"] += 1; continue
        sure, hint = league_match(p["name"], lat, lng, league, p.get("region"), addr)
        if sure: skip["уже в лиге"] += 1; continue
        if key in radar_keys or any(pt and r.get("lat") and same_name(p["name"], r["name"]) and km(pt, (r["lat"], r["lng"])) < 1 for r in radar):
            skip["уже в Радаре"] += 1; continue
        cands.append({"key": key, "name": p["name"], "region": p.get("region"), "lat": lat if pt else None, "lng": lng if pt else None,
                      "addr": addr, "map_url": p.get("map_url"),
                      "rubric_hint": p.get("rubric") or "справочник", "league_hint": (hint or {}).get("id")})
    (run / "candidates_dir.json").write_text(json.dumps(cands, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"из справочников: {len(found)}, новых кандидатов {len(cands)}, отсеяно {skip}")


def rehint(path):
    """подсказки «это наша?» для мест, что уже в Радаре и ждут решения, — по нынешним правилам league_match. Выгрузка:
    supabase db query --linked -o json "select id, name, region, city, address, lat, lng from radar_places
      where status = 'new' and league_hint is null" > /tmp/radar_new.json
    печатает SQL (на бой — с согласия владельца)"""
    rows = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    rows = rows["rows"] if isinstance(rows, dict) else rows
    league = [b for b in league_baths() if b.get("status") != "rejected"]
    out = []
    for r in rows:
        sure, hint = league_match(r["name"], r.get("lat"), r.get("lng"), league, r.get("region"), " ".join(filter(None, [r.get("city"), r.get("address")])))
        b = sure or hint
        if b: out.append(f"update public.radar_places set league_hint = {int(b['id'])} where id = {int(r['id'])} and league_hint is null;  -- {r['name']} → {b['name']}")
    print("begin;\n" + "\n".join(out) + "\ncommit;")
    print(f"-- подсказок: {len(out)} из {len(rows)}", file=sys.stderr)


if __name__ == "__main__":
    cmd, run = sys.argv[1], pathlib.Path(sys.argv[2])
    {"plan": lambda: plan(run, sys.argv[3:]), "merge": lambda: merge(run), "rehint": lambda: rehint(run)}[cmd]()
