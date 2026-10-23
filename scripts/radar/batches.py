#!/usr/bin/env python3
"""Радар, шаг 2: пачки для агентов — вслепую (без типа лиги), сначала самые похожие на общественные.

  python3 scripts/radar/batches.py scripts/radar/runs/2026-10-23 [--prev scripts/radar/runs/2026-10-16/radar.json] [--max 190]

Берёт candidates.json (из collect.py, можно склеить несколько регионов), пропускает места, уже разобранные прошлым прогоном
(в --prev не unknown), и пишет batches/batch_N.json по ~20 мест. --max — сколько мест в этот ход: лимит 200 веб-поисков
за ход на всех агентов, по одному на место. Остальное — следующим ходом (тем же скриптом).
"""
import json, sys, pathlib, argparse

ap = argparse.ArgumentParser()
ap.add_argument("run"); ap.add_argument("--prev"); ap.add_argument("--max", type=int, default=190); ap.add_argument("--size", type=int, default=20)
a = ap.parse_args()
run = pathlib.Path(a.run)
cands = []
for f in sorted(run.glob("candidates*.json")):
    cands += json.loads(f.read_text(encoding="utf-8"))
done = set()
if a.prev:
    done = {p["key"] for p in json.load(open(a.prev, encoding="utf-8")) if p.get("kind") and p["kind"] != "unknown"}
# ответы прошлых ходов — в out/ под своими именами: новые пачки снова batch_1…, и агент перезаписал бы чужой ответ (24.10)
for f in run.glob("out/batch_*.json"):
    n = 1
    while (run / "out" / f"w{n}_{f.name}").exists(): n += 1
    f.rename(run / "out" / f"w{n}_{f.name}")
for f in run.glob("out/*.json"):   # уже разобранное в этом прогоне (прошлым ходом)
    done |= {r.get("key") for r in json.loads(f.read_text(encoding="utf-8"))}   # и «нужен поиск»: в этом прогоне уже искали
todo = [c for c in cands if c["key"] not in done]
# сначала похожее на общественную: «бани», «городская», public_bath, рубрика справочника
prio = lambda c: (c.get("tag") == "public_bath") * 3 + ("бани" in c["name"].lower() or "городск" in c["name"].lower()) * 2 + bool(c.get("rubric_hint"))
todo.sort(key=lambda c: -prio(c))
take = todo[:a.max]
(run / "batches").mkdir(exist_ok=True); (run / "out").mkdir(exist_ok=True)
for old in (run / "batches").glob("batch_*.json"): old.unlink()
n = max(1, -(-len(take) // a.size))
for k in range(n):
    part = [{kk: v for kk, v in c.items() if v not in (None, "") and kk != "league_hint"} for c in take[k::n]]
    (run / "batches" / f"batch_{k + 1}.json").write_text(json.dumps(part, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"к разбору {len(take)} из {len(todo)} (уже разобрано {len(done)}), пачек {n}; осталось на следующий ход: {len(todo) - len(take)}")
