"""Общие помощники для тестов на локальном стенде Supabase (`supabase start` + `supabase functions serve`)."""
import hashlib, hmac, json, re, subprocess, threading, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
import stub

_status = json.loads(subprocess.run(["supabase", "status", "-o", "json"], capture_output=True, text=True).stdout or "{}")
API = _status.get("API_URL", "http://127.0.0.1:54321")
KEY = _status.get("PUBLISHABLE_KEY") or _status.get("ANON_KEY")
DB_CONTAINER = "supabase_db_ebl"
# должны совпадать с supabase/functions/.env (см. .env.example)
BOT_TOKEN = "123456:local-test-token-not-real"
WEBHOOK_SECRET = "local-webhook-secret"
LOCAL_FUNCTIONS = "http://supabase_kong_ebl:8000/functions/v1"


def req(method, path, body=None, token=None, headers=None):
    h = {"apikey": KEY, "Content-Type": "application/json", **(headers or {})}
    if token:
        h["Authorization"] = "Bearer " + token
    r = urllib.request.Request(API + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers=h)
    try:
        # без таймаута запрос, застрявший в функции на стенде, вешал весь прогон насовсем (30.10: test_site стоял 16+ минут);
        # 120 с — больше любой заминки стенда (до ~70 с, см. AGENTS.md)
        with urllib.request.urlopen(r, timeout=120) as resp:
            txt = resp.read().decode()
            try:
                return resp.status, (json.loads(txt) if txt else None)
            except ValueError:
                return resp.status, txt
    except urllib.error.HTTPError as e:
        txt = e.read().decode()
        try:
            return e.code, json.loads(txt)
        except ValueError:
            return e.code, txt


def _sql_once(q):
    return subprocess.run(["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-tAc", q], capture_output=True, text=True).stdout.strip()


# Запрос к базе — через один постоянный psql: docker exec на каждый запрос стоил ~70 мс, а тесты делают их тысячи
# (опросы «пока бот ответит» — тоже). Строка с несколькими командами — как раньше, через psql -c: там они идут одной транзакцией
_psql, _psql_lock, _END = None, threading.Lock(), "__ebl_sql_end__"


def _single(q):
    """Одна команда без обратной косой черты (её psql на входе понимает как свою команду) — можно в постоянный psql."""
    body = q.strip().rstrip(";")
    if "\\" in body:
        return False
    plain = re.sub(r"\$\$.*?\$\$|'(?:[^']|'')*'|\"[^\"]*\"", "", body, flags=re.S)
    return ";" not in plain


def sql(q):
    global _psql
    if not _single(q):
        return _sql_once(q)
    with _psql_lock:
        for attempt in range(2):
            if _psql is None or _psql.poll() is not None:
                _psql = subprocess.Popen(["docker", "exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-tA", "-X", "-v", "ON_ERROR_STOP=0"],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
            try:
                _psql.stdin.write(q.strip().rstrip(";") + ";\n\\echo " + _END + "\n")
                _psql.stdin.flush()
                out = []
                for line in _psql.stdout:
                    if line.rstrip("\n") == _END:
                        return "\n".join(out).strip()
                    out.append(line.rstrip("\n"))
            except (BrokenPipeError, OSError):
                pass
            _psql = None   # psql умер (перезапустили контейнер базы) — поднимаем заново
        return _sql_once(q)


# Telegram, геокодер и npm-CDN для функций — заглушка в этом же процессе (tests/stub.py): без интернета и без зависаний
TELEGRAM = stub.start(BOT_TOKEN)
# триггеры базы должны звать локальные функции, а не боевые (после db reset там боевой адрес), расписания pg_cron — снять:
# они зашиты на боевые адреса (см. AGENTS.md)
if sql("select value #>> '{}' from settings where key = 'functions_url'") != LOCAL_FUNCTIONS:
    sql(f"""update settings set value = '"{LOCAL_FUNCTIONS}"' where key = 'functions_url'""")
sql("select cron.unschedule(jobname) from cron.job")
# геокодер, который база зовёт через pg_net (geo_reverse: функциям Supabase настоящий не отвечает), — та же заглушка
_nom = stub.env_file().get("NOMINATIM_URL", "")
if _nom:
    sql(f"""insert into settings (key, value) values ('nominatim_url', '"{_nom}"') on conflict (key) do update set value = excluded.value""")
# часы Docker после сна Mac могут отставать от компьютера, а tg-login не принимает данные входа «из будущего» больше чем
# на 5 минут (похоже, поэтому 28.09 вход падал с 401). Время для тестовых данных берём у стенда: он же его и проверяет
SKEW = float(sql("select extract(epoch from now())") or time.time()) - time.time()
if abs(SKEW) > 60:
    print(f"  (часы Docker расходятся с компьютером на {SKEW:+.0f} с — тесты берут время стенда)")


def _warm():
    """Будим функции до первых проверок: после перезапуска supabase functions serve первая просьба к каждой отвечает
    секундами, и проверки, ждущие реакцию бота по времени, на этом падали (30.10)."""
    def one(target):
        method, path = target
        for _ in range(60):
            try:
                if req(method, "/functions/v1/" + path)[0] < 500:
                    return
            except OSError:   # контейнер функций ещё поднимается
                pass
            time.sleep(1)
        raise SystemExit(f"функция {path} не отвечает минуту — перезапусти supabase functions serve --env-file supabase/functions/.env")
    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, [("GET", "tg-bot?diag=1"), ("OPTIONS", "tg-login"), ("OPTIONS", "photos"), ("OPTIONS", "recompute"),
                          ("OPTIONS", "bath-location")]))


