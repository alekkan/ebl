"""Общие помощники для тестов на локальном стенде Supabase (`supabase start` + `supabase functions serve`)."""
import hashlib, hmac, json, subprocess, time, urllib.error, urllib.request

_status = json.loads(subprocess.run(["supabase", "status", "-o", "json"], capture_output=True, text=True).stdout or "{}")
API = _status.get("API_URL", "http://127.0.0.1:54321")
KEY = _status.get("PUBLISHABLE_KEY") or _status.get("ANON_KEY")
DB_CONTAINER = "supabase_db_ebl"
# должны совпадать с supabase/functions/.env (см. .env.example)
BOT_TOKEN = "123456:local-test-token-not-real"
WEBHOOK_SECRET = "local-webhook-secret"


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


def tg_payload(tg_id, username, **extra):
    """Данные Telegram Login Widget с правильной подписью (как их подписывает Telegram)."""
    d = {"id": str(tg_id), "first_name": "Тест", "username": username, "auth_date": str(int(time.time())), **extra}
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
