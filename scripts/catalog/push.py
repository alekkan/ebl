#!/usr/bin/env python3
"""Единый каталог, шаг 5: предложения прогона → SQL для таблицы catalog_proposals (вкладка «Сверка» у Комиссии).

  python3 scripts/catalog/push.py scripts/catalog/runs/2026-10-19 > /tmp/catalog.sql
  supabase db query --linked -f /tmp/catalog.sql          # на бой — только с согласия владельца, как любые данные

Берёт catalog.json прогона (его собирает build.py). Ключ — прогон и баня: повторная заливка обновляет данные,
решения Комиссии (status, reject_reason, prev_*, decided_*) не трогает. Баню лиги могли удалить — такую пропускаем.
"""
import json, pathlib, sys

COLS = ["found_name", "address", "city", "region_found", "region_conflict", "lat", "lng", "point_src", "match", "match_why", "bin",
        "website", "yandex_url", "twogis_url", "phone", "place_status", "is_public", "public_why", "hours", "gender_days",
        "price", "price_date", "price_src", "sections", "amenities", "evidence", "note"]
STATUS = {"open", "closed", "repair", "unknown"}
TYPES = {"region_conflict": "boolean", "is_public": "boolean", "lat": "float8", "lng": "float8", "match": "int",
         "sections": "jsonb", "amenities": "jsonb", "evidence": "jsonb"}   # остальное — text; без типов union спотыкается о null


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


def row(run, r):
    p = {c: r.get(c) for c in COLS}
    p["match"] = max(0, min(100, int(r.get("match_final") if r.get("match_final") is not None else r.get("match") or 0)))
    p["place_status"] = r.get("status") if r.get("status") in STATUS else "unknown"
    p["region_conflict"] = bool(r.get("region_conflict"))
    if p["lat"] is None or p["lng"] is None: p["lat"] = p["lng"] = None
    for k in ("sections", "amenities"): p[k] = [str(x) for x in (r.get(k) or []) if x]
    p["evidence"] = [{"quote": e.get("quote"), "url": e.get("url")} for e in (r.get("evidence") or [])[:3] if isinstance(e, dict) and e.get("url")]
    vals = [lit(run), str(int(r["id"]))] + [f"{lit(p[c]).removesuffix('::jsonb')}::{TYPES.get(c, 'text')}" for c in COLS]
    return f"select {', '.join(vals)} where exists (select 1 from public.baths where id = {int(r['id'])})"


def main():
    run = pathlib.Path(sys.argv[1])
    rows = json.loads((run / "catalog.json").read_text(encoding="utf-8"))
    rows = [r for r in rows if r.get("id") and r.get("match") is not None]
    upd = ", ".join(f"{c} = excluded.{c}" for c in COLS)
    print(f"-- сверка каталога: {len(rows)} бань, прогон {run.name}, scripts/catalog/push.py")
    print("begin;")
    for i in range(0, len(rows), 100):
        print(f"insert into public.catalog_proposals (run, bath_id, {', '.join(COLS)})\n"
              + "\nunion all\n".join(row(run.name, r) for r in rows[i:i + 100])
              + f"\non conflict (run, bath_id) do update set {upd};")
    print("commit;")


if __name__ == "__main__":
    main()
