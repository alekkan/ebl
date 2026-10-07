"""Заглушка внешних сервисов для функций на локальном стенде: Telegram Bot API, геокодер OSM (Nominatim), npm-CDN, хранилище Яндекса (S3).

Без неё локальные функции ходили в интернет: tg-bot и tg-login — в api.telegram.org, week-results — за wasm на jsDelivr,
bath-location — в Nominatim. На медленной сети запросы висели, и проверки падали каждый раз в новом месте (28.09).
Адреса заглушки функции берут из supabase/functions/.env (см. .env.example), на бою переменные не заданы.
Поднимает её tests/local.py — в том же процессе, что и тест; пока тесты не идут, адрес просто не отвечает.
"""
import http.server, json, pathlib, re, subprocess, threading, time, urllib.parse
from email.parser import BytesParser
from email.policy import default as email_policy

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / "supabase" / "functions" / ".env"
EDGE_CONTAINER = "supabase_edge_runtime_ebl"
KEYS = ("TELEGRAM_API_URL", "NOMINATIM_URL", "NPM_CDN_URL", "S3_URL")
# файл фото из Telegram: file_id «photo-…» — есть (крошечный JPEG), остальные — «invalid file_id», как у настоящего
PHOTO_PREFIX = "photo-"
jpeg = lambda tag: b"\xff\xd8\xff\xe0" + tag.encode() + b"\xff\xd9"
# npm-пакеты функций уже лежат в кэше Deno внутри edge runtime (без них функция не запустится) — отдаём файлы оттуда,
# это те же байты, что на jsDelivr
NPM_CACHE = "/root/.cache/deno/npm/registry.npmjs.org"

# ответы Nominatim для точек из тестов — в том виде, в каком их отдаёт настоящий геокодер (zoom=5, accept-language=ru)
PLACES = [
    ((58.6036, 49.6601), {"address": {"state": "Кировская область", "ISO3166-2-lvl4": "RU-KIR", "region": "Приволжский федеральный округ",
                                      "country": "Россия", "country_code": "ru"}}),
    ((55.7558, 37.6176), {"address": {"state": "Москва", "ISO3166-2-lvl4": "RU-MOW",
                                      "region": "Центральный федеральный округ", "country": "Россия", "country_code": "ru"}}),
]


# ответы Nominatim /search для адресов из тестов (07.10: ссылка Google на место без координат и «название, город, страна»);
# город целиком (addresstype town) — не точка бани, бот его отбрасывает
SEARCH = {
    # как настоящий: английский адрес из ссылки Google не находит, а улицу без номера с городом — находит
    "Asanitsa, Bansko, Bulgaria": [{"lat": "41.8296", "lon": "23.4734", "addresstype": "road", "category": "highway"}],
    "St. George, Банско, Болгария": [{"lat": "41.8361", "lon": "23.4879", "addresstype": "hotel", "category": "tourism"}],
    "Центр, Банско, Болгария": [{"lat": "41.8380", "lon": "23.4880", "addresstype": "town", "category": "place"}],
}


def env_file():
    out = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


def edge_env():
    r = subprocess.run(["docker", "inspect", EDGE_CONTAINER, "--format", "{{json .Config.Env}}"], capture_output=True, text=True)
    return dict(e.split("=", 1) for e in json.loads(r.stdout or "[]") if "=" in e)


