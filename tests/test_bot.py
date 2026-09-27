"""Проверка разбора постов ботом на локальном стенде: время, компания, баня, УУ, ответы только на отметку.

До Telegram локально ничего не доходит (токен фейковый) — проверяем черновик, который бот сохраняет в bot_sessions.
Перед запуском: supabase start && supabase db reset && supabase functions serve --env-file supabase/functions/.env
Запуск: python3 tests/test_bot.py
"""
import json, re, time
from concurrent.futures import ThreadPoolExecutor
from local import WEBHOOK_SECRET, check, req, sql

CHAT, ME = -1001234567890, 900
sql("delete from bot_sessions")
sql(f"delete from player_accounts where tg_id in ({ME}, 901)")
sql(f"insert into player_accounts (player_id, tg_id, tg_username) select id, {ME}, 'lekha_tg' from players where nick='Леха'")
sql("insert into player_accounts (player_id, tg_id, tg_username) select id, 901, 'den_tg' from players where nick='Ден'")


def post(text, mid, who=ME, chat=CHAT, chat_type="supergroup"):
    ents = [{"type": "mention", "offset": m.start(), "length": len(m.group())} for m in re.finditer(r"@\w+", text)]
    update = {"update_id": mid, "message": {"message_id": mid, "date": int(time.time()), "chat": {"id": chat, "type": chat_type},
              "from": {"id": who, "is_bot": False, "first_name": "Alexey"}, "text": text, "entities": ents}}
    s, _ = req("POST", "/functions/v1/tg-bot", update, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    assert s == 200, s
    st = sql(f"select state from bot_sessions where tg_id = {who}")
    return json.loads(st) if st else None


def card(data, who=ME, chat=CHAT, chat_type="supergroup", cid="c"):
    """Кнопка на карточке черновика. Локально Telegram не отвечает, у черновика нет id карточки — жмём «на неё же» (без message_id)."""
    upd = {"update_id": 3000, "callback_query": {"id": cid, "from": {"id": who, "is_bot": False, "first_name": "X"}, "data": data,
           "message": {"chat": {"id": chat, "type": chat_type}, "text": "карточка"}}}
    s, _ = req("POST", "/functions/v1/tg-bot", upd, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    assert s == 200, s


def nicks(ids):
    return set(sql("select coalesce(string_agg(nick, ','), '') from players where id::text in (" + ",".join(f"'{i}'" for i in ids) + ")").split(",")) - {""} if ids else set()


def case(text, mid):
    sql("delete from bot_sessions")
    return post(text, mid)


print("Разбор постов")
st = case("@eblsu_bot Сандуны 3ч с Деном и Шуриком", 1)
check("время и компания в падежах", st["dur"] == 180 and nicks(st["company"]) == {"Ден", "Шурик"}, st)
check("несколько «Сандунов» — бот уточняет", not st.get("bathId") and len(st["candidates"]) > 1 and st["query"] == "Сандуны", st)
st = case("@eblsu_bot зашли в Василевские с 18:00 до 21:30 с @den_tg", 2)
check("интервал времени и @username", st["dur"] == 210 and st["start"] == 18 * 60 and nicks(st["company"]) == {"Ден"}, st)
check("однозначная баня выбрана сразу", st.get("bathName") == "Василевские", st)
st = case("@eblsu_bot полтора часа в Дружбе с Денисом", 3)
check("«полтора часа», «с Денисом» — это Денис, а не Ден", st["dur"] == 90 and nicks(st["company"]) == {"Денис"}, st)
check("падеж бани: «в Дружбе» → Дружба", any("Дружба" in c["name"] for c in st["candidates"]), st)
st = case("@eblsu_bot Краснохолмские УУ", 4)
check("УУ и ничего похожего — сразу новая баня", st.get("newBath") == "Краснохолмские" and st["ultra"], st)
st = case("@eblsu_bot Банька у Петровича на Валдае", 5)
check("не нашёл и УУ не указана — спросит, новая ли", not st.get("newBath") and not st["candidates"] and st["query"], st)
st = case("@eblsu_bot Василевские https://yandex.ru/maps/?pt=37.6176,55.7558&z=16", 6)
check("ссылка на карту в посте даёт точку и не мешает поиску", st.get("geo") == {"lat": 55.7558, "lng": 37.6176} and st.get("bathName") == "Василевские", st)
st = case("@eblsu_bot сегодня в Дружбе с 19 до 22", 8)
check("«с 19 до 22» — три часа, заход в 19:00", st["dur"] == 180 and st.get("start") == 19 * 60, st)
st = case("@eblsu_bot частная баня у Пингвина уу", 9)
check("«частная» — это тип, а не часть названия", st.get("type") == "private" and "частн" not in (st.get("query") or "").lower(), st)
st = case("@eblsu_bot Сандуны с Витьком, Королём, Пашкой и Серёгой", 10)
check("«Витьком», «Королём», «Пашкой», «Серёгой» — падежи ников", nicks(st["company"]) == {"Витёк", "Король", "Пашок", "Серёга"}, st)
sql("delete from bot_sessions")
st = post("@eblsu_bot Сандуны 2ч с Лехой", 11, who=901)
check("«с Лехой» — Леха (пишет Ден)", nicks(st["company"]) == {"Леха"}, st)
sql("delete from bot_sessions")
st = case("@eblsu_bot Сандуны 2ч. День длинный, по дороге десять минут стояли, данные потом, фильм, Виталий, пашня", 12)
check("обычные слова — не ники: день, дороге, десять, данные, фильм, Виталий, пашня", nicks(st["company"]) == set(), st)
st = case("@eblsu_bot Сандуны 2ч с @lekha_tg и @den_tg", 13)
check("автор, отметивший сам себя, в компанию не попадает", nicks(st["company"]) == {"Ден"}, st)
sql("delete from bot_sessions")
check("сообщения без отметки бота игнорируются", post("просто болтаем про Сандуны", 7) is None)


def press(data, who, mid=50):
    update = {"update_id": 1000 + mid, "callback_query": {"id": str(mid), "from": {"id": who, "is_bot": False, "first_name": "X"}, "data": data,
              "message": {"message_id": mid, "chat": {"id": CHAT, "type": "supergroup"}, "text": "⏳ прошло 2,5 часа. Долгая была?"}}}
    s, _ = req("POST", "/functions/v1/tg-bot", update, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    assert s == 200, s


print("Тип бани")
sql("update baths set type = null where name = 'Василевские'")
st = case("@eblsu_bot Василевские 2ч", 20)
check("у бани нет типа — карточка спросит", st.get("bathId") and not st.get("bathType"), st)
card("t:public")
check("автор выбрал «Общественная» — запомнено в черновике", json.loads(sql(f"select state from bot_sessions where tg_id = {ME}")).get("type") == "public")
sql("delete from bot_sessions")

print("Черновик и «В Комиссию»")
st = post("Василевские", 40, chat=ME, chat_type="private")
card("ed", chat=ME, chat_type="private")
st = post("3 часа", 41, chat=ME, chat_type="private")
check("время словами вместо кнопок закрывает вопрос «Сколько парились?»", st["dur"] == 180 and not st.get("awaiting"), st)
sql("delete from bot_sessions")
mine = lambda: int(sql("select count(*) from visits v join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot' and v.created_at > now() - interval '5 minutes'"))
before = mine()
st = case("@eblsu_bot Василевские 2ч с Деном", 42)
with ThreadPoolExecutor(2) as ex:
    list(ex.map(lambda i: card("send", cid=f"s{i}"), range(2)))
card("send", cid="s3")
check("двойное нажатие «✅ В Комиссию» — один поход", mine() - before == 1, mine() - before)
row = sql("select v.id || '|' || v.source || '|' || (v.tg_link is not null) || '|' || count(vp.player_id) from visits v join visit_players vp on vp.visit_id = v.id "
          "join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot' group by v.id order by v.id desc limit 1").split("|")
check("поход из бота сохранил ссылку на пост, компания записана", row[1:] == ["bot", "true", "2"], row)
sql(f"delete from visits where id = {row[0]}")

print("«Долгая была?» — на доверии")
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by) select 5, now() - interval '3 hours', 60, id from players where nick='Леха' returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) select {vid}, id from players where nick='Леха'")
press(f"yl:{vid}", 901)
check("чужой кнопкой не отметить", sql(f"select duration_min from visits where id = {vid}") == "60")
press(f"yl:{vid}", ME)
check("участник жмёт «Да, долгая» — поход долгий без фото", int(sql(f"select duration_min from visits where id = {vid}")) > 150)
sql(f"update visits set duration_min = 60, entered_at = now() - interval '2 days' where id = {vid}")
press(f"yl:{vid}", ME)
check("спустя сутки после захода кнопка уже не работает", sql(f"select duration_min from visits where id = {vid}") == "60")
sql(f"delete from visits where id = {vid}")
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by, source) select 5, now() - interval '3 hours', 60, id, 'bot' from players where nick='Леха' returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) select {vid}, id from players where nick='Леха'")
sql(f"insert into bot_posts (visit_id, chat_id, source_msg, card_msg, bath_id) values ({vid}, {CHAT}, 555, 556, 5)")
with ThreadPoolExecutor(3) as ex:
    ticks = list(ex.map(lambda _: req("POST", "/functions/v1/tg-bot?tick=1", {})[1], range(3)))
