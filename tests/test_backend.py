"""Сквозная проверка бэкенда на локальном стенде: вход через Telegram, права (RLS), журнал походов, модерация, пересчёт очков, точки бань.

Перед запуском:  supabase start && supabase db reset && supabase functions serve --env-file supabase/functions/.env
Запуск:          python3 tests/test_backend.py
Тест пишет в локальную базу; после него удобно сделать `supabase db reset`.
"""
import json, re, urllib.parse, urllib.request, urllib.error, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from local import KEY, check, link, login, now, player_id, req, sql, tg_payload

print("Вход через Telegram")
bad = tg_payload(1, "x"); bad["hash"] = "0" * 64
check("поддельная подпись отклоняется", req("POST", "/functions/v1/tg-login", bad)[0] == 401)
check("данные входа старше часа не принимаются",
      req("POST", "/functions/v1/tg-login", tg_payload(1, "x", auth_date=str(now() - 2 * 3600)))[0] == 401)
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

print("Вход кодом из бота")
MAC = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"}
new_code = lambda: req("POST", "/functions/v1/tg-login?code=new", {}, headers=MAC)[1]
poll = lambda c, secret=None: req("POST", "/functions/v1/tg-login?code=poll", {"code": c["code"], "secret": secret or c["secret"]})
confirm = lambda c, tg_id, username: sql(f"update login_codes set tg_id = {tg_id}, tg_username = '{username}', tg_name = 'Тест', confirmed_at = now() where code = '{c['code']}'")
c = new_code()
check("сайт заводит код: шесть знаков и секрет опроса",
      re.fullmatch(r"[A-Z0-9]{6}", c.get("code", "")) and re.fullmatch(r"[0-9a-f]{64}", c.get("secret", "")), c)
check("в базе — хэш секрета, а не он сам, и откуда входят (бот это покажет)",
      sql(f"select secret_hash <> '{c['secret']}' and device = 'Chrome, Mac' from login_codes where code = '{c['code']}'") == "t")
check("пока в боте не подтвердили — сайт ждёт", poll(c) == (200, {"pending": True}), poll(c))
check("код виден на экране и в QR, но опросить его без секрета нельзя", poll(c, "0" * 64)[0] == 404)
check("коды снаружи не читаются", req("GET", "/rest/v1/login_codes?select=code")[0] in (401, 403))
confirm(c, 2002, "Shurik_TG")
s, r = poll(c)
check("подтвердили в боте — сайт получает сессию того, кто подтвердил",
      s == 200 and r.get("nick") == "Шурик" and req("POST", "/auth/v1/verify", {"type": "magiclink", "token_hash": r.get("token_hash")})[0] == 200, (s, r))
check("второй раз по тому же коду не войти", poll(c)[0] == 410)
c = new_code(); confirm(c, 2002, "Shurik_TG")
with ThreadPoolExecutor(2) as ex:
    both = sorted(ex.map(lambda _: poll(c)[0], range(2)))
check("два опроса разом (вкладка проснулась) — сессию получает только один", both == [200, 410], both)
c = new_code(); sql(f"update login_codes set denied_at = now() where code = '{c['code']}'")
check("«Нет» в боте — сайт перестаёт ждать", poll(c)[0] == 403)
c = new_code(); sql(f"update login_codes set expires_at = now() - interval '1 second' where code = '{c['code']}'")
check("код живёт 10 минут", poll(c)[0] == 410)

print("Права")
req("POST", "/functions/v1/recompute", {})  # после db reset таблица пустая — считаем её из остатка
me, vit, leha = player_id("Шурик"), player_id("Витёк"), player_id("Леха")
check("аноним видит таблицу", len(req("GET", "/rest/v1/standings?select=nick")[1]) > 0)
s, bp = req("GET", "/rest/v1/rpc/boot_public")
check("всё общее для первого экрана — одним запросом и гостю: бани, посещения, таблица, отзывы, цены, пиво, участники",
      s == 200 and isinstance(bp, dict) and set(bp) == {"baths", "counts", "standings", "reviews", "prices", "beer", "players"}
      and len(bp["baths"]) > 100 and len(bp["counts"]) > 100 and len(bp["standings"]) > 0 and len(bp["players"]) > 0, (s, list(bp)[:9] if isinstance(bp, dict) else bp))
check("…отклонённые бани в нём гостю не видны, как и в обычном запросе", all(b["status"] != "rejected" for b in bp["baths"]))
s2, bp2 = req("GET", "/rest/v1/rpc/boot_public?apikey=" + urllib.parse.quote(KEY))
check("…и с ключом в адресе (ранний запрос из index.html, 16.10) — тот же ответ", s2 == 200 and isinstance(bp2, dict) and set(bp2) == set(bp), s2)
s, counts = req("GET", "/rest/v1/rpc/bath_counts_all")
check("посещения бань для карты — одним запросом, все строки представления",
      s == 200 and len(counts) == int(sql("select count(*) from bath_counts")) > 1000, (s, len(counts) if isinstance(counts, list) else counts))