class Telegram:
    """Отвечает как Bot API на настоящий токен: сообщения получают номера, остальное — ok. Все вызовы записываются."""

    def __init__(self, token):
        self.token, self.calls, self._next, self._lock = token, [], 900000, threading.Lock()

    def handle(self, token, method, params):
        with self._lock:
            self.calls.append((method, params))
            if token != self.token:
                return 401, {"ok": False, "error_code": 401, "description": "Unauthorized"}
            chat = params.get("chat_id")
            chat = int(chat) if str(chat or "").lstrip("-").isdigit() else chat
            # 911 — закрыл личку боту: написать первым бот не может (так тесты проверяют запасной путь в чат)
            if method == "sendMessage" and chat == 911:
                return 403, {"ok": False, "error_code": 403, "description": "Forbidden: bot can't initiate conversation with a user"}
            if method in ("sendMessage", "sendPhoto", "sendLocation", "sendDocument", "copyMessage", "forwardMessage"):
                self._next += 1
                return 200, {"ok": True, "result": {"message_id": self._next, "date": int(time.time()), "chat": {"id": chat},
                                                   "text": params.get("text") or params.get("caption") or ""}}
            if method.startswith("editMessage"):
                return 200, {"ok": True, "result": {"message_id": int(params.get("message_id") or 0), "date": int(time.time()),
                                                   "chat": {"id": chat}, "text": params.get("text") or ""}}
            if method == "getUserProfilePhotos":
                return 200, {"ok": True, "result": {"total_count": 0, "photos": []}}
            if method == "getFile":
                fid = str(params.get("file_id") or "")
                if fid.startswith(PHOTO_PREFIX):
                    return 200, {"ok": True, "result": {"file_id": fid, "file_unique_id": fid, "file_path": f"photos/{fid}.jpg"}}
                return 400, {"ok": False, "error_code": 400, "description": "Bad Request: invalid file_id"}
            if method == "getMe":
                return 200, {"ok": True, "result": {"id": int(self.token.split(":")[0]), "is_bot": True, "first_name": "ЕБЛ", "username": "eblsu_bot",
                                                   "can_read_all_group_messages": True}}
            if method == "getChatMember":
                # 902 — вышел из чата (бот его забывает); 910 — на первый вопрос «подожди» (429), как Telegram при частых
                # вопросах; остальные — участники
                uid = int(params.get("user_id") or 0)
                if uid == 910 and not any(m == "getChatMember" and int(p.get("user_id") or 0) == 910 for m, p in self.calls[:-1]):
                    return 429, {"ok": False, "error_code": 429, "description": "Too Many Requests: retry after 1", "parameters": {"retry_after": 1}}
                return 200, {"ok": True, "result": {"status": "left" if uid == 902 else "member",
                                                   "user": {"id": uid, "is_bot": False, "first_name": f"Участник{uid}"}}}
            if method == "getWebhookInfo":
                return 200, {"ok": True, "result": {"url": "", "has_custom_certificate": False, "pending_update_count": 0}}
            return 200, {"ok": True, "result": True}


def reverse(q):
    try:
        lat, lon = float(q["lat"][0]), float(q["lon"][0])
    except (KeyError, ValueError):
        return 400, {"error": "lat/lon"}
    for (plat, plon), answer in PLACES:
        if abs(lat - plat) < 0.05 and abs(lon - plon) < 0.05:
            return 200, answer
    return 200, {"error": "Unable to geocode"}


_npm = {}


def npm_file(path):
    m = re.match(r"^(@[^/]+/[^/@]+|[^/@]+)@([^/]+)/(.+)$", path)
    if not m or ".." in path:
        return None
    if path not in _npm:
        r = subprocess.run(["docker", "exec", EDGE_CONTAINER, "cat", f"{NPM_CACHE}/{m[1]}/{m[2]}/{m[3]}"], capture_output=True)
        _npm[path] = r.stdout if r.returncode == 0 and r.stdout else None
    return _npm[path]


