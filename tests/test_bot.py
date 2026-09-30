"""Проверка разбора постов ботом на локальном стенде: время, компания, баня, УУ, ответы только на отметку.

Telegram на стенде — заглушка tests/stub.py (отвечает как настоящий, без интернета); проверяем черновик в bot_sessions и базу.
Перед запуском: supabase start && supabase db reset && supabase functions serve --env-file supabase/functions/.env
Запуск: python3 tests/test_bot.py
"""
import json, re, time
from concurrent.futures import ThreadPoolExecutor
from local import API, KEY, WEBHOOK_SECRET, check, now, req, sql

CHAT, ME = -1001234567890, 900
sql("delete from bot_sessions")
sql(f"delete from player_accounts where tg_id in ({ME}, 901)")
sql(f"insert into player_accounts (player_id, tg_id, tg_username) select id, {ME}, 'lekha_tg' from players where nick='Леха'")
sql("insert into player_accounts (player_id, tg_id, tg_username) select id, 901, 'den_tg' from players where nick='Ден'")


def post(text, mid, who=ME, chat=CHAT, chat_type="supergroup"):
    ents = [{"type": "mention" if m.group()[0] == "@" else "hashtag", "offset": m.start(), "length": len(m.group())} for m in re.finditer(r"[@#]\w+", text)]
    update = {"update_id": mid, "message": {"message_id": mid, "date": now(), "chat": {"id": chat, "type": chat_type},
              "from": {"id": who, "is_bot": False, "first_name": "Alexey"}, "text": text, "entities": ents}}
    s, _ = req("POST", "/functions/v1/tg-bot", update, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    assert s == 200, s
    st = sql(f"select state from bot_sessions where tg_id = {who}")
    return json.loads(st) if st else None


def card(data, who=ME, chat=CHAT, chat_type="supergroup", cid="c"):
    """Кнопка на карточке черновика — той, которую бот прислал (её номер бот запомнил в черновике)."""
    st = json.loads(sql(f"select state from bot_sessions where tg_id = {who}") or "null") or {}
    upd = {"update_id": 3000, "callback_query": {"id": cid, "from": {"id": who, "is_bot": False, "first_name": "X"}, "data": data,
           "message": {"message_id": st.get("card"), "chat": {"id": chat, "type": chat_type}, "text": "карточка"}}}
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
st = case("@eblsu_bot Сандуны 2ч, вход 600₽, пиво 150 руб", 14)
check("цена и пиво со слов автора — с явным рублёвым маркером", st.get("price") == 600 and st.get("beerPrice") == 150, st)
st = case("@eblsu_bot Сандуны 2ч, было человек 12", 15)
check("число без рублёвого маркера — цену не разбираем", st.get("price") is None and st.get("beerPrice") is None, st)
st = case("@eblsu_bot Сандуны 2ч, вход 40$", 16)
check("валюта значком — не рубль", st.get("price") == 40 and st.get("currency") == "USD", st)
st = case("@eblsu_bot Сандуны 2ч, вход 500₽ по выходным, скидка до 18:00", 17)
check("будни/выходной и «скидка до» словами в посте", st.get("price") == 500 and st.get("priceWeekend") == "weekend" and st.get("priceBefore") == "18:00", st)
st = case("@eblsu_bot Сандуны 2ч, вход 500₽ до 18:00", 18)
check("«до 18:00» без слова «скидка» — не разбираем как скидку", st.get("price") == 500 and st.get("priceBefore") is None, st)
st = case("@eblsu_bot Сандуны 2ч, вход 500р", 19)
check("«р» без точки — тоже рублёвый маркер", st.get("price") == 500 and st.get("currency") is None, st)
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
check("заход — время поста, длительность не вычитается (баню отмечают сразу после входа)",
      sql(f"select entered_at = posted_at from visits where id = {row[0]}") == "t")
sql(f"delete from visits where id = {row[0]}")

print("Долгая — сам участник, через 2,5–8 часов после захода")
def visit_ago(hours, people=("Леха",)):
    v = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, source) select 5, now() - interval '{hours} hours', 60, id, 'bot' from players where nick='Леха' returning id").splitlines()[0]
    sql(f"insert into visit_players (visit_id, player_id) select {v}, id from players where nick in ({','.join(repr(n) for n in people)})")
    return v