s, body = req("GET", "/rest/v1/visits?select=id")
check("аноним не видит журнал", s != 200 or body == [], (s, body))
check("поход от чужого имени запрещён",
      req("POST", "/rest/v1/visits", {"bath_id": 3, "entered_at": "2026-09-26T10:00:00+03", "duration_min": 120, "created_by": vit}, token=shurik)[0] == 403)

print("Поход, модерация и очки")
sql("update settings set value = '39' where key = 'cutover_week'")  # чтобы тестовый поход этой недели считал портал
# точка отсчёта — свежий пересчёт: прошлые прогоны тестов засчитывали и удаляли походы, не пересчитывая таблицу
req("POST", "/functions/v1/recompute", {})
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
# 18.10: своя длительность участника — Леха ушёл раньше (экспресс), Шурик и Витёк — долгую; компания у всех троих
sql(f"update visit_players set duration_min = 120 where visit_id = {vid} and player_id = '{leha}'")
req("POST", "/functions/v1/recompute", {})
pts2 = {p["nick"]: p for p in req("GET", f"/rest/v1/visit_points?visit_id=eq.{vid}&select=nick,total,lines", token=shurik)[1]}
check("своя длительность: у Лехи экспресс — без +1 за долгий, у Шурика и Витька долгий, компания К у всех",
      not any(l[0] == "long" for l in pts2["Леха"]["lines"]) and all(any(l[0] == "long" for l in pts2[n]["lines"]) for n in ("Шурик", "Витёк"))
      and all(any(l[0] == "company" for l in p["lines"]) for p in pts2.values()), pts2)
row = f"/rest/v1/visit_players?visit_id=eq.{vid}&player_id=eq.{leha}"
s1, r1 = req("PATCH", row, {"duration_min": 180}, token=shurik, headers={"Prefer": "return=representation"})
s2, r2 = req("PATCH", row, {"duration_min": 180}, token=vitek, headers={"Prefer": "return=representation"})
check("длительность участника правит Комиссия, сам участник — нет", (s1 >= 400 or r1 == []) and s2 == 200 and r2 and r2[0]["duration_min"] == 180, (s1, r1, s2, r2))
check("…и только её: перенести участника в другой поход нельзя даже Комиссии",
      req("PATCH", row, {"visit_id": vid + 100000}, token=vitek)[0] >= 400 and req("PATCH", row, {"duration_min": 30}, token=vitek)[0] >= 400)
sql(f"update visit_players set duration_min = null where visit_id = {vid}"); req("POST", "/functions/v1/recompute", {})

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
s, r3 = submit(shurik, p_bath_id=22, p_duration_min=180, p_companions=[vit, leha], p_durations={vit: 120, leha: 180})
check("своя длительность попутчиков с сайта: у Витька экспресс записан, у Лехи — как у похода (пусто)", s == 200 and sql(
    f"select string_agg(p.nick || '=' || coalesce(vp.duration_min::text, '—'), ',' order by p.nick) from visit_players vp join players p on p.id = vp.player_id where visit_id = {r3['visit_id']}")
    == "Витёк=120,Леха=—,Шурик=—", (s, r3))
sql(f"delete from visits where id = {r3['visit_id']}")
s, r = submit(shurik, p_new_bath={"name": "  Тестовая баня на Валдае ", "country": "Россия", "region": "Новгородская обл", "type": "public",
                                  "lat": 57.98, "lng": 33.25, "precision": "exact"})
check("новая баня — на модерации, от автора, с точкой", s == 200 and sql(
    f"select name || '/' || status || '/' || type || '/' || precision || '/' || (created_by = '{me}') from baths where id = {r['bath_id']}")
    == "Тестовая баня на Валдае/pending/public/exact/true", (s, r))
check("пустое название новой бани не принимается", submit(shurik, p_new_bath={"name": "  "})[0] >= 400)
sql(f"delete from visits where id in ({v2}, {r['visit_id']})"); sql(f"delete from baths where id = {r['bath_id']}")

print("Комиссия заводит поход за участника (только на сайте)")
s, r = submit(shurik, p_bath_id=22, p_player=vit)
check("участник за другого — нельзя", s >= 400 and "только Комиссия" in str(r), r)
s, r = submit(vitek, p_bath_id=22, p_player=me, p_entered_at="2026-09-27T12:00:00+03:00", p_companions=[leha])
check("Комиссия заводит поход Шурика, сама в бане не была", s == 200, (s, r))
v3 = r.get("visit_id")
check("поход — Шурика, внёс Витёк, ждёт Комиссию",
      sql(f"select (created_by = '{me}') || '/' || (entered_by = '{vit}') || '/' || status from visits where id = {v3}") == "true/true/pending")