check("параллельные ?tick=1 спрашивают про поход один раз", sum(t["claimed"].count(int(vid)) for t in ticks) == 1
      and sql(f"select long_asked_at is not null from visits where id = {vid}") == "t", ticks)
sql(f"delete from visits where id = {vid}")

print("Решение Комиссии — одинаково откуда угодно")
# на локальном стенде триггер должен звать локальные функции, а не боевого бота
sql("""update settings set value = '"http://supabase_kong_ebl:8000/functions/v1"' where key = 'functions_url'""")
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by) select 5, now() - interval '2 hours', 90, id from players where nick='Леха' returning id").splitlines()[0]
sql(f"insert into bot_posts (visit_id, chat_id, source_msg, card_msg, bath_id) values ({vid}, {CHAT}, 777, 778, 5)")
announced = lambda: sql(f"select coalesce(announced, '') from bot_posts where visit_id = {vid}")
def wait_announced(want):
    for _ in range(30):
        if announced() == want: return True
        time.sleep(0.3)
    return False
sql(f"update visits set status = 'rejected', moderated_by = (select id from players where nick='Витёк') where id = {vid}")
check("отклонили не кнопкой (как с сайта) — бот объявляет сам", wait_announced("rejected"), announced())
verdict = lambda: req("POST", f"/functions/v1/tg-bot?verdict={vid}", {})[1]
check("повторный вызов ничего не шлёт второй раз", verdict() == {"announced": False})
sql(f"update visits set status = 'ok' where id = {vid}")
check("передумали и засчитали — объявляется новое решение", wait_announced("ok"), announced())
sql(f"delete from visits where id = {vid}")

