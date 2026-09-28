"""Собирает supabase/seed.sql из выгрузки таблицы (prototype/data/*.json).

Запуск: python3 scripts/extract.py && python3 scripts/seed.py
Остаток 2026 года (legacy_visits за 2026 и legacy_standings) — всё, что Комиссия внесла в таблицу.
Неделя перехода (cutover_week) — общая: бани из таблицы и из журнала портала складываются, места за неё считает портал.
Поэтому после выгрузки в таблицу больше ничего не вносим — только через бота и сайт, иначе поход посчитается дважды.
id бани — номер строки в таблице: перед заливкой сверь, что строки не сдвинулись (см. docs/operations.md).
"""
import json, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "prototype" / "data"
CUTOVER_WEEK = 39          # портал считает с W39 (решение лиги 26.09.2026): её бани из таблицы + журнал портала
COMMISSION = ["Витёк", "Леха"]   # Комиссия ЕБЛ: Виктор Кудрявцев ведёт таблицу, Леха — портал

baths = json.loads((DATA / "baths.json").read_text())
coords = json.loads((DATA / "coords.json").read_text())
standings = json.loads((DATA / "standings.json").read_text())

q = lambda v: "null" if v is None or v == "" else "'" + str(v).replace("'", "''") + "'"
num = lambda v: "null" if v is None else repr(float(v)) if isinstance(v, float) else str(v)
js = lambda v: q(json.dumps(v, ensure_ascii=False)) + "::jsonb"

out = ["-- Сгенерировано scripts/seed.py — не править руками.", "begin;", ""]

out.append("insert into public.players (nick) values")
out.append(",\n".join(f"  ({q(s['name'])})" for s in standings) + "\non conflict (nick) do nothing;")
out.append(f"update public.players set is_commission = true where nick in ({', '.join(q(n) for n in COMMISSION)});\n")

# клички от Комиссии (см. 20260927110000_player_aliases.sql) — миграция сама их не заводит: она идёт до seed.sql,
# когда players ещё пуст, поэтому join с players там ничего не находит. Заводим здесь же, где players уже есть.
ALIASES = [("Мамонтов", "Ден"), ("Демон", "Фил"), ("Уважаемый", "Шурик")]
out.append("insert into public.player_aliases (alias, player_id)")
out.append("select a.alias, p.id from (values " + ", ".join(f"({q(alias)}, {q(nick)})" for alias, nick in ALIASES) + ") a(alias, nick)")
out.append("join public.players p on p.nick = a.nick")
out.append("on conflict do nothing;\n")

rows = []
for b in baths:
    c = coords.get(str(b["id"]))
    lat, lng, prec = (c if c else (None, None, None))
    rows.append(f"  ({b['id']}, {q(b['name'])}, {q(b['type'])}, {q(b['country'])}, {q(b['region'])}, {num(lat)}, {num(lng)}, {q(prec)})")
out.append("insert into public.baths (id, name, type, country, region, lat, lng, precision) overriding system value values")
out.append(",\n".join(rows) + "\non conflict (id) do nothing;")
out.append("select setval(pg_get_serial_sequence('public.baths', 'id'), (select max(id) from public.baths));\n")

lv = []
for b in baths:
    for nick, n in b["v26"].items():
        lv.append(f"  ({b['id']}, 2026, {q(nick)}, {n})")
    for year, by in b.get("histBy", {}).items():
        for nick, n in by.items():
            lv.append(f"  ({b['id']}, {int(year)}, {q(nick)}, {n})")
out.append("insert into public.legacy_visits (bath_id, year, nick, n) values")
out.append(",\n".join(lv) + "\non conflict (bath_id, year, nick) do update set n = excluded.n;\n")

ls = []
for s in standings:
    wp = {str(w): v for w, v in s["weekPts"].items() if int(w) < CUTOVER_WEEK}
    wb = {str(w): v for w, v in s["weekBaths"].items() if int(w) <= CUTOVER_WEEK}   # бани недели перехода — в общий зачёт недели
    ls.append(f"  ({q(s['name'])}, {num(s['total'])}, {num(s['baths'])}, {num(s['u'])}, {num(s['uu'])}, {num(s['long'])}, "
              f"{num(s['k'])}, {num(s['pub'])}, {num(s['reg'])}, {js(wp)}, {js(wb)})")
out.append("insert into public.legacy_standings (nick, total, baths, u, uu, long, k, pub, reg, week_pts, week_baths) values")
out.append(",\n".join(ls) + "\non conflict (nick) do update set total = excluded.total, baths = excluded.baths, u = excluded.u, uu = excluded.uu,\n"
           "  long = excluded.long, k = excluded.k, pub = excluded.pub, reg = excluded.reg, week_pts = excluded.week_pts, week_baths = excluded.week_baths;\n")

out.append("insert into public.settings (key, value) values")
out.append(f"  ('season', '2026'), ('cutover_week', '{CUTOVER_WEEK}')")
out.append("on conflict (key) do update set value = excluded.value;\n")
out.append("commit;")

(ROOT / "supabase" / "seed.sql").write_text("\n".join(out) + "\n")
print(f"seed.sql: {len(standings)} players, {len(baths)} baths, {len(lv)} legacy visit rows")