check("в компании Шурик и Леха, Витька нет",
      sql(f"select string_agg(p.nick, ',' order by p.nick) from visit_players vp join players p on p.id = vp.player_id where visit_id = {v3}") == "Леха,Шурик")
s, r = submit(vitek, p_bath_id=22, p_entered_at="2026-09-28T12:00:00+03:00")
v4 = r.get("visit_id")
check("за себя Комиссия — как все, без пометки «внёс»", s == 200 and sql(f"select entered_by is null from visits where id = {v4}") == "t", (s, r))
s, v = req("POST", "/rest/v1/visits", {"bath_id": 22, "entered_at": "2026-09-29T12:00:00+03", "duration_min": 120, "created_by": me, "entered_by": vit},
           token=shurik, headers={"Prefer": "return=representation"})
check("участник не подпишет свой поход «внёс Витёк»", s == 201 and v[0]["entered_by"] is None, (s, v))
sql(f"delete from visits where id in ({v3}, {v4}, {v[0]['id'] if s == 201 else 0})")

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

print("Повтор бани в те же сутки")
# движок сам не срезает (баню часто кидают за прошлый день): засчитала Комиссия оба похода — очки за оба
sql("update settings set value = '39' where key = 'cutover_week'")
sh = player_id("Шурик")
r1 = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, status) values (9, date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow' + interval '10 hours', 120, '{sh}', 'ok') returning id").splitlines()[0]
r2 = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, status) values (9, date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow' + interval '11 hours', 120, '{sh}', 'ok') returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) values ({r1}, '{sh}'), ({r2}, '{sh}')")
req("POST", "/functions/v1/recompute", {})
check("два засчитанных похода в одну баню за сутки — очки за оба (решает Комиссия, не движок)",
      sql(f"select count(*) from visit_points where visit_id in ({r1}, {r2})") == "2")
sql(f"delete from visits where id in ({r1}, {r2})"); sql("update settings set value = '40' where key = 'cutover_week'")
req("POST", "/functions/v1/recompute", {})

print("Новая баня и отказ по походу")
nb = sql("insert into baths (name, status, created_by) select 'Кандидат Боровенка', 'pending', id from players where nick='Шурик' returning id").splitlines()[0]
cv = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by) select {nb}, now() - interval '3 hours', 120, id from players where nick='Шурик' returning id").splitlines()[0]
sql(f"update visits set status = 'rejected' where id = {cv}")
check("отклонили единственный поход в новую баню — баня тоже отклонена", sql(f"select status from baths where id = {nb}") == "rejected")
sql(f"update visits set status = 'pending' where id = {cv}")
check("вернули поход — баня снова ждёт решения", sql(f"select status from baths where id = {nb}") == "pending")
sql(f"update visits set bath_id = 5 where id = {cv}")
check("перенесли поход в другую баню — кандидат без походов отклонён", sql(f"select status from baths where id = {nb}") == "rejected")
check("баня из справочника от отказа не страдает", sql("select status from baths where id = 5") == "ok")
sql(f"delete from visits where id = {cv}"); sql(f"delete from baths where id = {nb}")

print("Цена бани")
price = lambda bath, p, cur, dur, token, weekend=None, before=None: req("POST", "/rest/v1/rpc/submit_bath_price",
    {"p_bath_id": bath, "p_price": p, "p_currency": cur, "p_duration_min": dur, "p_is_weekend": weekend, "p_before_time": before}, token=token)
check("без входа нельзя", price(7, 1000, None, None, None)[0] in (401, 403))
s, r = price(7, 1000, None, None, shurik)
check("первая цена — новая запись, валюта по умолчанию рубль, будни/выходной и время не указаны",
      s == 200 and r is not None and sql(f"select price::int || '/' || currency || '/' || coalesce(is_weekend::text, 'null') || '/' || coalesce(before_time::text, 'null') from bath_prices where id = {r}") == "1000/RUB/null/null", (s, r))