print("Поход с сайта")
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by) select 5, now() - interval '2 hours', 180, id from players where nick='Махмуд' returning id").splitlines()[0]
check("отмечен на сайте — бот знает, что он с сайта", sql(f"select source from visits where id = {vid}") == "site")
req("POST", f"/functions/v1/tg-bot?new={vid}", {})   # триггер зовёт то же самое — кто первый, тот и пишет
check("бот пишет о нём в чат лиги и Комиссии (свежий, ждёт решения)",
      sql(f"select chat_id from bot_posts where visit_id = {vid}") == sql("select value #>> '{}' from settings where key = 'league_chat'"))
check("второй раз о том же походе не пишет", req("POST", f"/functions/v1/tg-bot?new={vid}", {})[1] == {"notified": False})
sql(f"update visits set status = 'rejected', moderated_by = (select id from players where nick='Леха') where id = {vid}")
check("решение — в чат лиги, ответом на этот пост", wait_announced("rejected")
      and sql(f"select chat_id from bot_posts where visit_id = {vid}") == sql("select value #>> '{}' from settings where key = 'league_chat'"), announced())
check("и тоже только один раз", verdict() == {"announced": False})
sql(f"delete from visits where id = {vid}")
# старое решение по походу с сайта без поста: ?verdict открыт всем — повторно в чат не объявляем
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by, status, moderated_at, created_at) select 5, now() - interval '5 hours', 120, id, "
          "'rejected', now() - interval '1 hour', now() - interval '1 day' from players where nick='Махмуд' returning id").splitlines()[0]
