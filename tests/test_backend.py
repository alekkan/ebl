"""Сквозная проверка бэкенда на локальном стенде: вход через Telegram, права (RLS), журнал походов, модерация, пересчёт очков, точки бань.

Перед запуском:  supabase start && supabase db reset && supabase functions serve --env-file supabase/functions/.env
Запуск:          python3 tests/test_backend.py
Тест пишет в локальную базу; после него удобно сделать `supabase db reset`.
"""
from local import check, link, login, player_id, req, sql, tg_payload

print("Вход через Telegram")
bad = tg_payload(1, "x"); bad["hash"] = "0" * 64
check("поддельная подпись отклоняется", req("POST", "/functions/v1/tg-login", bad)[0] == 401)
r, stranger = login(1001, "stranger")
check("новый человек входит без привязки", r["nick"] is None)
check("журнал ему не виден", req("GET", "/rest/v1/visits?select=id", token=stranger)[1] == [])
check("заявка «это я» принимается", req("POST", "/rest/v1/rpc/claim_nick", {"p_nick": "Леха"}, token=stranger)[0] == 204)
check("отметить поход без привязки нельзя",
      req("POST", "/rest/v1/visits", {"bath_id": 2, "entered_at": "2026-09-26T10:00:00+03", "duration_min": 120, "created_by": player_id("Леха")}, token=stranger)[0] == 403)

link("Шурик", "shurik_tg"); link("Витёк", "vitek_tg")
r, shurik = login(2002, "Shurik_TG")
check("привязка по username, регистр не важен", r["nick"] == "Шурик", r)
r, vitek = login(3003, "vitek_tg")
check("Витёк — Комиссия", sql("select is_commission from players where nick='Витёк'") == "t")

print("Права")
req("POST", "/functions/v1/recompute", {})  # после db reset таблица пустая — считаем её из остатка
me, vit, leha = player_id("Шурик"), player_id("Витёк"), player_id("Леха")
check("аноним видит таблицу", len(req("GET", "/rest/v1/standings?select=nick")[1]) > 0)
s, body = req("GET", "/rest/v1/visits?select=id")
check("аноним не видит журнал", s != 200 or body == [], (s, body))
check("поход от чужого имени запрещён",
      req("POST", "/rest/v1/visits", {"bath_id": 3, "entered_at": "2026-09-26T10:00:00+03", "duration_min": 120, "created_by": vit}, token=shurik)[0] == 403)

print("Поход, модерация и очки")
sql("update settings set value = '39' where key = 'cutover_week'")  # чтобы тестовый поход этой недели считал портал
before = {n: float(sql(f"select total from standings where nick='{n}'") or 0) for n in ("Шурик", "Витёк", "Леха")}
s, v = req("POST", "/rest/v1/visits", {"bath_id": 5, "entered_at": "2026-09-26T12:00:00+03", "duration_min": 180, "created_by": me},
           token=shurik, headers={"Prefer": "return=representation"})
check("Шурик отмечает поход", s == 201, v)
vid = v[0]["id"]
s, _ = req("POST", "/rest/v1/visit_players", [{"visit_id": vid, "player_id": me},
                                              {"visit_id": vid, "player_id": vit}], token=shurik)
check("и компанию", s == 201)
sql(f"insert into visit_players (visit_id, player_id) values ({vid}, '{leha}')")
check("сам засчитать не может", req("PATCH", f"/rest/v1/visits?id=eq.{vid}", {"status": "ok"}, token=shurik, headers={"Prefer": "return=representation"})[1] == [])
check("Комиссия засчитывает", req("PATCH", f"/rest/v1/visits?id=eq.{vid}", {"status": "ok", "moderated_by": vit}, token=vitek,
                                   headers={"Prefer": "return=representation"})[1][0]["status"] == "ok")
check("пересчёт проходит", req("POST", "/functions/v1/recompute", {})[1]["ok"])
pts = {p["nick"]: p for p in req("GET", f"/rest/v1/visit_points?visit_id=eq.{vid}&select=nick,total,lines", token=shurik)[1]}
check("очки по регламенту записаны каждому", set(pts) == {"Шурик", "Витёк", "Леха"}, pts)
check("компания из трёх — К у всех", all(any(l[0] == "company" for l in p["lines"]) for p in pts.values()))
check("долгий у всей компании, без фото", all(any(l[0] == "long" for l in p["lines"]) for p in pts.values()))
after = {n: float(sql(f"select total from standings where nick='{n}'")) for n in before}
check("таблица выросла ровно на очки похода", all(abs(after[n] - before[n] - float(pts[n]["total"])) < 0.01 for n in before), (before, after))

print("Точки бань")
sql("update baths set precision='region' where id in (10, 11, 12)")
put = lambda bath, inp: req("POST", "/functions/v1/bath-location", {"bath_id": bath, "input": inp}, token=shurik)
check("координаты текстом", put(10, "55.7558, 37.6173") == (200, {"lat": 55.7558, "lng": 37.6173}))
check("ссылка Яндекс Карт", put(11, "https://yandex.ru/maps/?ll=37.6176%2C55.7558&z=16&pt=37.6176,55.7558")[1] == {"lat": 55.7558, "lng": 37.6176})
check("ссылка Google Maps", put(12, "https://www.google.com/maps/place/X/@55.76,37.62,17z/data=!3d55.7640555!4d37.6245285")[1] == {"lat": 55.7640555, "lng": 37.6245285})
check("точную точку участник не перезаписывает", put(10, "55.1111, 37.1111")[0] == 409)
check("без входа нельзя", req("POST", "/functions/v1/bath-location", {"bath_id": 10, "input": "55.7,37.6"})[0] == 401)
# убираем за собой: иначе следующий прогон упрётся в «одна баня в сутки»
sql(f"delete from visits where id = {vid}")
sql("update settings set value = '40' where key = 'cutover_week'")
req("POST", "/functions/v1/recompute", {})
print("Готово.")