s2, r2 = price(7, 1000, None, None, vitek)
check("та же цена от другого участника — не дублируем", s2 == 200 and r2 is None and sql("select count(*) from bath_prices where bath_id = 7") == "1", (s2, r2))
s3, r3 = price(7, 1200, None, None, shurik)
check("цена изменилась — новая строка, старая осталась (история)", s3 == 200 and r3 is not None and sql("select count(*) from bath_prices where bath_id = 7") == "2", (s3, r3))
s4, r4 = price(7, 1200, "usd", None, shurik)
check("другая валюта — отдельная история, не путается с рублями", s4 == 200 and r4 is not None and sql("select count(*) from bath_prices where bath_id = 7 and currency = 'USD'") == "1", (s4, r4))
s5, r5 = price(7, 1200, None, None, shurik, weekend=True, before="16:00")
check("та же цена, но будни/выходной или время другое — отдельная история, не дубль", s5 == 200 and r5 is not None and sql("select count(*) from bath_prices where bath_id = 7") == "4", (s5, r5))
s6, r6 = price(7, 1200, None, None, shurik, weekend=True, before="16:00")
check("будни/выходной и время совпали — дубль не пишем", s6 == 200 and r6 is None and sql("select count(*) from bath_prices where bath_id = 7") == "4", (s6, r6))
check("цена не больше нуля не принимается", price(7, 0, None, None, shurik)[0] >= 400)
check("время не больше нуля не принимается", price(7, 500, None, 0, shurik)[0] >= 400)
sql("update baths set status = 'rejected' where id = 7")
check("отклонённой бане цену не добавить", price(7, 500, None, None, shurik)[0] >= 400)
sql("update baths set status = 'ok' where id = 7")
sql("delete from bath_prices where bath_id = 7")

print("Цена пива")
beer = lambda bath, p, cur, token: req("POST", "/rest/v1/rpc/submit_beer_price", {"p_bath_id": bath, "p_price": p, "p_currency": cur}, token=token)
check("без входа нельзя", beer(7, 300, None, None)[0] in (401, 403))
s, r = beer(7, 300, None, shurik)
check("первая цена пива — новая запись, валюта по умолчанию рубль", s == 200 and r is not None and sql(f"select price::int || '/' || currency from bath_beer_prices where id = {r}") == "300/RUB", (s, r))
s2, r2 = beer(7, 300, None, vitek)
check("та же цена пива от другого участника — не дублируем", s2 == 200 and r2 is None and sql("select count(*) from bath_beer_prices where bath_id = 7") == "1", (s2, r2))
s3, r3 = beer(7, 350, None, shurik)
check("цена пива изменилась — новая строка, старая осталась (история)", s3 == 200 and r3 is not None and sql("select count(*) from bath_beer_prices where bath_id = 7") == "2", (s3, r3))
s4, r4 = beer(7, 350, "usd", shurik)
check("другая валюта — отдельная история пива, не путается с рублями", s4 == 200 and r4 is not None and sql("select count(*) from bath_beer_prices where bath_id = 7 and currency = 'USD'") == "1", (s4, r4))
check("цена пива не больше нуля не принимается", beer(7, 0, None, shurik)[0] >= 400)
sql("update baths set status = 'rejected' where id = 7")
check("отклонённой бане цену пива не добавить", beer(7, 300, None, shurik)[0] >= 400)
sql("update baths set status = 'ok' where id = 7")
sql("delete from bath_beer_prices where bath_id = 7")

print("Ночной бэкап и восстановление")
dry = req("GET", "/functions/v1/backup?dry=1")[1]
check("бэкап видит все таблицы public и сколько в них строк", dry.get("tables", {}).get("baths") == int(sql("select count(*) from baths")), dry)
# полный круг без Яндекса: копия локальной базы в формате бэкапа → портим данные → scripts/restore-backup.sh <папка> → сверяем
import gzip, json, pathlib, subprocess, tempfile
bk = pathlib.Path(tempfile.mkdtemp())
tables = sql("select string_agg(tablename, ',' order by tablename) from pg_tables where schemaname = 'public'").split(",")
for t in tables:
    data = sql(f'select coalesce(json_agg(x), \'[]\'::json)::text from (select * from public."{t}" order by 1) x')
    (bk / f"public.{t}.json.gz").write_bytes(gzip.compress(data.encode()))
(bk / "manifest.json").write_text(json.dumps({"day": "test", "tables": {t: 0 for t in tables}}))
before_b = sql("select count(*) || '|' || coalesce(max(id), 0) from baths")
sql("delete from player_aliases"); sql("update baths set name = name || ' (испорчено)' where id = 1")
r = subprocess.run(["scripts/restore-backup.sh", str(bk)], capture_output=True, text=True, cwd=pathlib.Path(__file__).resolve().parent.parent)
check("восстановление из копии проходит", r.returncode == 0, r.stderr[-400:])
check("данные вернулись как были", sql("select count(*) || '|' || coalesce(max(id), 0) from baths") == before_b
      and "испорчено" not in sql("select name from baths where id = 1") and int(sql("select count(*) from player_aliases")) >= 3)
