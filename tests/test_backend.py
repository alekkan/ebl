"""Сквозная проверка бэкенда на локальном стенде: вход через Telegram, права (RLS), журнал походов, модерация, пересчёт очков, точки бань.

Перед запуском:  supabase start && supabase db reset && supabase functions serve --env-file supabase/functions/.env
Запуск:          python3 tests/test_backend.py
Тест пишет в локальную базу; после него удобно сделать `supabase db reset`.
"""
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from local import check, link, login, player_id, req, sql, tg_payload

print("Вход через Telegram")
bad = tg_payload(1, "x"); bad["hash"] = "0" * 64
check("поддельная подпись отклоняется", req("POST", "/functions/v1/tg-login", bad)[0] == 401)
check("данные входа старше часа не принимаются",
      req("POST", "/functions/v1/tg-login", tg_payload(1, "x", auth_date=str(int(time.time()) - 2 * 3600)))[0] == 401)
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
# «_» и «%» в ilike — шаблоны: «m_ks1987» не должен войти в заранее вписанный «maks1987»
link("Макс", "maks1987")
r, _ = login(4004, "m_ks1987")
r2, _ = login(4005, "maks198%")
check("username сверяется точно: «_» и «%» не шаблоны, чужой аккаунт не захватить",
      r["nick"] is None and r2["nick"] is None and sql("select tg_id is null from player_accounts where tg_username = 'maks1987'") == "t", (r, r2))

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
with ThreadPoolExecutor(4) as ex:
    runs = list(ex.map(lambda _: req("POST", "/functions/v1/recompute", {}), range(4)))
check("параллельные пересчёты не сталкиваются", all(s == 200 and b["ok"] for s, b in runs), runs)
pts = {p["nick"]: p for p in req("GET", f"/rest/v1/visit_points?visit_id=eq.{vid}&select=nick,total,lines", token=shurik)[1]}
check("очки по регламенту записаны каждому", set(pts) == {"Шурик", "Витёк", "Леха"}, pts)
check("компания из трёх — К у всех", all(any(l[0] == "company" for l in p["lines"]) for p in pts.values()))
check("долгий у всей компании, без фото", all(any(l[0] == "long" for l in p["lines"]) for p in pts.values()))
after = {n: float(sql(f"select total from standings where nick='{n}'")) for n in before}
check("таблица выросла ровно на очки похода", all(abs(after[n] - before[n] - float(pts[n]["total"])) < 0.01 for n in before), (before, after))

print("Журнал: служебные поля и компания")
other = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, status) values (6, '2026-09-26T09:00:00+03', 120, '{leha}', 'ok') returning id").splitlines()[0]
s, _ = req("PATCH", f"/rest/v1/visit_players?visit_id=eq.{vid}&player_id=eq.{me}", {"visit_id": int(other)}, token=shurik)
check("в чужой засчитанный поход себя не переписать", s in (401, 403) and sql(f"select count(*) from visit_players where visit_id = {other}") == "0", s)
sql(f"delete from visits where id = {other}")
s, v = req("POST", "/rest/v1/visits", {"bath_id": 6, "entered_at": "2026-09-26T12:00:00+03", "duration_min": 120, "created_by": me,
           "posted_at": "2026-01-05T12:00:00+03", "source": "bot", "tg_link": "https://t.me/c/1/2", "long_asked_at": "2026-09-26T10:00:00Z"},
           token=shurik, headers={"Prefer": "return=representation"})
fresh = s == 201 and abs(datetime.fromisoformat(v[0]["posted_at"]).timestamp() - time.time()) < 120
check("служебные поля ставит база: время отметки — сейчас, источник — сайт, без ссылки и «Долгая была?»",
      fresh and v[0]["source"] == "site" and v[0]["tg_link"] is None and v[0]["long_asked_at"] is None, v)
if s == 201: sql(f"delete from visits where id = {v[0]['id']}")

print("Поход с сайта одной транзакцией")
future = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
def submit(token, **kw):
    body = {"p_bath_id": None, "p_new_bath": None, "p_bath_type": None, "p_entered_at": "2026-09-26T12:00:00+03:00",
            "p_duration_min": 120, "p_companions": [], **kw}
    return req("POST", "/rest/v1/rpc/submit_visit", body, token=token)
check("без входа нельзя", submit(None, p_bath_id=22)[0] in (401, 403))
s, r = submit(stranger, p_bath_id=22)
check("без привязки к нику нельзя", s >= 400 and "участники лиги" in str(r), r)
check("баня — ровно одна: из справочника или новая", submit(shurik)[0] >= 400 and submit(shurik, p_bath_id=22, p_new_bath={"name": "Баня Х"})[0] >= 400)
check("меньше часа, заход в будущем, не этот сезон — не принимается",
      submit(shurik, p_bath_id=22, p_duration_min=30)[0] >= 400 and submit(shurik, p_bath_id=22, p_entered_at=future)[0] >= 400
      and submit(shurik, p_bath_id=22, p_entered_at="2025-06-01T12:00:00+03:00")[0] >= 400)