dur = lambda v: int(sql(f"select duration_min from visits where id = {v}"))
sql("delete from visits where source = 'bot' and created_at > now() - interval '1 day' and created_by in (select id from players where nick in ('Леха', 'Ден'))")
vid = visit_ago(3)
press(f"yl:{vid}", 901)
check("чужой кнопкой не отметить", dur(vid) == 60)
press(f"yl:{vid}", ME)
check("кнопка «Да, долгая» (старые карточки) — поход долгий без фото", dur(vid) > 150)
sql(f"delete from visits where id = {vid}")
vid = visit_ago(10)
press(f"yl:{vid}", ME)
check("позже 8 часов после захода — только Комиссия", dur(vid) == 60)
sql(f"delete from visits where id = {vid}")
vid = visit_ago(3, ("Леха", "Ден"))
sql("delete from bot_sessions")
post("@eblsu_bot долгая была", 30, who=901)
check("«@бот долгая была» от Дена через 3 часа — поход долгий, черновика нет", dur(vid) > 150 and sql("select count(*) from bot_sessions where tg_id = 901") == "0")
sql(f"delete from visits where id = {vid}")
vid = visit_ago(4)
post("долгая", 31, chat=ME, chat_type="private")
check("«долгая» в личку боту — тоже долгая", dur(vid) > 150)
sql(f"delete from visits where id = {vid}")
vid = visit_ago(0.5)
post("@eblsu_bot долгая будет", 32)
check("«долгая будет» через полчаса после захода — можно сразу, долгая", dur(vid) > 150)
sql(f"delete from visits where id = {vid}")
st = case("@eblsu_bot Сандуны долгая с Деном", 33)
check("«Сандуны долгая с Деном» — это новый пост с долгой, а не отметка", (st or {}).get("dur") == 180 and nicks(st.get("company", [])) == {"Ден"}, st)
sql("delete from bot_sessions")

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
from local import TELEGRAM
def card_kb(who=ME):
    """Кнопки последней версии карточки черновика — как их видит участник."""
    cid = state(who).get("card")
    for m, p in reversed(TELEGRAM.calls):
        if m in ("editMessageText", "sendMessage") and (int(p.get("message_id") or 0) == cid or m == "sendMessage"):
            return [b.get("callback_data") for row in (p.get("reply_markup") or {}).get("inline_keyboard", []) for b in row], \
                   [b.get("text") for row in (p.get("reply_markup") or {}).get("inline_keyboard", []) for b in row]
    return [], []
case("@eblsu_bot Василевские 2ч", 84)
card(f"cp:{den}")
data, texts = card_kb()
check("отметил ник — выбор сразу: в карточке «В Комиссию», ник с галочкой, без «Готово»",
      state().get("companyOk") is True and "send" in data and "✓ Ден" in texts and "cd" not in data, texts)
check("и можно отметить ещё кого-то — кнопки с никами остались", sum(1 for d in data if d and d.startswith("cp:")) >= 2, texts)
card("send", cid="n2")
check("один человек отмечен — «В Комиссию» сразу отправляет", sql(f"select count(*) from bot_sessions where tg_id = {ME}") == "0")
sql("delete from visits where id = (select max(v.id) from visits v join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot')")

print("Цена, пиво и пасхалки")
sql("delete from bot_sessions")
sql("update baths set type = null where name = 'Amalienbad'")   # предыдущий прогон мог уже разметить тип со слов автора
before = mine()
seen = len(TELEGRAM.calls)
st = post("Amalienbad 2ч один, хуитнес", 187, chat=ME, chat_type="private")
check("однозначная баня, тип со слов автора — цены пока нет", st.get("bathName") == "Amalienbad" and st.get("type") == "spa"
      and st.get("companyOk") is True and st.get("price") is None, st)
st = post("вход 6000₽, пиво 300₽", 188, chat=ME, chat_type="private")
check("цена и пиво дописаны следующим сообщением в личке — как и время/компания словами", st.get("price") == 6000 and st.get("beerPrice") == 300, st)
post("да", 189, chat=ME, chat_type="private")
check("поход ушёл в Комиссию", mine() - before == 1)
sent = [p.get("text") or "" for m, p in TELEGRAM.calls[seen:] if m in ("sendMessage", "editMessageText")]
check("цена и пиво — в сводке «со слов автора»",
      any("💰 6000 ₽ — со слов автора" in t for t in sent) and any("🍺 300 ₽ — со слов автора" in t for t in sent), sent)