nb = sql("insert into baths (name, status) values ('Проверка счётчика', 'pending') returning id").splitlines()[0]
check("счётчик id после восстановления продолжает с максимума", int(nb) > int(before_b.split("|")[1]))
sql(f"delete from baths where id = {nb}")

print("Точки бань")
sql("update baths set precision='region' where id in (10, 11, 12)")
put = lambda bath, inp: req("POST", "/functions/v1/bath-location", {"bath_id": bath, "input": inp}, token=shurik)
check("координаты текстом", put(10, "55.7558, 37.6173") == (200, {"lat": 55.7558, "lng": 37.6173}))
check("ссылка Яндекс Карт", put(11, "https://yandex.ru/maps/?ll=37.6176%2C55.7558&z=16&pt=37.6176,55.7558")[1] == {"lat": 55.7558, "lng": 37.6176})
check("ссылка Google Maps", put(12, "https://www.google.com/maps/place/X/@55.76,37.62,17z/data=!3d55.7640555!4d37.6245285")[1] == {"lat": 55.7640555, "lng": 37.6245285})
# точная уже стоит — участник не перезаписывает, а предлагает Комиссии (Рублевские стояли в Подольске, 14.10)
sql("delete from bath_point_requests where bath_id = 10")
s, r = put(10, "55.1111, 37.1111")
check("точную точку участник не перезаписывает — предлагает Комиссии", s == 202 and r.get("requested") and r.get("km", 0) > 50, (s, r))
check("точка бани прежняя, запрос ждёт Комиссию",
      sql("select round(lat::numeric, 4) from baths where id = 10") == "55.7558"
      and sql("select status || ' ' || source || ' ' || round(old_lat::numeric, 4) from bath_point_requests where bath_id = 10") == "pending site 55.7558")
s, r = put(10, "55.1112, 37.1112")
check("передумал — Комиссия решает по последней точке, прежний запрос снят",
      s == 202 and sql("select count(*) || ' ' || round(max(lat)::numeric, 4) from bath_point_requests where bath_id = 10") == "1 55.1112", (s, r))
s, r = put(10, "55.7560, 37.6174")
check("та же точка (до 100 м) — нового запроса нет", s == 200 and r.get("same") and sql("select count(*) from bath_point_requests where bath_id = 10") == "1", (s, r))
check("Комиссия переносит точную точку сама", req("POST", "/functions/v1/bath-location", {"bath_id": 10, "input": "55.7600, 37.6200"}, token=vitek)[0] == 200
      and sql("select round(lat::numeric, 4) from baths where id = 10") == "55.7600")
sql("delete from bath_point_requests where bath_id = 10")
check("без входа нельзя", req("POST", "/functions/v1/bath-location", {"bath_id": 10, "input": "55.7,37.6"})[0] == 401)
sql("update baths set country = null, region = null, precision = 'region' where id = 13")
# страну и регион функция спрашивает у геокодера OSM — на стенде это заглушка (tests/stub.py) с ответом настоящего Nominatim
put(13, "58.6036, 49.6601")   # Киров
check("страна и регион по точке — в написании таблицы (п. 14)", sql("select country || ' / ' || region from baths where id = 13") == "Россия / Кировская обл",
      sql("select country || ' / ' || region from baths where id = 13"))
# настоящий геокодер отвечает так же, как заглушка? Это проверка чужого сервиса по сети: сети нет или он ограничил частые
# запросы (429) — честно пропускаем с пометкой, а не валим весь набор
try:
    osm = urllib.request.urlopen(urllib.request.Request("https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=58.6036&lon=49.6601&zoom=5&accept-language=ru",
                                                        headers={"User-Agent": "ebl-tests"}), timeout=8)
    real = json.loads(osm.read()).get("address", {})
    check("[сеть] настоящий геокодер OSM отвечает как заглушка тестов: «Кировская область», «Россия»",
          (real.get("state"), real.get("country")) == ("Кировская область", "Россия"), real)
except (urllib.error.URLError, OSError, ValueError) as e:
    print(f"  – пропущено [сеть]: настоящий геокодер OSM сейчас недоступен ({getattr(e, 'code', None) or getattr(e, 'reason', None) or e})")