submit(shurik, p_new_bath={"name": "Баня-призрак"}, p_duration_min=30)
check("сорвалось — и новой бани не осталось", sql("select count(*) from baths where name = 'Баня-призрак'") == "0")
sql("update baths set type = null where id = 22")
s, r = submit(shurik, p_bath_id=22, p_bath_type="spa", p_companions=[vit, me, vit, "00000000-0000-0000-0000-000000000000"])
check("поход, тип бани и компания — одним вызовом", s == 200 and r.get("bath_id") == 22, (s, r))
v2 = r["visit_id"]
check("компания: автор и Витёк — без повторов и неизвестных id",
      sql(f"select string_agg(p.nick, ',' order by p.nick) from visit_players vp join players p on p.id = vp.player_id where visit_id = {v2}") == "Витёк,Шурик")
check("поход от автора, с сайта, ждёт Комиссию", sql(f"select source || '/' || status || '/' || (created_by = '{me}') from visits where id = {v2}") == "site/pending/true")
check("пустой тип бани заполнен со слов автора", sql("select type from baths where id = 22") == "spa")
s, r = submit(shurik, p_new_bath={"name": "  Тестовая баня на Валдае ", "country": "Россия", "region": "Новгородская обл", "type": "public",
                                  "lat": 57.98, "lng": 33.25, "precision": "exact"})
check("новая баня — на модерации, от автора, с точкой", s == 200 and sql(
    f"select name || '/' || status || '/' || type || '/' || precision || '/' || (created_by = '{me}') from baths where id = {r['bath_id']}")
    == "Тестовая баня на Валдае/pending/public/exact/true", (s, r))
check("пустое название новой бани не принимается", submit(shurik, p_new_bath={"name": "  "})[0] >= 400)
sql(f"delete from visits where id in ({v2}, {r['visit_id']})"); sql(f"delete from baths where id = {r['bath_id']}")

print("Тип бани со слов участника")
sql("update baths set type = null where id = 20"); sql("update baths set type = 'spa' where id = 21")
rpc = lambda bath, t, token: req("POST", "/rest/v1/rpc/suggest_bath_type", {"p_bath": bath, "p_type": t}, token=token)[0]
check("участник размечает баню без типа", rpc(20, "public", shurik) == 204 and sql("select type from baths where id = 20") == "public")
check("размеченный тип участник не меняет", rpc(21, "public", shurik) == 204 and sql("select type from baths where id = 21") == "spa")
check("выдуманный тип не принимается", rpc(20, "banya", shurik) >= 400)
check("без входа нельзя", req("POST", "/rest/v1/rpc/suggest_bath_type", {"p_bath": 20, "p_type": "public"})[0] in (401, 403))
t23 = sql("select coalesce(type, 'null') from baths where id = 23")
sql("update baths set type = null, status = 'rejected' where id = 23")
check("отклонённой бане тип не ставится — ни так, ни с походом",
      rpc(23, "public", shurik) == 204 and submit(shurik, p_bath_id=23, p_bath_type="public")[0] >= 400
      and sql("select coalesce(type, '') from baths where id = 23") == "")
sql(f"update baths set status = 'ok', type = {t23 if t23 == 'null' else repr(t23)} where id = 23")

print("Точки бань")
sql("update baths set precision='region' where id in (10, 11, 12)")
put = lambda bath, inp: req("POST", "/functions/v1/bath-location", {"bath_id": bath, "input": inp}, token=shurik)
check("координаты текстом", put(10, "55.7558, 37.6173") == (200, {"lat": 55.7558, "lng": 37.6173}))
check("ссылка Яндекс Карт", put(11, "https://yandex.ru/maps/?ll=37.6176%2C55.7558&z=16&pt=37.6176,55.7558")[1] == {"lat": 55.7558, "lng": 37.6176})
check("ссылка Google Maps", put(12, "https://www.google.com/maps/place/X/@55.76,37.62,17z/data=!3d55.7640555!4d37.6245285")[1] == {"lat": 55.7640555, "lng": 37.6245285})
check("точную точку участник не перезаписывает", put(10, "55.1111, 37.1111")[0] == 409)
check("без входа нельзя", req("POST", "/functions/v1/bath-location", {"bath_id": 10, "input": "55.7,37.6"})[0] == 401)
sql("update baths set country = null, region = null, precision = 'region' where id = 13")
put(13, "58.6036, 49.6601")   # Киров
check("страна и регион по точке — в написании таблицы (п. 14)", sql("select country || ' / ' || region from baths where id = 13") == "Россия / Кировская обл")
# убираем за собой: иначе следующий прогон упрётся в «одна баня в сутки»
sql(f"delete from visits where id = {vid}")
sql("update settings set value = '40' where key = 'cutover_week'")
req("POST", "/functions/v1/recompute", {})
print("Готово.")