check("новая баня — тип и цена из этого же поста не подтверждены, пасхалок ещё нет",
      not any(("пижон" in t or "Наши люди" in t or "заебали хуитнесы" in t or "заблочим" in t) for t in sent), sent)
sql("delete from visits where id = (select max(v.id) from visits v join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot')")

sql("delete from bot_sessions")
sql("insert into bath_prices (bath_id, price, currency, created_by) select id, 6000, 'RUB', (select id from players where nick = 'Леха') from baths where name = 'Dublinger'")
before = mine()
seen = len(TELEGRAM.calls)
case("@eblsu_bot Dublinger 2ч один", 190)
card("send", cid="j2")
check("поход по уже известной дорогой хуитнес-бане ушёл в Комиссию", mine() - before == 1)
sent = [p.get("text") or "" for m, p in TELEGRAM.calls[seen:] if m in ("sendMessage", "editMessageText")]
check("баня уже хуитнес и уже дороже 5500 (по настоящей цене, не по этому посту) — обе пасхалки вторым сообщением",
      any(("пижон" in t or "Наши люди" in t) for t in sent) and any(("заебали хуитнесы" in t or "заблочим" in t) for t in sent)
      and not any(("пижон" in t or "Наши люди" in t or "заебали хуитнесы" in t or "заблочим" in t) and "со слов автора" in t for t in sent), sent)
sql("delete from visits where id = (select max(v.id) from visits v join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot')")
sql("delete from bath_prices where bath_id = (select id from baths where name = 'Dublinger')")

sql("delete from bot_sessions")
case("@eblsu_bot Сандуны 2ч, вход 500₽", 191)
card("pw:weekday", cid="pw1")
check("кнопка «Будни» у цены — выбор сохранён в черновике", json.loads(sql(f"select state from bot_sessions where tg_id = {ME}")).get("priceWeekend") == "weekday")
sql("delete from bot_sessions")

sql("delete from bot_sessions")
seen = len(TELEGRAM.calls)
st = post("Василевские 2ч один", 192, chat=ME, chat_type="private")
sent = [p.get("text") or "" for m, p in TELEGRAM.calls[seen:] if m in ("sendMessage", "editMessageText")]
data, _ = card_kb()
check("цены в посте нет — бот спрашивает сам, кнопок будни/выходной ещё нет",
      st.get("price") is None and any("Цена входа?" in t for t in sent) and not any(d and d.startswith("pw:") for d in data), sent)
seen = len(TELEGRAM.calls)
st = post("500", 193, chat=ME, chat_type="private")
sent = [p.get("text") or "" for m, p in TELEGRAM.calls[seen:] if m in ("sendMessage", "editMessageText")]
data, _ = card_kb()
check("голая цифра в ответ (в личке, без явного маркера валюты) — принята как цена входа, появились кнопки будни/выходной и вопрос про пиво",
      st.get("price") == 500 and any(d and d.startswith("pw:") for d in data) and any("Цена пива?" in t for t in sent), sent)
st = post("150", 194, chat=ME, chat_type="private")
check("следующая голая цифра — цена пива, а не входа (вопрос про вход уже закрыт)", st.get("price") == 500 and st.get("beerPrice") == 150, st)
sql("delete from bot_sessions")

print("«#баня» — вместо отметки бота")
st = case("#баня Василевские 2ч с Деном", 85)
check("«#баня …» — черновик, как с отметкой бота", (st or {}).get("bathName") == "Василевские" and nicks(st.get("company", [])) == {"Ден"}
      and "#" not in (st.get("query") or ""), st)
