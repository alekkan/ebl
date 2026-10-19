#!/usr/bin/env python3
"""Единый каталог, шаг 3: пачки для агентов — сначала бани с походами в 2026, потом по числу походов.

  python3 scripts/catalog/batches.py scripts/catalog/runs/2026-10-19 [--max 95] [--size 8]

Пропускает уже разобранное в этом прогоне (out/*.json). --max — сколько бань в этот ход: до двух веб-поисков на баню,
лимит — 200 за ход на всех агентов. Отделения одного здания (group) — в одну пачку подряд.
"""
import json, argparse, pathlib
ap = argparse.ArgumentParser(); ap.add_argument("run"); ap.add_argument("--max", type=int, default=95); ap.add_argument("--size", type=int, default=8)
a = ap.parse_args(); run = pathlib.Path(a.run)
rows = json.loads((run / "input.json").read_text(encoding="utf-8"))
osm = json.loads((run / "osm.json").read_text(encoding="utf-8")) if (run / "osm.json").exists() else {}
done = set()
for f in run.glob("out/*.json"):
    try: done |= {r["id"] for r in json.loads(f.read_text(encoding="utf-8")) if r.get("match") is not None}   # повтор упёршихся в лимит — убрать их файл из out/
    except Exception: pass
todo = [dict(r, osm=osm.get(str(r["id"]), [])) for r in rows if r["id"] not in done]
order = {}
for r in todo: order.setdefault(r["group"], len(order))   # input уже по n26/n_all — группа идёт по первой
todo.sort(key=lambda r: order[r["group"]])
take = todo[:a.max]
(run / "batches").mkdir(exist_ok=True); (run / "out").mkdir(exist_ok=True)
for old in (run / "batches").glob("batch_*.json"): old.unlink()
start = len(list(run.glob("out/batch_*.json")))
nb = 0
for i in range(0, len(take), a.size):
    nb += 1; (run / "batches" / f"batch_{start + nb}.json").write_text(json.dumps(take[i:i + a.size], ensure_ascii=False, indent=1), encoding="utf-8")
print(f"пачек: {nb} (номера {start + 1}–{start + nb}), бань: {len(take)}; осталось после хода: {len(todo) - len(take)}")
