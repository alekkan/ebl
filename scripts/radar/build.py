#!/usr/bin/env python3
"""Радар, шаг 3: ответы агентов → radar.json для push.py.

  python3 scripts/radar/build.py scripts/radar/runs/2026-10-23 [--prev scripts/radar/runs/2026-10-16/radar.json]

Склеивает кандидатов (candidates*.json) с ответами (out/*.json) по key. Места, которые в этот прогон не разбирали, берёт
из --prev как есть. Подсказку «это наша баня» (league_hint) — из collect.py. Не бани (kind other) в радар не идут.
Цитаты оставляет только с сайтов самих бань: отзывы и тексты справочников к себе не копируем.
"""
import json, re, sys, pathlib, argparse
from urllib.parse import urlsplit, urlunsplit
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import real_point

ap = argparse.ArgumentParser(); ap.add_argument("run"); ap.add_argument("--prev"); a = ap.parse_args()
run = pathlib.Path(a.run)
DIRECTORY = re.compile(r"(yandex|yango|2gis|zoon|yell|google|duckduckgo)", re.I)
CARD = re.compile(r"(yandex\.ru/maps/org/|yango\.com/org/|2gis\.ru/.*/firm/)")
clean = lambda t: re.sub(r"^\s*\[пересказ\]\s*", "", t).strip() if t else None


def uni(u):
    """кириллический домен — по-русски (xn--… не прочесть), ссылка рабочая"""
    if not u: return None
    try:
        p = urlsplit(u if "://" in u else "https://" + u)
        host = ".".join(x.encode().decode("idna") if x.startswith("xn--") else x for x in p.hostname.split("."))
        return urlunsplit((p.scheme, host, p.path, p.query, p.fragment))
    except Exception: return u


cands = {}
for f in sorted(run.glob("candidates*.json")):
    for c in json.loads(f.read_text(encoding="utf-8")): cands[c["key"]] = c
res = {}
for f in sorted(run.glob("out/*.json")):
    for r in json.loads(f.read_text(encoding="utf-8")):
        if r.get("key") in cands and (r["key"] not in res or r.get("kind") != "unknown"): res[r["key"]] = r
places = {p["key"]: p for p in json.load(open(a.prev, encoding="utf-8"))} if a.prev else {}
for key, c in cands.items():
    r = res.get(key)
    if not r: continue
    if r.get("kind") == "other": places.pop(key, None); continue
    urls = [r.get("map_url")] + [e.get("url") for e in r.get("evidence") or []]
    places[key] = {
        "key": key, "name": re.sub(r"\s*\(.*?\)\s*$", "", r.get("found_name") or c["name"]).strip() or c["name"], "region": c.get("region"),
        "city": r.get("city"), "address": r.get("address") or c.get("addr") or None,
        "lat": c.get("lat") if real_point(c.get("lat"), c.get("lng")) else None, "lng": c.get("lng") if real_point(c.get("lat"), c.get("lng")) else None,
        "website": uni(r.get("website") or c.get("website")), "map_url": next((u for u in urls if u and CARD.search(u)), None),
        "kind": r.get("kind") or "unknown", "public_index": r.get("public_index"), "confidence": r.get("confidence"),
        "gender_split": r.get("gender_split"), "ticket_per_person": r.get("ticket_per_person"),
        "price_example": clean(r.get("price_example")), "note": clean(r.get("note")),
        "evidence": [e for e in r.get("evidence") or [] if e.get("url") and not DIRECTORY.search(e["url"])][:2],
        "league_hint": c.get("league_hint"),
    }
out = sorted(places.values(), key=lambda p: -(p.get("public_index") or 0))
(run / "radar.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
pub = sum(1 for p in out if p["kind"] == "public" and (p["public_index"] or 0) >= 70)
print(f"radar.json: {len(out)} мест, общественных с индексом 70+: {pub}, не разобрано: {sum(1 for p in out if p['kind'] == 'unknown')}")