check("«#банька» — тоже", (case("#банька Василевские один", 86) or {}).get("bathName") == "Василевские")
sql("delete from bot_sessions")
check("другие хэштеги бота не зовут", post("#сауна Василевские огонь", 87) is None)
def mention(text, name, mid, uid=777777):
    sql("delete from bot_sessions")
    upd = {"update_id": mid, "message": {"message_id": mid, "date": now(), "chat": {"id": CHAT, "type": "supergroup"},
           "from": {"id": ME, "is_bot": False, "first_name": "Alexey"}, "text": text,
           "entities": [{"type": "mention", "offset": 0, "length": 10},
                        {"type": "text_mention", "offset": text.index(name), "length": len(name), "user": {"id": uid, "is_bot": False, "first_name": "X"}}]}}
    req("POST", "/functions/v1/tg-bot", upd, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    return state()
st = mention("@eblsu_bot Василевские с Мамонтов", "Мамонтов", 82)
check("упоминание по имени «Мамонтов» (синей ссылкой) — кличка Дена, в название бани не попадает",
      st.get("bathName") == "Василевские" and nicks(st.get("company", [])) == {"Ден"}, st)
st = mention("@eblsu_bot Василевские с Кузьмичом", "Кузьмичом", 85)
check("незнакомое упоминание по имени — не часть бани, бот спрашивает, кто это",
      st.get("bathName") == "Василевские" and st.get("unknown") == ["Кузьмичом"] and st.get("companyOk") is False, st)

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

def wait(q, want):
    for _ in range(30):
        if sql(q) == want: return True
        time.sleep(0.3)
    return False


print("Клички")
pid = lambda nick: sql(f"select id from players where nick = '{nick}'")
sql("delete from player_aliases where alias in ('Кабаном', 'Кабан')")
check("«с Мамонтовым» — кличка Дена", nicks(case("@eblsu_bot Василевские 2ч с Мамонтовым", 90)["company"]) == {"Ден"})
check("«с Демоном и Уважаемым» — Фил и Шурик", nicks(case("@eblsu_bot Василевские 2ч с Демоном и Уважаемым", 91)["company"]) == {"Фил", "Шурик"})
check("«уважаемый» в обычной фразе — не Шурик", "Шурик" not in nicks(case("@eblsu_bot Василевские 2ч, пар уважаемый", 92)["company"]))
st = case("@eblsu_bot Василевские 2ч с Кабаном", 93)
check("незнакомое имя после «с» — не баня, бот спросит, кто это", st.get("unknown") == ["Кабаном"] and st.get("bathName") == "Василевские", st)
card(f"cp:{pid('Хвост')}")
card("al")
check("выбрал человека кнопкой и «💾 Запомнить» — кличка сохранена",
      sql("select p.nick from player_aliases a join players p on p.id = a.player_id where a.alias = 'Кабаном'") == "Хвост")
check("в следующий раз узнаёт сам и в другом падеже", nicks(case("@eblsu_bot Василевские 2ч с Кабаном и Кабану", 94)["company"]) == {"Хвост"})
sql("delete from player_aliases where alias = 'Кабаном'")
sql("delete from bot_sessions")
post("кличка Кабан = Хвост", 95, chat=ME, chat_type="private")
check("Комиссия в личке: «кличка Кабан = Хвост» — сохранена", sql("select p.nick from player_aliases a join players p on p.id = a.player_id where a.alias = 'Кабан'") == "Хвост")
post("убери кличку Кабан", 96, chat=ME, chat_type="private")
check("«убери кличку Кабан» — убрана", sql("select count(*) from player_aliases where alias = 'Кабан'") == "0")
post("кличка Кабан = Хвост", 97, who=901, chat=901, chat_type="private")
check("не Комиссия — кличку командой не добавить", sql("select count(*) from player_aliases where alias = 'Кабан'") == "0")
sql("delete from bot_sessions")

print("Живая карточка — без новых сообщений в чате")
CARD = 4242
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by, source) select 5, now() - interval '3 hours', 60, id, 'bot' from players where nick = 'Леха' returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) select {vid}, id from players where nick in ('Леха', 'Ден')")
sql(f"insert into bot_posts (visit_id, chat_id, source_msg, card_msg, bath_id, card_text, geo_msg) values ({vid}, {CHAT}, 4241, {CARD}, 5, 'Ушло в Комиссию ✅', {CARD})")
def reply_card(text, mid, who=ME):
    upd = {"update_id": 5000 + mid, "message": {"message_id": mid, "date": now(), "chat": {"id": CHAT, "type": "supergroup"},
           "from": {"id": who, "is_bot": False, "first_name": "X"}, "text": text,
           "reply_to_message": {"message_id": CARD, "from": {"id": 1, "is_bot": True, "username": "eblsu_bot"}, "chat": {"id": CHAT, "type": "supergroup"}, "text": "карточка"}}}
    req("POST", "/functions/v1/tg-bot", upd, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
reply_card("долгая была", 4300, who=901)
check("«долгая была» ответом на карточку — долгая, строкой в карточке (ответ Дена)",
      int(sql(f"select duration_min from visits where id = {vid}")) > 150 and "Ден" in sql(f"select coalesce(long_note, '') from bot_posts where visit_id = {vid}"))
reply_card("https://yandex.ru/maps/?pt=37.6176,55.7558&z=16", 4301)
check("ссылка ответом на ту же карточку — это про точку: вопрос закрыт", sql(f"select geo_msg is null from bot_posts where visit_id = {vid}") == "t")
sql(f"update visits set status = 'ok', moderated_by = (select id from players where nick = 'Витёк') where id = {vid}")
check("решение Комиссии — строкой в карточке, с очками", wait(f"select left(coalesce(verdict_text, ''), 11) from bot_posts where visit_id = {vid}", "👍 Засчитано"),
      sql(f"select verdict_text from bot_posts where visit_id = {vid}"))
sql(f"delete from visits where id = {vid}")

print("Поход поправили — у Комиссии и в карточке свежая сводка")
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by, source) select 5, now() - interval '1 hour', 60, id, 'bot' from players where nick = 'Леха' returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) select {vid}, id from players where nick = 'Леха'")
sql(f"insert into bot_notifications (visit_id, chat_id, message_id, text) values ({vid}, {ME}, 1, 'старая сводка: 👥 один')")
sql(f"insert into bot_posts (visit_id, chat_id, source_msg, card_msg, bath_id, card_text) values ({vid}, {CHAT}, 6001, 6002, 5, E'Ушло в Комиссию ✅ <b>Леха</b>\\n\\nстарая сводка')")
sql(f"insert into visit_players (visit_id, player_id) select {vid}, id from players where nick = 'Ден'")   # как «добавь Дена в заявку»
check("добавили Дена — сообщение Комиссии обновилось", wait(f"select position('👥 Ден' in text) > 0 from bot_notifications where visit_id = {vid}", "t"),
      sql(f"select text from bot_notifications where visit_id = {vid}"))
