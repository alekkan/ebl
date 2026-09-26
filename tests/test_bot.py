"""Проверка разбора постов ботом на локальном стенде: время, компания, баня, УУ, ответы только на отметку.

До Telegram локально ничего не доходит (токен фейковый) — проверяем черновик, который бот сохраняет в bot_sessions.
Перед запуском: supabase start && supabase db reset && supabase functions serve --env-file supabase/functions/.env
Запуск: python3 tests/test_bot.py
"""
import json, time
from local import WEBHOOK_SECRET, check, req, sql

CHAT, ME = -1001234567890, 900
sql("delete from bot_sessions")
sql(f"delete from player_accounts where tg_id in ({ME}, 901)")
sql(f"insert into player_accounts (player_id, tg_id, tg_username) select id, {ME}, 'lekha_tg' from players where nick='Леха'")
sql("insert into player_accounts (player_id, tg_id, tg_username) select id, 901, 'den_tg' from players where nick='Ден'")


def post(text, mid):
    ents = [{"type": "mention", "offset": text.find(m), "length": len(m)} for m in ("@eblsu_bot", "@den_tg") if m in text]
    update = {"update_id": mid, "message": {"message_id": mid, "date": int(time.time()), "chat": {"id": CHAT, "type": "supergroup"},
              "from": {"id": ME, "is_bot": False, "first_name": "Alexey"}, "text": text, "entities": ents}}
    s, _ = req("POST", "/functions/v1/tg-bot", update, headers={"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET})
    assert s == 200, s
    st = sql(f"select state from bot_sessions where tg_id = {ME}")
    return json.loads(st) if st else None


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
sql("delete from bot_sessions")
check("сообщения без отметки бота игнорируются", post("просто болтаем про Сандуны", 7) is None)
print("Готово.")
