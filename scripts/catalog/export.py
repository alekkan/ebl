#!/usr/bin/env python3
"""Единый каталог, шаг 1: общественные бани лиги для прогона агентов (docs/catalog.md).

  python3 scripts/catalog/export.py scripts/catalog/runs/2026-10-19

Берёт с боя (supabase db query --linked, только чтение): баня, регион и страна Комиссии (опора поиска — почти всегда
верные), текущая точка и её точность, сколько походов (2026 и всего), подсказки Радара (если место уже найдено там:
сайт, карточка, точка). Пишет input.json. Отделения одного здания («1р», «2вр», «высший», «мужской») — общий group.
"""
import json, re, subprocess, sys, pathlib

run = pathlib.Path(sys.argv[1]); run.mkdir(parents=True, exist_ok=True)
SQL = """
select json_agg(x order by x.n26 desc, x.n_all desc, x.id) from (
  select b.id, b.name, b.region, b.country, b.lat, b.lng, b.precision,
    coalesce((select sum(n) from bath_counts c where c.bath_id = b.id and c.year = 2026), 0) n26,
    coalesce((select sum(n) from bath_counts c where c.bath_id = b.id), 0) n_all,
    (select json_agg(json_build_object('name', r.name, 'lat', r.lat, 'lng', r.lng, 'website', r.website, 'map_url', r.map_url,
       'address', r.address, 'status', r.status)) from radar_places r where r.league_hint = b.id or r.bath_id = b.id) radar
  from baths b where b.status = 'ok' and b.type = 'public') x
"""
out = subprocess.run(["supabase", "db", "query", "--linked", SQL], capture_output=True, text=True, cwd=pathlib.Path(__file__).resolve().parents[2])
txt = out.stdout
data, _ = json.JSONDecoder().raw_decode(txt[txt.index("{"):])
rows = data["rows"][0]["json_agg"]
rows = json.loads(rows) if isinstance(rows, str) else rows
# отделения одного здания — общий ключ: название без «1р/2вр/вр/высший/мужской/женский/отд…» и цифр отделения
SECT = re.compile(r"\b(\d+\s*(р|вр|отд\.?|разряд)|вр|высш\w*|мужск\w*|женск\w*|общ\w* отд\w*|\d+\s*этаж)\b", re.I)
for r in rows:
    base = SECT.sub(" ", r["name"].lower()); base = re.sub(r"[^\w]+", " ", base).strip()
    r["group"] = f'{(r.get("region") or r.get("country") or "").lower()}|{base}'
(run / "input.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
from collections import Counter
g = Counter(r["group"] for r in rows)
print(len(rows), "бань;", sum(1 for r in rows if r["n26"]), "с походами в 2026;", sum(1 for r in rows if r["radar"]), "с подсказкой Радара;",
      sum(1 for k, v in g.items() if v > 1), "зданий с несколькими отделениями")