card_text = sql(f"select card_text from bot_posts where visit_id = {vid}")
check("и карточка в чате: шапка та же, сводка свежая", card_text.startswith("Ушло в Комиссию ✅") and "👥 Ден" in card_text and "старая" not in card_text, card_text)
sql(f"update visits set duration_min = 180 where id = {vid}")
check("поменяли длительность — у Комиссии «долгая»", wait(f"select position('долгая' in text) > 0 from bot_notifications where visit_id = {vid}", "t"))
sql(f"delete from visits where id = {vid}")

print("Итоги недели")
dry = lambda: req("GET", "/functions/v1/week-results?dry=")[1]
wk = dry()
check("итоги недели: места и очки как в движке (делёжка мест — среднее)", wk.get("week") and all("place" in r and "pts" in r for r in wk.get("rows", [])), wk.get("rows", [])[:3])
vid = sql("insert into visits (bath_id, entered_at, duration_min, created_by, source) select 5, now(), 60, id, 'bot' from players where nick = 'Леха' returning id").splitlines()[0]
sql(f"insert into visit_players (visit_id, player_id) select {vid}, id from players where nick = 'Леха'")
check("поход этой недели на проверке — итоги ждут решения Комиссии", dry()["waiting"]["visits"] >= 1, dry()["waiting"])
sql(f"update visits set status = 'ok', moderated_by = (select id from players where nick = 'Витёк') where id = {vid}")
check("решили — ждать нечего", dry()["waiting"]["visits"] == 0, dry()["waiting"])
sql(f"delete from visits where id = {vid}")
import pathlib, stub, urllib.error, urllib.request
# wasm для картинки функция берёт с npm-CDN — на стенде из заглушки (тот же файл из кэша npm), на бою с jsDelivr
wr = (pathlib.Path(__file__).resolve().parent.parent / "supabase/functions/week-results/index.ts").read_text()
ver = re.search(r'"npm:@resvg/resvg-wasm@([\d.]+)"', wr)[1]
check("wasm для картинки — той же версии, что библиотека resvg в import", f"/@resvg/resvg-wasm@{ver}/index_bg.wasm" in wr, ver)
try:
    wasm_url = f"https://cdn.jsdelivr.net/npm/@resvg/resvg-wasm@{ver}/index_bg.wasm"
    cdn = urllib.request.urlopen(urllib.request.Request(wasm_url, method="HEAD"), timeout=8)
    size = int(cdn.headers.get("Content-Length") or -1)
    if size < 0:   # jsDelivr бывает отвечает на HEAD без Content-Length (28.09) — тогда меряем сам файл
        size = len(urllib.request.urlopen(wasm_url, timeout=30).read())
    local_wasm = stub.npm_file(f"@resvg/resvg-wasm@{ver}/index_bg.wasm") or b""
    check("[сеть] боевой адрес wasm на jsDelivr отвечает, файл того же размера, что у заглушки",
          cdn.status == 200 and size == len(local_wasm), (size, len(local_wasm)))