def sweep():
    """Хвосты прерванных прогонов. Тест, упавший или остановленный посередине, не убирает за собой — и следующий прогон
    падал уже на чужих проверках (30.10: походы в бани «Тест-…», вопросы «где была баня?», заявки на точку). Убираем
    только то, что заводят сами тесты: бани «Тест-…», «Тестовая …» (с ними уходят их цены, вопросы, предложения Сверки), прогоны
    Радара и Сверки с пометкой test, включённые вопросы участникам."""
    test_baths = "select id from baths where name ~ '^(Тест|Проверка счётчика)'"
    sql(f"delete from visits where bath_id in ({test_baths})")
    sql(f"delete from baths where id in ({test_baths})")
    sql("delete from radar_places where key like 'test:%'")
    sql("delete from catalog_proposals where run like 'test%'")
    sql("""update settings set value = '"off"' where key = 'point_asks' and value <> '"off"'""")


_warm()
sweep()


def now():
    """Секунды Unix по часам стенда."""
    return int(time.time() + SKEW)


def tg_payload(tg_id, username, **extra):
    """Данные Telegram Login Widget с правильной подписью (как их подписывает Telegram)."""
    d = {"id": str(tg_id), "first_name": "Тест", "username": username, "auth_date": str(now()), **extra}
    check = "\n".join(f"{k}={d[k]}" for k in sorted(d))
    d["hash"] = hmac.new(hashlib.sha256(BOT_TOKEN.encode()).digest(), check.encode(), hashlib.sha256).hexdigest()
    return d


def login(tg_id, username, **extra):
    """Вход через tg-login → сессия Supabase. Возвращает (ответ tg-login, access_token)."""
    s, r = req("POST", "/functions/v1/tg-login", tg_payload(tg_id, username, **extra))
    assert s == 200, (s, r)
    s, sess = req("POST", "/auth/v1/verify", {"type": "magiclink", "token_hash": r["token_hash"]})
    assert s == 200, (s, sess)
    return r, sess["access_token"]


def session(tg_id, username, **extra):
    """То же, что login(), но целиком сессия Supabase — её сайт хранит в localStorage (для тестов в браузере)."""
    s, r = req("POST", "/functions/v1/tg-login", tg_payload(tg_id, username, **extra))
    assert s == 200, (s, r)
    s, sess = req("POST", "/auth/v1/verify", {"type": "magiclink", "token_hash": r["token_hash"]})
    assert s == 200, (s, sess)
    return sess


def link(nick, tg_username):
    """Комиссия заранее вписала username участника — при входе привяжется сам."""
    sql(f"insert into player_accounts (player_id, tg_username) select id, '{tg_username}' from players where nick = '{nick}' "
        f"and not exists (select 1 from player_accounts where tg_username = '{tg_username}')")


def player_id(nick):
    return sql(f"select id from players where nick = '{nick}'")


def check(label, cond, detail=""):
    print(("  ✓ " if cond else "  ✗ ") + label + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        raise SystemExit(1)
