"""Выгрузка данных из Google-таблицы ЕБЛ (xlsx) в JSON для прототипа."""
import json, re, openpyxl, pathlib
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT.parent / "prototype" / "data"
wb = openpyxl.load_workbook(ROOT / "ebl.xlsx", data_only=True)

TYPES = {"Общественная": "public", "Частная": "private", "Хуитнес/аквапарк/спа": "spa"}
norm = lambda s: re.sub(r"\s+", " ", str(s)).strip().lower()

# --- история прошлых сезонов: сопоставляем названия со справочником текущего сезона ---
from matcher import Matcher
catalog_rows = [r for r in wb["все бани"].iter_rows(min_row=8, values_only=True) if r[2]]
matcher = Matcher([(str(r[2]).strip(), r[1], r[0]) for r in catalog_rows])
SKIP = {"Компания", "Долгая (>2,5ч)", "Ультра Уникальные", "Уникальные", "Региональная", "Общественная"}
bath_type, history, history_by = {}, defaultdict(dict), defaultdict(dict)
unmatched = defaultdict(int)
for year, sheet, hdr_row in [(2023, "2023 все бани", 2), (2024, "2024 все бани", 4), (2025, "2025 все бани", 1)]:
    ws = wb[sheet]
    names = [str(c.value).strip() if c.value else None for c in ws[hdr_row]][2:]
    cur_type = None
    for row in ws.iter_rows(min_row=hdr_row + 1, values_only=True):
        name = row[1]
        if row[0] in TYPES: cur_type = TYPES[row[0]]
        if not name or isinstance(name, (int, float)) or str(name) in SKIP: continue
        by = {}
        for p, v in zip(names, row[2:]):
            if p and isinstance(v, (int, float)) and v: by[p] = by.get(p, 0) + int(v)
        target = matcher.match(name)
        if not target:
            unmatched[year] += sum(by.values()); continue
        if cur_type and year != 2025: bath_type.setdefault(target, cur_type)
        if by:
            history[target][year] = history[target].get(year, 0) + sum(by.values())
            acc = history_by[target].setdefault(year, {})
            for p, n in by.items(): acc[p] = acc.get(p, 0) + n

# --- справочник бань текущего сезона ---
ws = wb["все бани"]
players = [str(c.value).strip() for c in ws[1][3:] if c.value]
baths = []
for i, row in enumerate(ws.iter_rows(min_row=8, values_only=True)):
    if not row[2]: continue
    country, region, name = row[0], row[1], str(row[2]).strip()
    t = bath_type.get(name)
    if country in TYPES:
        t, country = t or TYPES[country], None
    if country == "Тип": continue
    low = name.lower()
    if not t and low.startswith("частн"): t = "private"
    if not t and ("хуитнес" in low or "аквапарк" in low or " spa" in low or "спа" in low.split()): t = "spa"
    visits = {players[j]: int(v) for j, v in enumerate(row[3:3 + len(players)]) if isinstance(v, (int, float)) and v}
    baths.append({"id": len(baths) + 1, "name": name, "country": country, "region": region,
                  "type": t, "v26": visits, "hist": history.get(name, {}), "histBy": history_by.get(name, {})})

# --- общий и недельный зачёт ---
ws = wb["Общий зачет"]
hdr = [c.value for c in ws[1]]
wk_cols = [(i, int(h[1:])) for i, h in enumerate(hdr) if isinstance(h, str) and re.fullmatch(r"W\d+", h)]
standings = []
for row in ws.iter_rows(min_row=2, values_only=True):
    if not row[0] or not isinstance(row[1], (int, float)): continue
    standings.append({"name": str(row[0]).strip(), "total": round(row[1], 2), "baths": row[2], "u": row[3], "uu": row[4],
                      "long": row[5], "k": row[6], "pub": row[7], "reg": row[8],
                      "weekPts": {w: round(row[i], 2) for i, w in wk_cols if isinstance(row[i], (int, float))}})
ws = wb["недельный зачет"]
hdr = [c.value for c in ws[2]]
# недели в шапке идут подряд по убыванию; бывают опечатки (у W13 в таблице записано «11») — номер берём по соседу слева
wk_cols, prev = [], None
for i, h in enumerate(hdr):
    if i < 2 or h is None: continue
    m = re.fullmatch(r"W(\d+)", str(h).strip())
    w = int(m.group(1)) if m else (prev - 1 if prev else None)
    if w: wk_cols.append((i, w)); prev = w
week_baths = {}
for row in ws.iter_rows(min_row=3, values_only=True):
    if not row[0]: continue
    week_baths[str(row[0]).strip()] = {w: int(row[i]) for i, w in wk_cols if isinstance(row[i], (int, float))}
for s in standings: s["weekBaths"] = week_baths.get(s["name"], {})

OUT.mkdir(parents=True, exist_ok=True)
(OUT / "baths.json").write_text(json.dumps(baths, ensure_ascii=False))
(OUT / "standings.json").write_text(json.dumps(standings, ensure_ascii=False))
print(len(baths), "baths;", sum(1 for b in baths if b["type"]), "typed;", sum(1 for b in baths if b["v26"]), "visited 2026;",
      sum(1 for b in baths if b["hist"]), "with history;", len(standings), "players; unmatched visits", dict(unmatched))
