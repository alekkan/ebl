#!/usr/bin/env python3
"""Единый каталог, шаг 4: сборка ответов агентов в catalog.json и отчёт report.md (docs/catalog.md).

  python3 scripts/catalog/build.py scripts/catalog/runs/2026-10-19

Индекс уверенности (match) — от агента, плюс сверка: точка сошлась с кандидатом OpenStreetMap (≤150 м) — +5; с нашей точной
или среднеточной (≤300 м) — +5. Корзины: confirm — наша точка подтвердилась; move — точная или среднеточная у нас, а нашли
дальше 300 м; new — у нас примерная, нашли место; notfound; region — регион не сходится с Комиссией; flag — не общественная,
закрыта или на ремонте (это отдельно от точки).
"""
import json, math, sys, pathlib
from collections import Counter
run = pathlib.Path(sys.argv[1])
rows = {r["id"]: r for r in json.loads((run / "input.json").read_text(encoding="utf-8"))}
osm = json.loads((run / "osm.json").read_text(encoding="utf-8")) if (run / "osm.json").exists() else {}
def km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    return 6371 * 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
got = {}
for f in sorted(run.glob("out/batch_*.json")):
    try:
        for r in json.loads(f.read_text(encoding="utf-8")):
            if r.get("id") in rows: got[r["id"]] = r
    except Exception as e: print("не прочитал", f.name, e)
cat = []
for i, b in rows.items():
    a = got.get(i)
    if not a: continue
    e = dict(b); e.pop("radar", None); e.update({k: v for k, v in a.items() if k != "id"})
    ours = (b["lat"], b["lng"]) if b.get("lat") is not None else None
    found = (a["lat"], a["lng"]) if a.get("lat") is not None else None
    m = a.get("match") or 0; why = []
    e["dist_km"] = round(km(ours, found), 2) if ours and found else None
    if found and any(km(found, (c["lat"], c["lng"])) <= 0.15 for c in osm.get(str(i), [])): m += 5; why.append("+5 сошлось с OpenStreetMap")
    if found and ours and b["precision"] in ("exact", "auto") and e["dist_km"] <= 0.3: m += 5; why.append("+5 рядом с нашей точкой")
    e["match_final"] = min(100, m); e["match_adj"] = why
    if a.get("region_conflict"): e["bin"] = "region"
    elif not found: e["bin"] = "notfound"
    elif b["precision"] in ("exact", "auto"): e["bin"] = "confirm" if e["dist_km"] <= 0.3 else "move"
    else: e["bin"] = "new"
    e["flag"] = (a.get("is_public") is False) or a.get("status") in ("closed", "repair")
    cat.append(e)
(run / "catalog.json").write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")
bins = Counter(e["bin"] for e in cat)
hi = sum(1 for e in cat if e["match_final"] >= 70)
names = {"confirm": "точка подтвердилась", "move": "у нас точная/среднеточная — нашли в другом месте", "new": "у нас примерная — нашли место",
         "notfound": "не нашли", "region": "регион не сходится с Комиссией"}
lines = [f"# Единый каталог — прогон {run.name}", "", f"Разобрано {len(cat)} из {len(rows)} общественных бань; уверенно (≥70) — {hi}.", ""]
lines += [f"- {names[k]}: {bins.get(k, 0)}" for k in names]
lines += [f"- не общественная / закрыта / ремонт (отдельно от точки): {sum(1 for e in cat if e['flag'])}",
          f"- с ценой: {sum(1 for e in cat if e.get('price'))}, с мужскими/женскими днями: {sum(1 for e in cat if e.get('gender_days'))}, с сайтом: {sum(1 for e in cat if e.get('website'))}", ""]
# обратный ход (20.10): у нас не общественная, а по факту — общественная
retype = [e for e in cat if e.get("kind_found") == "public" and e.get("type") not in (None, "public")]
if retype:
    lines += [f"## похоже на общественные ({len(retype)})", ""]
    for e in sorted(retype, key=lambda e: -e["n26"]):
        lines.append(f"- **{e['name']}** ({e.get('type')}) — {e.get('found_name') or '—'}, {e.get('address') or ''} · уверенность {e['match_final']} · {e.get('kind_why') or ''}")
    lines.append("")
for k in ("move", "region", "notfound"):
    sel = [e for e in cat if e["bin"] == k]
    if not sel: continue
    lines += [f"## {names[k]}", ""]
    for e in sorted(sel, key=lambda e: -e["n26"]):
        lines.append(f"- **{e['name']}** ({e.get('region') or e.get('country')}) — {e.get('found_name') or '—'}, {e.get('address') or ''}"
                     + (f", {e['dist_km']} км от нашей" if e.get("dist_km") is not None else "") + f" · уверенность {e['match_final']} · {e.get('match_why') or ''}"
                     + (f" · регион в карточке: {e['region_found']}" if k == "region" else ""))
    lines.append("")
(run / "report.md").write_text("\n".join(lines), encoding="utf-8")
print("\n".join(lines[:12]))