print("Фото с сайта")
# браузер получает места под фото и одноразовые ссылки, кладёт файлы прямо в бакет (здесь — заглушка), потом просит показать
ph = lambda what, body, token=None: req("POST", f"/functions/v1/photos?{what}", body, token=token)
one = {"visit_id": vid, "files": [{"w": 800, "h": 600}]}
check("без входа фото не добавить", ph("upload", one)[0] == 401)
check("вошедшему, но не участнику лиги — тоже", ph("upload", one, stranger)[0] == 401)
ov = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by) values (5, now() - interval '3 days', 120, '{vit}') returning id").split()[0]
check("в чужой поход — нельзя", ph("upload", {**one, "visit_id": int(ov)}, shurik)[0] == 403)
sql(f"delete from visits where id = {ov}")
check("без размеров — нельзя", ph("upload", {**one, "files": [{"w": 0, "h": 600}]}, shurik)[0] == 400)
s, r = ph("upload", {"visit_id": vid, "files": [{"w": 1600, "h": 1200}, {"w": 1200, "h": 1600}]}, shurik)
check("участник похода получает места под фото и одноразовые ссылки на запись",
      s == 200 and len(r.get("photos", [])) == 2 and all("X-Amz-Signature=" in p["put"] and "X-Amz-Expires=900" in p["put_s"] for p in r["photos"]), (s, r))
check("пока файлы не легли — фото не видно", sql(f"select count(*) from visit_photos where visit_id = {vid} and ready") == "0")
p0, p1 = r["photos"]
for u in (p0["put"], p0["put_s"]):   # функции видят заглушку как host.docker.internal, тесты — как 127.0.0.1
    urllib.request.urlopen(urllib.request.Request(u.replace("host.docker.internal", "127.0.0.1"), data=b"\xff\xd8x\xff\xd9", method="PUT",
                                                  headers={"Content-Type": "image/jpeg", "Cache-Control": r["cache"]}))
check("чужое фото «готовым» не пометить", ph("done", {"ids": [p0["id"]]}, vitek)[1].get("ready") == [])
s, d = ph("done", {"ids": [p0["id"], p1["id"]]}, shurik)
check("показано только фото, у которого легли оба файла", s == 200 and d.get("ready") == [p0["id"]], (s, d))
check("и только оно видно участникам", sql(f"select string_agg(id::text, ',') from visit_photos where visit_id = {vid} and ready") == str(p0["id"]))
sql(f"delete from visit_photos where visit_id = {vid}")

# убираем за собой: иначе следующий прогон упрётся в «одна баня в сутки»
sql(f"delete from visits where id = {vid}")
sql("update settings set value = '40' where key = 'cutover_week'")
req("POST", "/functions/v1/recompute", {})

print("Радар — только Комиссии")
import subprocess, tempfile, pathlib
sql("delete from radar_places where key like 'test:%'")
places = [{"key": "test:1", "name": "Тестовые бани", "region": "Московская обл", "city": "Тестово", "lat": 55.9, "lng": 37.9, "kind": "public",
           "public_index": 92, "confidence": "high", "note": "Билет на сеанс, мужские и женские дни", "evidence": [{"quote": "Мужской день — суббота", "url": "https://example.org"}]}]
def push(pl):
    with tempfile.TemporaryDirectory() as d:
        f = pathlib.Path(d, "radar.json"); f.write_text(json.dumps(pl, ensure_ascii=False))
        out = subprocess.run(["python3", "scripts/radar/push.py", str(f)], capture_output=True, text=True, check=True).stdout
    r = subprocess.run(["docker", "exec", "-i", "supabase_db_ebl", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], input=out, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
push(places)
rid = int(sql("select id from radar_places where key = 'test:1'"))
check("заливка прогона (scripts/radar/push.py) кладёт место в радар", sql(f"select kind || ' ' || public_index from radar_places where id = {rid}") == "public 92")
check("гость радар не видит", req("GET", "/rest/v1/radar_places?select=id")[0] in (401, 403))
check("участник радар не видит", req("GET", "/rest/v1/radar_places?select=id", token=shurik)[1] == [])
check("Комиссия радар видит", any(x["id"] == rid for x in req("GET", "/rest/v1/radar_places?select=id", token=vitek)[1]))
check("участник решать по радару не может", req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid, "p_action": "add"}, token=shurik)[0] >= 400)
s, bid = req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid, "p_action": "add"}, token=vitek)
check("Комиссия: «В лигу» — общественная баня с точной точкой", s == 200 and sql(f"select type || ',' || precision || ',' || status from baths where id = {bid}") == "public,exact,ok", (s, bid))
check("второе нажатие «В лигу» — та же баня, без дубля", req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid, "p_action": "add"}, token=vitek)[1] == bid)
places[0]["public_index"] = 95; push(places)
check("повторная заливка обновляет место, но решение Комиссии не трогает",
      sql(f"select public_index || ' ' || status || ' ' || bath_id from radar_places where id = {rid}") == f"95 added {bid}")
