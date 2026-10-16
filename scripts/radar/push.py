#!/usr/bin/env python3
"""Радар: места из еженедельного прогона агентов → SQL для таблицы radar_places (docs/radar.md).

  python3 scripts/radar/push.py radar.json > /tmp/radar.sql
  supabase db query --linked -f /tmp/radar.sql          # на бой — только с согласия владельца, как любые данные

radar.json — список мест: key (стабильный между прогонами: osm:n123 / 2gis:… / name:…), name, region, city, address,
lat, lng, website, map_url, kind, public_index, confidence, gender_split, ticket_per_person, price_example, note,
evidence [{quote, url}], league_hint (id бани лиги, если название совпало).
Повторная заливка обновляет данные места и last_seen; решения Комиссии (status, bath_id, decided_*) не трогает.
"""
import json, sys

COLS = ["key", "region", "name", "city", "address", "lat", "lng", "website", "map_url", "kind", "public_index", "confidence",
        "gender_split", "ticket_per_person", "price_example", "note", "evidence"]
KINDS = {"public", "spa", "private", "other", "closed", "unknown"}


def lit(v):
    if v is None or v == "":
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, (list, dict)):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def row(p):
    p = dict(p)
    if p.get("kind") not in KINDS: p["kind"] = "unknown"
    if p.get("confidence") not in ("high", "medium", "low"): p["confidence"] = None
    ix = p.get("public_index")
    p["public_index"] = None if ix is None else max(0, min(100, int(ix)))
    p["evidence"] = [{"quote": e.get("quote"), "url": e.get("url")} for e in (p.get("evidence") or [])[:3] if e.get("url")]
    vals = [lit(p.get(c)) for c in COLS]
    hint = p.get("league_hint")
    # баню лиги могли удалить между прогонами — тогда без подсказки, а не ошибка внешнего ключа
    vals.append(f"(select id from public.baths where id = {int(hint)})" if hint else "null")
    return "(" + ", ".join(vals) + ")"


def main():
    places = json.load(open(sys.argv[1], encoding="utf-8"))
    seen, rows = set(), []
    for p in places:
        if not p.get("key") or not p.get("name") or p["key"] in seen: continue
        seen.add(p["key"]); rows.append(row(p))
    upd = ", ".join(f"{c} = excluded.{c}" for c in COLS[1:] + ["league_hint"])
    print("-- радар: " + str(len(rows)) + " мест, scripts/radar/push.py")
    print("begin;")
    for i in range(0, len(rows), 200):
        print(f"insert into public.radar_places ({', '.join(COLS)}, league_hint) values\n" + ",\n".join(rows[i:i + 200])
              + f"\non conflict (key) do update set {upd}, last_seen = now();")
    print("commit;")


if __name__ == "__main__":
    main()