check("старое решение по ?verdict не переобъявляется", verdict() == {"announced": False} and sql(f"select count(*) from bot_posts where visit_id = {vid}") == "0")
sql(f"update visits set moderated_at = now() where id = {vid}")
check("свежее — объявляется", verdict() == {"announced": True})
sql(f"delete from visits where id = {vid}")

print("Ответы на карточку словами")
sql("delete from bot_sessions")
before = mine()
post("Василевские 2ч с Деном", 70, chat=ME, chat_type="private")
st = post("один", 71, chat=ME, chat_type="private")
check("«один» ответом на карточку — без компании, даже если бот не спрашивал", st and st["company"] == [], st)
st = post("что-то непонятное", 72, chat=ME, chat_type="private")
check("непонятный ответ черновик не ломает", st and st.get("bathName") == "Василевские" and st["company"] == [], st)
post("да", 73, chat=ME, chat_type="private")
check("«да» на «всё верно?» — поход ушёл в Комиссию, как кнопкой", mine() - before == 1 and sql(f"select count(*) from bot_sessions where tg_id = {ME}") == "0", mine() - before)
sql("delete from visits where id = (select max(v.id) from visits v join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot')")

print("Компания — явный выбор")
den = sql("select id from players where nick = 'Ден'")
state = lambda who=ME: json.loads(sql(f"select state from bot_sessions where tg_id = {who}") or "null") or {}
st = case("@eblsu_bot Василевские 2ч", 80)
check("компании в посте нет — бот спрашивает кнопками, а не пишет молча «один»", st.get("companyOk") is False and len(st.get("suggest") or []) > 0, st)
before = mine()
card("send", cid="n1")
check("пока компания не выбрана, «В Комиссию» не отправляет", mine() == before)
card(f"cp:{den}")
check("кнопка с ником добавляет попутчика", nicks(state().get("company", [])) == {"Ден"} and state().get("companyOk") is True, state())
card(f"cp:{den}")
check("повторное нажатие убирает", state().get("company") == [] and state().get("companyOk") is False, state())
card("c1")
check("«🙋 Один» — компания выбрана", state().get("companyOk") is True and state().get("company") == [] and not state().get("picking"), state())
check("«один» прямо в посте — бот не переспрашивает", case("@eblsu_bot Василевские 2ч один", 81).get("companyOk") is True)
sql("delete from bot_sessions")
text = "@eblsu_bot Василевские с Мамонтов"
upd = {"update_id": 82, "message": {"message_id": 82, "date": int(time.time()), "chat": {"id": CHAT, "type": "supergroup"},
       "from": {"id": ME, "is_bot": False, "first_name": "Alexey"}, "text": text,
       "entities": [{"type": "mention", "offset": 0, "length": 10},
                    {"type": "text_mention", "offset": text.index("Мамонтов"), "length": 8, "user": {"id": 777777, "is_bot": False, "first_name": "Denis"}}]}}
req("POST", "/functions/v1/tg-bot", upd, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
st = state()
check("упоминание по имени незнакомого — не часть бани, бот спрашивает, кто это",
      st.get("bathName") == "Василевские" and st.get("unknown") == ["Мамонтов"] and st.get("companyOk") is False, st)

print("Этот поход уже отмечен")
vas = sql("select id from baths where name = 'Василевские' limit 1")
dup = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, source) select {vas}, now() - interval '1 hour', 120, id, 'bot' from players where nick = 'Ден' returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) select {dup}, id from players where nick in ('Ден', 'Леха')")
st = case("@eblsu_bot Василевские 2ч", 83)
check("Ден уже отметил Василевские с Лехой — бот говорит, что второй раз не нужно", (st.get("dup") or {}).get("by") == "Ден", st)
check("и первым в подсказках попутчиков — Ден", (st.get("suggest") or [None])[0] == den, st.get("suggest"))
card("dx")
check("«Не отмечаю» — черновик убран", sql(f"select count(*) from bot_sessions where tg_id = {ME}") == "0")
case("@eblsu_bot Василевские 2ч", 84)
card("do")
check("«Это другой поход» — продолжаем оформлять", state().get("dupOk") is True, state())
sql(f"delete from visits where id = {dup}")
sql("delete from bot_sessions")