except (urllib.error.URLError, OSError) as e:
    print(f"  – пропущено [сеть]: jsDelivr сейчас недоступен ({getattr(e, 'code', None) or getattr(e, 'reason', None) or e})")
png = urllib.request.urlopen(urllib.request.Request(f"{API}/functions/v1/week-results?render=", headers={"apikey": KEY, "Authorization": f"Bearer {KEY}"}), timeout=120).read()
check("картинка итогов — PNG 1080×1350", png[:8] == b"\x89PNG\r\n\x1a\n" and int.from_bytes(png[16:20], "big") == 1080 and int.from_bytes(png[20:24], "big") == 1350, len(png))

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

print("«@eblany» — позвать всех")
sql(f"delete from chat_members where chat_id = {CHAT}")
sql(f"delete from rollcalls where chat_id = {CHAT}")
sql(f"insert into chat_members (chat_id, tg_id) values ({CHAT}, {ME}), ({CHAT}, 901), ({CHAT}, 902), ({CHAT}, 908), ({CHAT}, 910)")
sql("delete from bot_sessions")
calls = lambda: sql(f"select count(*) from rollcalls where chat_id = {CHAT}")
from local import TELEGRAM
seen = len(TELEGRAM.calls)
check("«@eblany …» — бот зовёт всех, а не заводит черновик похода", post("@eblany погнали в Сандуны к 19", 70) is None and calls() == "1")
sent = [p for m, p in TELEGRAM.calls[seen:] if m == "sendMessage" and int(p.get("chat_id") or 0) == CHAT]
txt = sent[0].get("text", "") if sent else ""
check("ответ на сообщение: «Ебланы, общий сбор!» и ссылка на него, текст автора не повторяем",
      len(sent) == 1 and (sent[0].get("reply_parameters") or {}).get("message_id") == 70 and "Ебланы, общий сбор!" in txt
      and 'href="https://t.me/c/1234567890/70"' in txt and "погнали" not in txt, sent)
check("отметки: ник лиги у привязанных, имя из Telegram у остальных; автора не отмечает",
      '<a href="tg://user?id=901">Ден</a>' in txt and '<a href="tg://user?id=908">Участник908</a>' in txt and "id=900" not in txt, txt)
check("вышедшего из чата не отмечает и забывает", "id=902" not in txt and sql(f"select count(*) from chat_members where chat_id = {CHAT} and tg_id = 902") == "0")
check("имя из Telegram запомнено — второй раз не спрашивает", sql(f"select name from chat_members where chat_id = {CHAT} and tg_id = 908") == "Участник908")
check("Telegram попросил подождать — отметка всё равно есть, «участник» вместо имени (не человечек)",
      '<a href="tg://user?id=910">участник</a>' in txt and "🧖" not in txt, txt)
check("сообщение сбора запомнено — его можно поправить", sql(f"select cardinality(msgs) from rollcalls where chat_id = {CHAT}") == "1")
def edited(name):
    for _ in range(30):
        if any(m == "editMessageText" and name in (p.get("text") or "") for m, p in TELEGRAM.calls[seen:]): return True
        time.sleep(0.5)
    return False
check("имя узнали фоном — бот поправил своё сообщение, без нового", edited("Участник910")
      and sql(f"select name from chat_members where chat_id = {CHAT} and tg_id = 910") == "Участник910"
      and len([1 for m, p in TELEGRAM.calls[seen:] if m == "sendMessage" and int(p.get("chat_id") or 0) == CHAT]) == 1)
rc = sql(f"select id from rollcalls where chat_id = {CHAT}")
check("?rollfix=<id> — поправить вручную (безопасно повторять)", req("POST", f"/functions/v1/tg-bot?rollfix={rc}", {})[1] == {"fixed": True})
check("с отметкой бота — тоже сбор, не пост про баню", post("@eblsu_bot @eblany Василевские с Деном", 71, who=901) is None)
check("второй сбор в течение 10 минут — не зовёт (спам)", calls() == "1")
check("в личке «@eblany» ничего не зовёт", post("@eblany", 72, chat=ME, chat_type="private") is None and calls() == "1")
def service(mid, **extra):
    upd = {"update_id": mid, "message": {"message_id": mid, "date": int(time.time()), "chat": {"id": CHAT, "type": "supergroup"},
           "from": {"id": 901, "is_bot": False, "first_name": "Ден"}, **extra}}
    assert req("POST", "/functions/v1/tg-bot", upd, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})[0] == 200