def start(token):
    """Поднимает заглушку на порту из supabase/functions/.env; возвращает объект с журналом вызовов Telegram."""
    env = env_file()
    missing = [k for k in KEYS if not env.get(k)]
    if missing:
        raise SystemExit(f"В supabase/functions/.env нет {', '.join(missing)} — без них функции ходят в интернет. "
                         "Допиши строки из supabase/functions/.env.example и перезапусти supabase functions serve --env-file supabase/functions/.env")
    running = edge_env()
    stale = [k for k in KEYS if running.get(k) != env[k]]
    if stale:
        raise SystemExit(f"supabase functions serve запущен со старым .env ({', '.join(stale)} не совпадают) — перезапусти: "
                         "supabase functions serve --env-file supabase/functions/.env")
    tg = Telegram(token)
    tg.s3 = {}
    prefixes = {k: urllib.parse.urlsplit(env[k]).path.rstrip("/") for k in KEYS}
    port = urllib.parse.urlsplit(env["TELEGRAM_API_URL"]).port

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def reply(self, status, body, ctype="application/json"):
            data = json.dumps(body, ensure_ascii=False).encode() if ctype == "application/json" else body
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def params(self, query):
            out = {k: v[0] for k, v in urllib.parse.parse_qs(query).items()}
            n = int(self.headers.get("Content-Length") or 0)
            raw, ctype = (self.rfile.read(n) if n else b""), self.headers.get("Content-Type") or ""
            if ctype.startswith("application/json") and raw:
                out.update(json.loads(raw))
            elif ctype.startswith("application/x-www-form-urlencoded"):
                out.update({k: v[0] for k, v in urllib.parse.parse_qs(raw.decode()).items()})
            elif ctype.startswith("multipart/form-data"):
                msg = BytesParser(policy=email_policy).parsebytes(b"Content-Type: " + ctype.encode() + b"\r\n\r\n" + raw)
                for part in msg.iter_parts():
                    name = part.get_param("name", header="content-disposition")
                    if name and not part.get_filename():
                        out[name] = part.get_content()
            return out

        def route(self):
            u = urllib.parse.urlsplit(self.path)
            if u.path.startswith(prefixes["TELEGRAM_API_URL"] + "/file/bot"):
                m = re.match(r"^/file/bot([^/]+)/photos/(" + PHOTO_PREFIX + r"[\w-]+)\.jpg$", u.path[len(prefixes["TELEGRAM_API_URL"]):])
                if m and m[1] == tg.token:
                    return self.reply(200, jpeg(m[2]), "application/octet-stream")   # Telegram отдаёт файлы без типа
                return self.reply(404, {"ok": False, "error_code": 404, "description": "Not Found"})
            if u.path.startswith(prefixes["S3_URL"] + "/"):
                return self.s3(u.path[len(prefixes["S3_URL"]) + 1:])
            if u.path.startswith(prefixes["TELEGRAM_API_URL"] + "/bot"):
                m = re.match(r"^/bot([^/]+)/(\w+)$", u.path[len(prefixes["TELEGRAM_API_URL"]):])
                if m:
                    return self.reply(*tg.handle(m[1], m[2], self.params(u.query)))
            if u.path.startswith(prefixes["NOMINATIM_URL"] + "/"):
                what = u.path[len(prefixes["NOMINATIM_URL"]) + 1:]
                if what == "reverse":
                    return self.reply(*reverse(urllib.parse.parse_qs(u.query)))
                if what == "search":
                    return self.reply(200, SEARCH.get(urllib.parse.parse_qs(u.query).get("q", [""])[0], []))
            if u.path.startswith(prefixes["NPM_CDN_URL"] + "/"):
                data = npm_file(u.path[len(prefixes["NPM_CDN_URL"]) + 1:])
                if data:
                    return self.reply(200, data, "application/wasm" if u.path.endswith(".wasm") else "application/octet-stream")
                return self.reply(404, {"error": f"нет в кэше npm у {EDGE_CONTAINER}: {u.path}"})
            self.rfile.read(int(self.headers.get("Content-Length") or 0))   # непрочитанное тело при закрытии — это сброс соединения
            self.reply(404, {"ok": False, "error_code": 404, "description": "Not Found (заглушка тестов)"})

        # бакет Яндекса: PUT кладёт (только с подписью AWS4 — как настоящий), GET/HEAD отдают; всё в памяти (tg.s3)
        def s3(self, path):
            if self.command == "PUT":
                if not (self.headers.get("Authorization") or "").startswith("AWS4-HMAC-SHA256"):
                    return self.reply(403, {"error": "AccessDenied"})
                n = int(self.headers.get("Content-Length") or 0)
                tg.s3[path] = {"body": self.rfile.read(n) if n else b"", "type": self.headers.get("Content-Type"),
                               "cache": self.headers.get("Cache-Control")}
                return self.reply(200, b"", "application/xml")
            obj = tg.s3.get(path)
            if not obj:
                return self.reply(404, {"error": "NoSuchKey"})
            return self.reply(200, b"" if self.command == "HEAD" else obj["body"], obj["type"] or "application/octet-stream")

        do_GET = do_POST = do_PUT = do_HEAD = route

    class Server(http.server.ThreadingHTTPServer):
        request_queue_size = 128   # по умолчанию 5: функции зовут Telegram пачками, лишние соединения сбрасывались бы

    try:
        srv = Server(("127.0.0.1", port), Handler)
    except OSError as e:
        raise SystemExit(f"Порт заглушки {port} занят ({e}): видимо, тесты уже идут в другом окне — дождись их")
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    tg.server = srv
    return tg
