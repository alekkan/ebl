"""Общие помощники для тестов на локальном стенде Supabase (`supabase start` + `supabase functions serve`)."""
import hashlib, hmac, json, subprocess, time, urllib.error, urllib.request
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
        with urllib.request.urlopen(r) as resp:
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


def sql(q):
    return subprocess.run(["docker", "exec", DB_CONTAINER, "psql", "-U", "postgres", "-tAc", q], capture_output=True, text=True).stdout.strip()


# Telegram, геокодер и npm-CDN для функций — заглушка в этом же процессе (tests/stub.py): без интернета и без зависаний
TELEGRAM = stub.start(BOT_TOKEN)
# триггеры базы должны звать локальные функции, а не боевые (после db reset там боевой адрес), расписания pg_cron — снять:
# они зашиты на боевые адреса (см. AGENTS.md)
if sql("select value #>> '{}' from settings where key = 'functions_url'") != LOCAL_FUNCTIONS:
    sql(f"""update settings set value = '"{LOCAL_FUNCTIONS}"' where key = 'functions_url'""")
sql("select cron.unschedule(jobname) from cron.job")
# часы Docker после сна Mac могут отставать от компьютера, а tg-login не принимает данные входа «из будущего» больше чем
# на 5 минут (похоже, поэтому 28.09 вход падал с 401). Время для тестовых данных берём у стенда: он же его и проверяет
SKEW = float(sql("select extract(epoch from now())") or time.time()) - time.time()
if abs(SKEW) > 60:
    print(f"  (часы Docker расходятся с компьютером на {SKEW:+.0f} с — тесты берут время стенда)")


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