req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid, "p_action": "hide", "p_reason": "rental"}, token=vitek)
check("«Скрыть» с причиной и «вернуть»", sql(f"select status || ' ' || hide_reason from radar_places where id = {rid}") == "hidden rental"
      and req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid, "p_action": "reopen"}, token=vitek)[0] == 200 and sql(f"select status from radar_places where id = {rid}") == "new")
places2 = [{"key": "test:2", "name": "Тестовые термы", "region": "Москва", "lat": 55.7, "lng": 37.5, "kind": "spa", "public_index": 20}]
push(places2)
rid2 = int(sql("select id from radar_places where key = 'test:2'"))
s, bid3 = req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid2, "p_action": "add", "p_type": "spa"}, token=vitek)
check("«Завести» с выбранным типом — хуитнес", s == 200 and sql(f"select type from baths where id = {bid3}") == "spa", (s, bid3))
check("неизвестный тип не проходит", req("POST", "/rest/v1/rpc/radar_decide", {"p_id": rid2, "p_action": "add", "p_type": "дача"}, token=vitek)[0] >= 400
      or sql(f"select bath_id from radar_places where id = {rid2}") == str(bid3))
sql("delete from radar_places where key like 'test:%'"); sql(f"delete from baths where id in ({bid}, {bid3})")

print("Сверка каталога — только Комиссии")
sql("delete from catalog_proposals where run = 'test-run'")
b1 = int(sql("insert into baths (name, type, lat, lng, precision, status, country, region) values ('Тестовые бани сверки', 'public', 55.0, 37.0, 'city', 'ok', 'Россия', 'Москва') returning id").splitlines()[0])
b2 = int(sql("insert into baths (name, type, lat, lng, precision, status, country, region) values ('Тестовые бани сверки 2', 'public', 55.5, 37.5, 'exact', 'ok', 'Россия', 'Москва') returning id").splitlines()[0])
found = [{"id": b1, "found_name": "Тестовые бани", "address": "ул. Пара, 1", "lat": 55.01, "lng": 37.01, "point_src": "2gis", "match": 93, "match_final": 95,
          "bin": "new", "status": "open", "is_public": True, "price": "1000 ₽", "sections": ["общее"], "amenities": ["купель"],
          "evidence": [{"quote": "Мужской день — суббота", "url": "https://example.org"}]},
         {"id": b2, "found_name": "Тестовые бани 2", "lat": 55.5005, "lng": 37.5005, "point_src": "osm", "match": 92, "bin": "confirm", "status": "open"},
         {"id": 999999999, "found_name": "Удалённая баня", "match": 90}]
def push_cat(rows):
    with tempfile.TemporaryDirectory() as d:
        run = pathlib.Path(d, "test-run"); run.mkdir(); (run / "catalog.json").write_text(json.dumps(rows, ensure_ascii=False))
        out = subprocess.run(["python3", "scripts/catalog/push.py", str(run)], capture_output=True, text=True, check=True).stdout
    r = subprocess.run(["docker", "exec", "-i", "supabase_db_ebl", "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1"], input=out, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
push_cat(found)
p1, p2 = (int(sql(f"select id from catalog_proposals where run = 'test-run' and bath_id = {b}")) for b in (b1, b2))
check("заливка прогона (scripts/catalog/push.py) кладёт предложения; удалённую баню пропускает",
      sql("select count(*) from catalog_proposals where run = 'test-run'") == "2" and sql(f"select match || ' ' || place_status || ' ' || (evidence->0->>'quote') from catalog_proposals where id = {p1}") == "95 open Мужской день — суббота")
check("гость сверку не видит", req("GET", "/rest/v1/catalog_proposals?select=id")[0] in (401, 403))
check("участник сверку не видит", req("GET", "/rest/v1/catalog_proposals?select=id", token=shurik)[1] == [])
check("Комиссия сверку видит", {x["id"] for x in req("GET", "/rest/v1/catalog_proposals?select=id&run=eq.test-run", token=vitek)[1]} == {p1, p2})
check("участник решать по сверке не может", req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p1], "p_action": "accept"}, token=shurik)[0] >= 400
      and sql(f"select status from catalog_proposals where id = {p1}") == "new")
s, n = req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p1, p2], "p_action": "accept"}, token=vitek)
check("«Принять» пачкой: примерная точка становится найденной точной, нашу точную рядом не двигаем",
      s == 200 and n == 2 and sql(f"select lat || ' ' || lng || ' ' || precision from baths where id = {b1}") == "55.01 37.01 exact"
      and sql(f"select lat || ' ' || precision from baths where id = {b2}") == "55.5 exact", (s, n))
check("повторное «Принять» по решённому ничего не делает", req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p1, p2], "p_action": "accept"}, token=vitek)[1] == 0)
found[0]["price"] = "1200 ₽"; push_cat(found)
check("повторная заливка обновляет данные, но решение Комиссии не трогает",
      sql(f"select price || ' ' || status from catalog_proposals where id = {p1}") == "1200 ₽ accepted")