service(73, new_chat_members=[{"id": 906, "is_bot": False, "first_name": "Новенький"}, {"id": 907, "is_bot": True, "first_name": "Бот"}])
check("вошёл в чат — бот его запомнил (ботов не запоминает)",
      sql(f"select string_agg(tg_id || ':' || coalesce(name, ''), ',' order by tg_id) from chat_members where chat_id = {CHAT} and tg_id in (906, 907)") == "906:Новенький")
service(74, left_chat_member={"id": 906, "is_bot": False, "first_name": "Новенький"})
check("вышел из чата — забыт", sql(f"select count(*) from chat_members where chat_id = {CHAT} and tg_id = 906") == "0")
sql(f"delete from chat_members where chat_id = {CHAT}")
sql(f"delete from rollcalls where chat_id = {CHAT}")

print("Фото из походов")
# фото кладёт бот, файлы перекачивает функция photos: из Telegram (заглушка) в бакет Яндекса (заглушка, TELEGRAM.s3)
from local import TELEGRAM
sql("""update settings set value = '"http://supabase_kong_ebl:8000/functions/v1"' where key = 'functions_url'""")
sql("delete from bot_sessions")
sql("delete from visit_photos")
sql("delete from visits where source = 'bot' and created_at > now() - interval '1 day' and created_by in (select id from players where nick in ('Леха', 'Ден'))")
sql("delete from player_accounts where tg_id = 909")
sql("insert into player_accounts (player_id, tg_id, tg_username) select id, 909, 'shurik_tg' from players where nick='Шурик'")