print("Заявка «это я» — через бота")
NEW1, NEW2, NEW3 = 903, 904, 905
sql(f"delete from player_accounts where tg_id in ({NEW1}, {NEW2}, {NEW3})")
sql("delete from bot_sessions")
for tg, name in ((NEW1, "Хвост Тест"), (NEW2, "Даня Тест"), (NEW3, "Фил Тест")):
    sql(f"insert into player_accounts (tg_id, tg_username, tg_name) values ({tg}, 'new{tg}', '{name}')")
acc = lambda tg: sql(f"select id from player_accounts where tg_id = {tg}")
def wait(q, want):
    for _ in range(30):
        if sql(q) == want: return True
        time.sleep(0.3)
    return False
check("ника нет — пост не запоминается, бот советует выбрать ник на сайте", post("@eblsu_bot Василевские 2ч", 60, who=NEW1) is None)
sql(f"update player_accounts set claimed_nick = 'Хвост' where tg_id = {NEW1}")
check("выбрал ник на сайте — заявка ушла Комиссии", wait(f"select nick from claim_notices where account_id = '{acc(NEW1)}'", "Хвост"))
check("о той же заявке второй раз Комиссии не пишет", req("POST", f"/functions/v1/tg-bot?claim={acc(NEW1)}", {})[1] == {"notified": False})
st = post("@eblsu_bot Василевские 2ч с Деном", 61, who=NEW1)
check("пост до подтверждения ника запомнен, а не выброшен", (st or {}).get("stash", {}).get("message_id") == 61, st)
press(f"cl:{acc(NEW1)}", 901, mid=62)   # Ден — не Комиссия
check("чужой кнопкой ник не привязать", sql(f"select player_id is null from player_accounts where tg_id = {NEW1}") == "t")
press(f"cl:{acc(NEW1)}", ME, mid=63)    # Леха — Комиссия
check("Комиссия подтвердила кнопкой — аккаунт привязан", sql(f"select p.nick from player_accounts a join players p on p.id = a.player_id where a.tg_id = {NEW1}") == "Хвост")
st = json.loads(sql(f"select state from bot_sessions where tg_id = {NEW1}") or "null") or {}
check("отложенный пост стал карточкой: автор, баня, компания, исходный пост",
      st.get("authorNick") == "Хвост" and st.get("bathName") == "Василевские" and nicks(st.get("company", [])) == {"Ден"} and st.get("source") == 61, st)
check("уведомление Комиссии погашено", sql(f"select count(*) from claim_notices where account_id = '{acc(NEW1)}'") == "0")
sql(f"update player_accounts set claimed_nick = 'Даня' where tg_id = {NEW2}")
wait(f"select nick from claim_notices where account_id = '{acc(NEW2)}'", "Даня")
press(f"cn:{acc(NEW2)}", ME, mid=64)
check("«Отказать» — заявка снята, аккаунт не привязан",
      sql(f"select coalesce(claimed_nick, '') || '|' || (player_id is null) from player_accounts where tg_id = {NEW2}") == "|true")
sql(f"update player_accounts set claimed_nick = 'Фил' where tg_id = {NEW3}")
wait(f"select nick from claim_notices where account_id = '{acc(NEW3)}'", "Фил")
post("@eblsu_bot Василевские 3ч", 65, who=NEW3)
sql(f"update player_accounts set player_id = (select id from players where nick = 'Фил'), claimed_nick = null where tg_id = {NEW3}")
check("подтвердили на сайте — отложенный пост тоже становится карточкой", wait(f"select state->>'authorNick' from bot_sessions where tg_id = {NEW3}", "Фил"))
sql(f"delete from player_accounts where tg_id in ({NEW1}, {NEW2}, {NEW3})")
sql("delete from bot_sessions")

print("Диагностика")
diag = req("GET", "/functions/v1/tg-bot?diag=1")[1]
check("?diag отдаёт из журнала только время и тип", all(set(e) <= {"at", "kind"} for e in diag.get("log") or []), diag)
print("Готово.")