req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p1], "p_action": "reopen"}, token=vitek)
check("«Вернуть» после «Принять» — прежняя точка и точность", sql(f"select lat || ' ' || precision from baths where id = {b1}") == "55 city"
      and sql(f"select status from catalog_proposals where id = {p1}") == "new")
req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p1], "p_action": "reject", "p_reason": "closed"}, token=vitek)
req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p2], "p_action": "reopen"}, token=vitek)
req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p2], "p_action": "keep"}, token=vitek)
check("«Отклонить» с причиной и «Оставить нашу точку» — точки не трогают",
      sql(f"select status || ' ' || reject_reason from catalog_proposals where id = {p1}") == "rejected closed"
      and sql(f"select status from catalog_proposals where id = {p2}") == "kept" and sql(f"select lat || ' ' || precision from baths where id = {b1}") == "55 city")
check("неизвестное действие не проходит", req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p1], "p_action": "delete"}, token=vitek)[0] >= 400)
check("«О бане» всем: гостю — принятое (данные и ссылки), без заметок агентов и цитат",
      (lambda f: f and f.get("address") is None and f.get("run") == "test-run" and "note" not in f and "evidence" not in f)(req("POST", "/rest/v1/rpc/bath_facts", {"p_bath": b2})[1]))
check("непринятое и отклонённое гостю не видно", req("POST", "/rest/v1/rpc/bath_facts", {"p_bath": b1})[1] is None)
# обратный ход (20.10): у нас хуитнес, по факту — общественная; «Сделать общественной» и «Вернуть»
b3 = int(sql("insert into baths (name, type, lat, lng, precision, status, country, region) values ('Тестовый хуитнес сверки', 'spa', 55.2, 37.2, 'city', 'ok', 'Россия', 'Москва') returning id").splitlines()[0])
push_cat([{"id": b3, "found_name": "Тестовые бани", "lat": 55.21, "lng": 37.21, "point_src": "2gis", "match": 92, "bin": "new", "status": "open",
           "kind_found": "public", "kind_why": "билет 800 ₽ на человека, общее мужское отделение"}])
p3 = int(sql(f"select id from catalog_proposals where run = 'test-run' and bath_id = {b3}"))
check("заливка кладёт тип по факту и почему", sql(f"select kind_found || ' | ' || kind_why from catalog_proposals where id = {p3}") == "public | билет 800 ₽ на человека, общее мужское отделение")
s, n = req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p3], "p_action": "retype"}, token=vitek)
check("«Сделать общественной» — тип бани общественная, точка найденная точная", s == 200 and n == 1
      and sql(f"select type || ' ' || lat || ' ' || precision from baths where id = {b3}") == "public 55.21 exact", (s, n))
req("POST", "/rest/v1/rpc/catalog_decide", {"p_ids": [p3], "p_action": "reopen"}, token=vitek)
check("«Вернуть» после «Сделать общественной» — прежние тип и точка", sql(f"select type || ' ' || lat || ' ' || precision from baths where id = {b3}") == "spa 55.2 city")
sql(f"update baths set type = 'private' where id = {b2}")
check("у частной бани данные агентов всем не показываем (может быть чьей-то дачей)", req("POST", "/rest/v1/rpc/bath_facts", {"p_bath": b2})[1] is None)
sql(f"delete from baths where id = {b3}")
sql(f"delete from baths where id in ({b1}, {b2})")
check("баню удалили — её предложения уходят вместе с ней", sql("select count(*) from catalog_proposals where run = 'test-run'") == "0")

print("Закрытая баня")
bc = int(sql("insert into baths (name, type, lat, lng, precision, status, country, region) values ('Тестовая закрытая баня', 'public', 55.1, 37.1, 'exact', 'ok', 'Россия', 'Москва') returning id").splitlines()[0])
req("PATCH", f"/rest/v1/baths?id=eq.{bc}", {"closed_on": "2026-09-01"}, token=shurik)
check("участник баню закрытой не отметит", sql(f"select coalesce(closed_on::text, '') from baths where id = {bc}") == "")
s, _ = req("PATCH", f"/rest/v1/baths?id=eq.{bc}", {"closed_on": "2026-09-01"}, token=vitek)
check("Комиссия отмечает «закрыта» месяцем — баня остаётся в лиге, в общих данных с датой",
      s in (200, 204) and any(b["id"] == bc and b["closed_on"] == "2026-09-01" for b in req("POST", "/rest/v1/rpc/baths_all", {})[1]), s)
sql(f"delete from baths where id = {bc}")
print("Готово.")