def photo(mid, fid, caption=None, album=None, who=ME, chat=CHAT, chat_type="supergroup", reply_to=None):
    """Фото в Telegram — сразу в четырёх размерах, как присылает настоящий (90, 320, 1280, 2560 px)."""
    sizes = [{"file_id": f"photo-{fid}-{n}", "file_unique_id": f"u-{fid}-{n}", "width": w, "height": w * 3 // 4}
             for n, w in (("s", 90), ("m", 320), ("y", 1280), ("w", 2560))]
    msg = {"message_id": mid, "date": now(), "chat": {"id": chat, "type": chat_type},
           "from": {"id": who, "is_bot": False, "first_name": "X"}, "photo": sizes}
    if caption is not None:
        msg["caption"] = caption
        msg["caption_entities"] = [{"type": "mention" if m.group()[0] == "@" else "hashtag", "offset": m.start(), "length": len(m.group())}
                                   for m in re.finditer(r"[@#]\w+", caption)]
    if album:
        msg["media_group_id"] = album
    if reply_to:
        msg["reply_to_message"] = {"message_id": reply_to, "chat": msg["chat"], "from": {"id": 1, "is_bot": True, "username": "eblsu_bot"}}
    s, _ = req("POST", "/functions/v1/tg-bot", {"update_id": mid, "message": msg}, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    assert s == 200, s

n_photos = lambda where: int(sql(f"select count(*) from visit_photos where {where}"))
reacted = lambda mid, emoji: any(m == "setMessageReaction" and int(p.get("message_id") or 0) == mid
                                 and (p.get("reaction") or [{}])[0].get("emoji") == emoji for m, p in TELEGRAM.calls)
# альбом приходит тремя сообщениями почти одновременно, подпись — у одного
with ThreadPoolExecutor(3) as ex:
    list(ex.map(lambda a: photo(*a), [(201, "b", None, "alb1"), (200, "a", "@eblsu_bot Василевские с Деном", "alb1"), (202, "c", None, "alb1")]))
st = state()
check("альбом с подписью — все три фото в черновике, в карточке «📷 3»", n_photos(f"draft_msg = 200 and visit_id is null and tg_from = {ME}") == 3
      and st.get("hasPhotos") and st.get("photos") == 3, st)
check("берём размер до 1600 px и превью от 320 px", sql("select string_agg(distinct w || 'x' || h || ':' || (tg_thumb_id like '%-m'), ',') from visit_photos where draft_msg = 200") == "1280x960:true")
photo(203, "x", None, "alb-x", who=901)
check("чужой альбом без подписи бот не хранит", n_photos("tg_album = 'alb-x'") == 0)
card("send", cid="ph1")
vid = sql(f"select max(v.id) from visits v join players p on p.id = v.created_by where p.nick = 'Леха' and v.source = 'bot'")
check("«В Комиссию» — фото черновика ушли в поход", n_photos(f"visit_id = {vid}") == 3 and n_photos("visit_id is null") == 0)
cardmsg = sql(f"select card_msg from bot_posts where visit_id = {vid}")
check("в карточке похода — «📷 3 фото»", "📷 3 фото" in sql(f"select card_text from bot_posts where visit_id = {vid}"))
def wait_ready(n):
    for _ in range(40):
        if n_photos(f"visit_id = {vid} and ready") == n: return True
        time.sleep(0.5)
    return False
check("файлы перекачаны в бакет сами (триггер → функция photos)", wait_ready(3), sql(f"select string_agg(tries || '', ',') from visit_photos where visit_id = {vid}"))
keys = sql(f"select string_agg(key, ',') from visit_photos where visit_id = {vid}").split(",")
objs = [TELEGRAM.s3.get(f"ebl-photos/{k}{sfx}.jpg") for k in keys for sfx in ("", "_s")]
check("в бакете большое фото и превью, JPEG, кэш навсегда",
      all(o and o["body"][:2] == b"\xff\xd8" and o["type"] == "image/jpeg" and "immutable" in (o["cache"] or "") for o in objs), [bool(o) for o in objs])
check("ключ файла — 32 случайных символа", all(re.fullmatch(r"[0-9a-f]{32}", k) for k in keys), keys)
photo(204, "d", reply_to=int(cardmsg))
check("фото ответом на карточку похода — в поход, 👍, «📷 4 фото»", n_photos(f"visit_id = {vid}") == 4 and reacted(204, "👍")
      and "📷 4 фото" in sql(f"select card_text from bot_posts where visit_id = {vid}"))
photo(205, "e", reply_to=int(cardmsg), who=909)
check("кто не был в походе — фото не кладёт (🤔)", n_photos(f"visit_id = {vid}") == 4 and reacted(205, "🤔"))
photo(206, "d", reply_to=int(cardmsg))
check("то же фото второй раз не ложится", n_photos(f"visit_id = {vid}") == 4)
seen = len(TELEGRAM.calls)
photo(207, "g", chat=901, chat_type="private", who=901)
check("фото в личку — в свой последний поход (Ден был в компании), подтверждение в личке",
      n_photos(f"visit_id = {vid}") == 5 and any(m == "sendMessage" and "Приложил к походу" in (p.get("text") or "") for m, p in TELEGRAM.calls[seen:]))
photo(208, "h", "@eblsu_bot Василевские с Лехой", who=901)
st = state(901)
check("пост про уже отмеченный поход — бот говорит, что он есть", (st.get("dup") or {}).get("id") == int(vid), st)
card("dx", who=901, cid="ph2")
check("«Не отмечаю» — фото этого поста ушли в тот поход", n_photos(f"visit_id = {vid}") == 6 and n_photos("visit_id is null") == 0)
photo(209, "i", "Сандуны", chat=ME, chat_type="private")
check("фото с новой баней в личке — черновик с фото", n_photos(f"draft_msg = 209 and visit_id is null") == 1)
post("/cancel", 210, chat=ME, chat_type="private")
check("черновик отменили — его фото удалены", n_photos(f"tg_from = {ME} and visit_id is null") == 0)
photo(211, "j", "#баня Сандуны с Деном")
check("фото с подписью «#баня …» — черновик с фото (в подписи к фото ники не подсказываются)", n_photos("draft_msg = 211 and visit_id is null") == 1)
post("/cancel", 212, chat=ME, chat_type="private")
sql("delete from bot_sessions")
check("гость фото походов не видит", req("GET", "/rest/v1/visit_photos?select=id")[1] in ([], None) or req("GET", "/rest/v1/visit_photos?select=id")[0] in (401, 403))
sql(f"delete from visits where id = {vid}")
check("удалили поход — строки фото удалены с ним", n_photos(f"visit_id = {vid}") == 0)
sql("delete from player_accounts where tg_id = 909")
sql("delete from bot_sessions")

print("Диагностика")
diag = req("GET", "/functions/v1/tg-bot?diag=1")[1]
check("?diag отдаёт из журнала только время и тип", all(set(e) <= {"at", "kind"} for e in diag.get("log") or []), diag)
check("?diag показывает, видит ли бот все сообщения группы", diag.get("reads_all") is True, diag)
print("Готово.")
