"""Сквозная проверка сайта в настоящем браузере: гость, участник, Комиссия, режим витрины, телефон.

Сайт (prototype/) открывается против локального стенда Supabase: config.js подменяется на локальный,
сессия участника подкладывается в localStorage — так же, как её хранит supabase-js после входа через Telegram.
Любая ошибка в консоли, упавший сценарий или вылезшая за экран вёрстка — провал.

Перед запуском: supabase start, supabase functions serve (см. AGENTS.md). Нужен Google Chrome.
Запуск: python3 tests/test_site.py        (скриншоты провалов — в tests/artifacts/)
"""
import base64, functools, http.server, json, pathlib, re, threading, time, urllib.error, urllib.parse, urllib.request
from playwright.sync_api import sync_playwright
import stub
from local import API, KEY, TELEGRAM, check, link, player_id, session, sql

ROOT = pathlib.Path(__file__).resolve().parent.parent
ART = ROOT / "tests" / "artifacts"
# фото походов — из заглушки хранилища (tests/stub.py): функции ходят в неё через host.docker.internal, браузер — напрямую
PHOTOS = stub.env_file()["S3_URL"].replace("host.docker.internal", "127.0.0.1") + "/ebl-photos"
STUB_PORT = urllib.parse.urlsplit(PHOTOS).port
LIVE_CONFIG = f'window.EBL_CONFIG = {{ supabaseUrl: "{API}", supabaseKey: "{KEY}", telegramBot: "eblsu_bot", telegramBotId: 1, photosUrl: "{PHOTOS}" }};'
SHOWCASE_CONFIG = 'window.EBL_CONFIG = { supabaseUrl: "", supabaseKey: "", telegramBot: "" };'
# ключ, под которым supabase-js хранит сессию: sb-<первая часть адреса>-auth-token
AUTH_KEY = "sb-" + API.split("//")[1].split(".")[0].split(":")[0] + "-auth-token"
VIEWS = ["map", "owners", "table", "feed", "rules"]
# всё, что не со стенда и не с локального сервера сайта
EXTERNAL = re.compile(r"^https?://(?!(127\.0\.0\.1|localhost)[:/])")
DEAD = "http://127.0.0.1:9"   # сюда не подключиться — как шлюз Яндекса за VPN, который его не пускает
TILE = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=")

# вёрстка: элемент с текстом вылез за свой контейнер (без прокрутки) или за экран; карты и прокручиваемые таблицы — не в счёт
CLIP_JS = """(root) => {
  const out = [];
  for (const el of (document.querySelector(root) || document.body).querySelectorAll('*')) {
    if (el.closest('.leaflet-container')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.position === 'fixed' || cs.textOverflow === 'ellipsis') continue;
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText && !['IMG', 'svg', 'INPUT', 'SELECT', 'BUTTON'].includes(el.tagName)) continue;
    let a = el.parentElement, bad = null, scroll = false;
    while (a && a !== document.body) {
      const ac = getComputedStyle(a);
      if (ac.overflowX !== 'visible') {
        if (ac.overflowX === 'auto' || ac.overflowX === 'scroll') { scroll = true; break; }
        const ar = a.getBoundingClientRect();
        if (r.right > ar.right + 1.5 || r.left < ar.left - 1.5) bad = Math.round(r.right - ar.right);
        break;
      }
      a = a.parentElement;
    }
    if (bad === null && !scroll && r.right > innerWidth + 1) bad = Math.round(r.right - innerWidth);
    if (bad !== null) out.push(`${el.tagName}.${[...el.classList].join('.')} «${(el.innerText || '').trim().slice(0, 20)}» +${bad}px`);
  }
  return [...new Set(out)].slice(0, 6);
}"""

# нижнее меню на телефоне: вкладка кончается там, где начинается меню, и ничего из <main> не лежит поверх него
# (28.09 клики по меню на «Жаре» ловили тайлы карты; подпись карты рисовалась на меню, низ карточки «Жара» уходил под него)
NAV_FREE_JS = """() => {
  const nav = document.querySelector('.nav'), n = nav.getBoundingClientRect(), out = [];
  const view = [...document.querySelectorAll('.view')].find((v) => !v.hidden)?.getBoundingClientRect();
  if (view && view.bottom > n.top + 0.5) out.push(`вкладка уходит под меню на ${Math.round(view.bottom - n.top)} px`);
  for (const y of [n.top + 1, n.top + 6, (n.top + n.bottom) / 2, n.bottom - 2]) for (let x = 2; x < innerWidth; x += 16) {
    const el = document.elementFromPoint(x, y);
    if (el && !nav.contains(el)) out.push(`${x},${Math.round(y)}: ${el.tagName}.${[...el.classList].slice(0, 2).join('.')}`);
  }
  return [...new Set(out)].slice(0, 5);
}"""
# кнопки масштаба карты не лежат на карточке рядом (на «Жаре» они сидели поверх её заголовка)
ZOOM_OVER_JS = """([map, card]) => {
  const z = document.querySelector(map + ' .leaflet-control-zoom')?.getBoundingClientRect(), c = document.querySelector(card)?.getBoundingClientRect();
  return !!(z && c && z.width && c.width) && z.left < c.right && z.right > c.left && z.top < c.bottom && z.bottom > c.top;
}"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


class Server(http.server.ThreadingHTTPServer):
    # очередь соединений по умолчанию — 5: Chrome открывает сразу шесть, и часть сбрасывалась (ERR_CONNECTION_RESET на vendor/*.js) —
    # без Leaflet сайт падал, и тест проваливался в случайном месте («шлюз отвечает», «Комиссия видит кнопки», 28.09)
    request_queue_size = 128


def serve():
    handler = functools.partial(Quiet, directory=str(ROOT / "prototype"))
    srv = Server(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/"


class Site:
    """Страница сайта с собранными ошибками консоли; config.js — локальный стенд или витрина."""

    def __init__(self, browser, url, *, config=LIVE_CONFIG, sess=None, mobile=False, name="site", route=None, noise=None, init=None):
        self.name = name
        self.noise = noise   # ещё одна нарочная ошибка сценария (подстрока адреса), кроме мёртвого DEAD
        self.ctx = browser.new_context(viewport={"width": 375, "height": 812} if mobile else {"width": 1280, "height": 860},
                                       is_mobile=mobile, has_touch=mobile)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("console", lambda m: m.type == "error" and not self._noise(m) and self.errors.append(f"{m.text} ({(m.location or {}).get('url', '')[-60:]})"))
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.route(EXTERNAL, self._offline)
        self.page.route("**/config.js*", lambda r: r.fulfill(body=config, content_type="application/javascript"))
        if route:   # (шаблон адреса, обработчик) — подменить ответ API в сценарии
            self.page.route(*route)
        if sess:
            self.page.add_init_script(f"localStorage.setItem({json.dumps(AUTH_KEY)}, {json.dumps(json.dumps(sess))})")
        if init:   # скрипт до загрузки страницы — подменить поведение сети в сценарии
            self.page.add_init_script(init)
        self.page.on("dialog", lambda d: d.accept("проверка сайта"))   # причина отказа и т. п.
        self.page.goto(url)
        # загрузка кончается либо сайтом, либо плашкой «Не получилось загрузить данные: …» — её текст и есть причина
        self.page.wait_for_function("() => !document.getElementById('boot') || document.getElementById('boot').classList.contains('err')", timeout=20000)
        err = self.js("() => document.getElementById('boot')?.innerText || ''")
        if err:
            ART.mkdir(exist_ok=True)
            self.page.screenshot(path=str(ART / f"{name}-boot.png"))
        check(f"{name}: сайт загрузился", not err, err)
        if self.errors:   # не догрузился скрипт — дальше всё посыплется, причину показываем сразу
            check(f"{name}: страница загрузилась без ошибок", False, self.errors[:3])

    def _offline(self, route):
        """Сайт в тестах — без интернета: шрифты Google пустые (остаются системные), тайлы карт прозрачные, геокодер отвечает
        как настоящий. На медленной сети они держали загрузку страницы и клики (28.09). Любой другой запрос наружу — ошибка:
        значит, сайт полез куда-то, чего тесты не знают (а в России часть адресов режут)."""
        u = urllib.parse.urlsplit(route.request.url)
        if u.hostname == "fonts.googleapis.com":
            return route.fulfill(body="", content_type="text/css")
        if u.hostname in ("tile.openstreetmap.org", "server.arcgisonline.com"):
            return route.fulfill(body=TILE, content_type="image/png")
        if u.hostname == "host.docker.internal" and u.port == STUB_PORT:
            # одноразовая ссылка на бакет от функции photos: функции видят заглушку по этому имени, браузер — по 127.0.0.1
            r = route.request
            fwd = urllib.request.Request(r.url.replace("host.docker.internal", "127.0.0.1"), data=r.post_data_buffer, method=r.method,
                                         headers={k: v for k, v in r.headers.items() if k.lower() in ("content-type", "cache-control")})
            try:
                with urllib.request.urlopen(fwd, timeout=10) as resp:
                    status, body = resp.status, resp.read()
            except urllib.error.HTTPError as e:
                status, body = e.code, e.read()
            return route.fulfill(status=status, body=body, headers={"Access-Control-Allow-Origin": "*"})
        if u.hostname == "nominatim.openstreetmap.org" and u.path == "/reverse":
            status, body = stub.reverse(urllib.parse.parse_qs(u.query))
            return route.fulfill(status=status, json=body, headers={"Access-Control-Allow-Origin": "*"})
        self.errors.append(f"сайт полез в интернет: {route.request.url[:120]}")
        route.abort()

    def _noise(self, m):
        # не ошибка сайта — только нарочно мёртвый адрес в проверке двух путей к базе; тайлы и шрифты подменены (_offline),
        # а сбой загрузки своих файлов прятать нельзя: так пряталась причина провалов 28.09
        where = m.text + " " + (m.location or {}).get("url", "")
        return DEAD in where or bool(self.noise and self.noise in where)

    def js(self, code, arg=None):
        return self.page.evaluate(code, arg)

    def view(self, v):
        self.page.click(f'.nav [data-view="{v}"]')
        self.page.wait_for_timeout(500)

    def clean(self, label):
        ok = not self.errors
        if not ok:
            ART.mkdir(exist_ok=True)
            self.page.screenshot(path=str(ART / f"{self.name}.png"))
        check(f"{label} — без ошибок в консоли", ok, self.errors[:3])
        self.errors.clear()

    def no_clip(self, label, root="body"):
        clipped = self.js(CLIP_JS, root)
        if clipped:
            ART.mkdir(exist_ok=True)
            self.page.screenshot(path=str(ART / f"{self.name}-clip.png"))
        check(f"{label} — ничего не вылезает", not clipped, clipped)

    def nav_free(self, label):
        bad = self.js(NAV_FREE_JS)
        if bad:
            ART.mkdir(exist_ok=True)
            self.page.screenshot(path=str(ART / f"{self.name}-nav.png"))
        check(f"{label} — нижнее меню ничем не перекрыто", not bad, bad)

    def close(self):
        away = [e for e in self.errors if e.startswith("сайт полез в интернет")]
        if away:   # и там, где консоль не проверяем (два пути к базе, гость и даты)
            check(f"{self.name}: сайт не ходит в интернет мимо известных адресов", False, away[:3])
        self.ctx.close()


def swipe(s, x, y0, y1, steps=8, ms=120):
    """Провести пальцем по экрану телефона (настоящие касания через CDP): быстро — взмах, медленно (больше шагов и мс) — протянуть."""
    cdp = s.ctx.new_cdp_session(s.page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y0}]})
    for i in range(1, steps + 1):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": y0 + (y1 - y0) * i / steps}]})
        s.page.wait_for_timeout(ms // steps)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    s.page.wait_for_timeout(500)


def all_views(s, label, mobile=False):
    for v in VIEWS:
        s.view(v)
        if mobile:
            s.no_clip(f"{label}: «{v}» на телефоне", f"#view-{v}")
            s.nav_free(f"{label}: «{v}» на телефоне")
        elif v in ("map", "owners"):
            check(f"{label}: на «{v}» кнопки масштаба не лежат на карточке",
                  not s.js(ZOOM_OVER_JS, ["#map", "#view-map .panel"] if v == "map" else ["#ownmap", "#view-owners .own-card"]))
    s.view("table")
    s.page.click('#tMode [data-m="week"]')
    s.page.wait_for_selector("#tWeek:not([hidden])", timeout=8000)
    check(f"{label}: недельный зачёт открылся", s.js("() => !document.getElementById('tWeek').hidden && document.querySelectorAll('#weekTable tbody tr').length > 0"))
    # пустые места пьедестала — бледная ступенька, а не заглушка .empty с фоном и тенью (19.10 стали серыми плашками)
    check(f"{label}: на недельном пьедестале у мест нет плашек-заглушек",
          s.js("() => [...document.querySelectorAll('#weekPodium .pod')].every((p) => !p.classList.contains('empty') && getComputedStyle(p).boxShadow === 'none' && getComputedStyle(p).backgroundColor === 'rgba(0, 0, 0, 0)')"))
    if mobile:
        s.no_clip(f"{label}: недельный зачёт на телефоне", "#view-table")
    s.page.click('#tMode [data-m="season"]')
    s.page.click("#standings tbody tr")
    check(f"{label}: карточка участника открылась", s.js("() => !document.getElementById('playerModal').hidden"))
    s.js("() => (document.getElementById('playerModal').hidden = true)")
    s.view("map")
    s.page.click("#list .item[data-id]")
    s.page.wait_for_timeout(700)
    check(f"{label}: карточка бани открылась", s.js("() => !document.getElementById('drawer').hidden"))
    s.page.click("#drawer .x")
    s.clean(label)


with sync_playwright() as pw:
    url = serve()
    browser = pw.chromium.launch(channel="chrome", headless=True)
    link("Шурик", "shurik_tg"); link("Витёк", "vitek_tg")
    shurik, vitek = session(2002, "Shurik_TG"), session(3003, "vitek_tg")
    # как на бою: портал считает текущую неделю (иначе засчитанный поход этой недели не даст очков)
    cutover = sql("select value #>> '{}' from settings where key = 'cutover_week'")
    sql("update settings set value = to_jsonb((select max(w) from (values (39)) t(w))) where key = 'cutover_week'")
    bath = int(sql("select id from baths where name = 'Василевские' limit 1"))
    sql(f"update baths set closed_on = null where id = {bath}")   # упавший прогон мог оставить её закрытой — тогда форма её не предложит
    # следы прошлых прогонов (упавший тест не успел убрать свой поход)
    sql(f"delete from visits where source = 'site' and bath_id = {bath} and created_by = '{player_id('Шурик')}' and created_at > now() - interval '2 days'")
    before = set(sql("select coalesce(string_agg(id::text, ','), '') from visits").split(",")) - {""}

    try:
        print("Без Cloudflare")
        # в России провайдеры режут Cloudflare: без VPN сайт висел на заставке (28.09) — из браузера к нему ни одного запроса
        html, cfg = (ROOT / "prototype" / "index.html").read_text(), (ROOT / "prototype" / "config.js").read_text()
        check("страница не тянет библиотеки с cdnjs / jsDelivr / unpkg (они за Cloudflare) — всё из prototype/vendor",
              not any(h in html for h in ("cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com")))
        check("API сайта — через шлюз в Яндексе, а не напрямую *.supabase.co", "supabase.co" not in cfg.split("supabaseUrl:")[1].split("\n")[0])

        print("Два пути к базе")
        dead = DEAD
        cfg2 = lambda main, direct: f'window.EBL_CONFIG = {{ supabaseUrl: "{main}", directUrl: "{direct}", supabaseKey: "{KEY}", telegramBot: "eblsu_bot", telegramBotId: 1 }};'
        s = Site(browser, url, config=cfg2(dead, API), name="fallback-direct")
        check("шлюз недоступен (VPN не пускает к Яндексу) — сайт идёт в базу напрямую и загружается", s.js("() => document.querySelectorAll('#list .item').length > 0"))
        s.close()
        s = Site(browser, url, config=cfg2(API, dead), name="fallback-main")
        check("шлюз отвечает — работаем через него, прямой путь не нужен", s.js("() => document.querySelectorAll('#list .item').length > 0"))
        s.close()
        # 08.10: в плохую минуту связи Яндекса с Cloudflare шлюз на первый же запрос ответил 503, сайт счёл его недоступным
        # и ушёл напрямую — а без VPN там режутся большие ответы, и сайт висел на заставке. Отдельной проверки шлюза с 15.10 нет:
        # первый же запрос (бани) получает 503 — сайт должен повторить его через шлюз, а не уходить на мёртвый прямой путь
        busy_once = {"left": 1}
        def busy(route):
            if busy_once["left"]:
                busy_once["left"] -= 1
                return route.fulfill(status=503, body='{"message":"upstream"}', headers={"Access-Control-Allow-Origin": "*"})
            return route.continue_()
        s = Site(browser, url, config=cfg2(API, dead), name="gateway-503", route=("**/rest/v1/rpc/boot_public*", busy), noise="/rest/v1/rpc/boot_public")
        check("шлюз ответил 503 (Supabase за ним не ответил) — повторяем через шлюз, а не уходим напрямую",
              s.js("() => document.querySelectorAll('#list .item').length > 0") and busy_once["left"] == 0)
        s.close()
        # 16.10: через шлюз примерно каждый десятый запрос застревает на 1–4 с, а заставка ждёт самый медленный. Всё общее —
        # одним запросом (boot_public), и чтение, не ответившее за 0,8 с, сайт дублирует и берёт первый ответ.
        # Здесь первый запрос общих данных «застревает» на 6 с — заставка его ждать не должна
        stuck = """(() => {
          const real = window.fetch; let first = true; window.__boot = 0;
          window.fetch = (u, o = {}) => {
            if (!String(u).includes('/rest/v1/rpc/boot_public')) return real(u, o);
            window.__boot++;
            if (!first) return real(u, o);
            first = false;
            return new Promise((ok, no) => {
              const t = setTimeout(() => real(u, o).then(ok, no), 6000);
              o.signal?.addEventListener('abort', () => { clearTimeout(t); no(new DOMException('отменён', 'AbortError')); });
            });
          };
        })()"""
        s = Site(browser, url, name="gateway-stuck", init=stuck)
        took = s.js("() => performance.now()")
        check("общие данные — одним запросом; застрял — через 0,8 с дубль, заставка не ждёт застрявший",
              s.js("() => window.__boot") == 2 and took < 4500 and s.js("() => document.querySelectorAll('#list .item').length > 0"), (s.js("() => window.__boot"), round(took)))
        s.clean("дубль застрявшего запроса")
        s.close()

        print("Гость")
        s = Site(browser, url, name="guest")
        check("сайт загрузился, кнопка «Войти» на месте", s.js("() => document.getElementById('meBtn').innerText.includes('Войти')"))
        # 16.10: запрос данных уходит из самой страницы, пока качаются скрипты, а ключ — в адресе (без проверки CORS);
        # db.js берёт этот ответ, второго такого же запроса нет
        boots = s.js("() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/rpc/boot_public')).map((e) => e.name)")
        check("данные первого экрана — одним ранним запросом из страницы (ключ в адресе), без второго такого же",
              len(boots) == 1 and "apikey=" in boots[0], boots)
        # карта создаётся до данных сразу в рамке главной: ранние тайлы — те же, что нужны после данных (16.10: стояла на Москве
        # в зуме 5, после данных уезжала в зум 4 — ранние выбрасывались, и подложка всё равно ждала данных)
        zooms = s.js("() => [...new Set(performance.getEntriesByType('resource').filter((e) => e.name.includes('tile.openstreetmap.org')).map((e) => e.name.split('/')[3]))]")
        check("подложка при загрузке — одного масштаба: тайлы, скачанные до данных, не выброшены", len(zooms) == 1, zooms)
        all_views(s, "гость")
        s.page.click("#addVisitBtn")
        check("гость на «Добавить баню» — окно входа", s.js("() => !document.getElementById('loginModal').hidden"))
        check("гостю вкладки «Бани» (справочник Комиссии) нет", s.js("() => document.querySelector('.nav [data-view=\"dir\"]').hidden"))
        # выбранная баня — капля (16.10): раньше кружок получал класс «sel» выпадающих списков, расплющивался в овал и терял силуэт
        s.page.keyboard.press("Escape")
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(1500)
        s.page.fill("#q", ""); s.page.wait_for_timeout(500)   # все бани снова на карте — капля остаётся у открытой
        check("выбранная баня на карте — одна капля (внутри силуэт типа или точка), остальные — ровные кружки",
              s.js("""() => document.querySelectorAll('#map .pin-drop').length === 1 && !!document.querySelector('#map .pin-drop svg use, #map .pin-drop .pin-dot')
                && document.querySelectorAll('#map .pin').length > 0 && [...document.querySelectorAll('#map .pin')].every((p) => p.offsetWidth === p.offsetHeight)"""))
        s.page.click("#drawer .x"); s.page.wait_for_timeout(300)
        check("закрыл карточку — капля снова кружок", s.js("() => !document.querySelector('#map .pin-drop')"))
        # 18.10: тап по пустому месту карты закрывает карточку бани
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(1200)
        empty = s.js("""() => { const m = document.getElementById('map').getBoundingClientRect();
          for (let y = m.bottom - 40; y > m.top + 40; y -= 37) for (let x = m.right - 40; x > m.left + 40; x -= 41) {
            const el = document.elementFromPoint(x, y);
            if (el && el.closest('#map') && !el.closest('.leaflet-marker-icon, .leaflet-control, .marker-cluster, .panel, .drawer, .race')) return [x, y]; }
          return null; }""")
        if empty:
            s.page.mouse.click(*empty); s.page.wait_for_timeout(400)
        check("тап по пустому месту карты закрывает карточку бани", bool(empty) and s.js("() => document.getElementById('drawer').hidden"), empty)
        s.clean("гость: капля выбранной бани")
        s.close()

        # вход кодом из бота (16.10): на компьютере — QR для телефона и код; подтвердили в боте — сайт входит сам
        s = Site(browser, url, name="code-login")
        s.page.click("#meBtn")
        s.page.wait_for_selector("#loginQr svg", timeout=8000)
        code = s.js("() => document.querySelector('.login-code').innerText.replace('-', '')")
        check("окно входа на компьютере: QR-код и код для бота со ссылкой на него",
              len(code) == 6 and s.js("(c) => document.querySelector('#loginWay a').href === 'https://t.me/eblsu_bot?start=login_' + c", code), code)
        s.page.click("#loginAlt")
        check("«Другие способы входа» — прежняя страница Telegram", s.js("() => !!document.getElementById('tgLogin')"))
        s.page.click("#loginAlt")
        s.page.wait_for_selector("#loginQr svg", timeout=8000)
        check("вернулся ко входу через бота — тот же код, не новый", s.js("() => document.querySelector('.login-code').innerText.replace('-', '')") == code)
        with s.page.expect_navigation(timeout=15000):
            # как после «✅ Да, это я» в боте (сам бот — в test_bot.py)
            sql(f"update login_codes set tg_id = 2002, tg_username = 'Shurik_TG', tg_name = 'Тест', confirmed_at = now() where code = '{code}'")
        s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        check("подтвердил в боте — сайт вошёл сам", s.js("() => document.getElementById('meBtn').getAttribute('aria-label') === 'Профиль: Шурик'"))
        s.clean("вход кодом из бота")
        s.close()

        print("Участник")
        s = Site(browser, url, sess=shurik, name="member")
        check("вошёл как Шурик — в шапке аватарка, лента открыта", s.js("() => document.getElementById('meBtn').getAttribute('aria-label') === 'Профиль: Шурик'"))
        all_views(s, "участник")
        s.view("feed")
        check("участнику видна лента походов", s.js("() => !!document.querySelector('#feedFilter button')"))
        # «Хозяева бань» (15.10, вместо «Жара»): хозяин — больше всех походов в бане за сезон, от двух
        s.view("owners"); s.page.wait_for_timeout(500)
        # бань с хозяином на карте: отдельные аватарки и числа на группах (18.10: при отдалении — группами)
        pins = lambda: s.js("() => [...document.querySelectorAll('#ownmap .own-pin')].reduce((a, p) => a + (p.classList.contains('own-cluster') ? +p.querySelector('b').innerText : 1), 0)")
        before_pins = pins()
        check("«Хозяева»: на карте аватарки хозяев, сбоку — кто сколькими владеет",
              before_pins > 0 and s.js("() => document.querySelectorAll('#oList li[data-owner]').length > 0"))
        check("«Хозяева»: в Москве аватарки не налезают — при отдалении собраны в группы с аватарками хозяев и числом бань",
              s.js("() => { const c = document.querySelector('#ownmap .own-cluster'); return !!c && c.querySelectorAll('.ava').length >= 1 && +c.querySelector('b').innerText >= 2; }"))
        check("«Хозяева»: участнику — где он хозяин и какую шапку ближе всего отжать", s.js("() => /хозяин/.test(document.getElementById('oMe').innerText)"))
        owned = int(s.js("() => document.querySelector('#oList li[data-owner] .hv').innerText"))
        s.page.click("#oList li[data-owner]"); s.page.wait_for_timeout(500)
        check("нажал на хозяина — на карте только его бани", owned <= pins() < before_pins, (owned, pins(), before_pins))
        check("участнику (не Комиссии) вкладки «Бани» нет", s.js("() => document.querySelector('.nav [data-view=\"dir\"]').hidden"))
        # поход через форму: баня из справочника + попутчик
        s.page.click("#addVisitBtn")
        check("участнику «Кто» не выбрать — поход только за себя, и поля «Кто» у него нет",
              s.js("() => document.getElementById('vPlayer').disabled && document.getElementById('vPlayerHint').hidden && document.getElementById('vPlayerField').hidden"))
        s.page.fill("#vBathQ", "Василевские")
        s.page.click(f'#vSuggest button[data-id="{bath}"]')
        s.page.press("#vDate", "Enter")
        check("Enter в поле не отправляет форму", s.js("() => !document.getElementById('visitModal').hidden"))
        s.page.click('#vDurChips button[data-m="180"]')
        check("пока никого не выбрал — ссылки про разную длительность нет", s.js("() => document.getElementById('vDursToggle').hidden"))
        # 18.10: «С кем был» — не стена из всей лиги: сначала до 8 частых попутчиков, остальные — по «Все участники», с поиском
        total_players = s.js("() => document.getElementById('vPlayer').options.length") - 1
        check("«С кем был»: сначала до 8 частых попутчиков, остальные — по «Все участники»",
              s.js("() => document.querySelectorAll('#vComp button').length") <= 8 and s.js("() => !document.getElementById('vCompAll').hidden"))
        s.page.click("#vCompAll"); s.page.wait_for_timeout(200)
        check("…«Все участники» — вся лига и поиск по нику", s.js("() => document.querySelectorAll('#vComp button').length") == total_players
              and s.js("() => !document.getElementById('vCompQ').hidden"), (s.js("() => document.querySelectorAll('#vComp button').length"), total_players))
        s.page.fill("#vCompQ", "вит"); s.page.wait_for_timeout(200)
        check("…поиск по нику сужает список", s.js("() => [...document.querySelectorAll('#vComp button')].every((b) => /вит/i.test(b.dataset.p))"))
        s.page.fill("#vCompQ", ""); s.page.click("#vCompAll"); s.page.wait_for_timeout(200)
        s.page.click("#vComp button")
        # 18.10: своя длительность у попутчика — за ссылкой прямо под выбором длительности, по умолчанию у всех как у автора
        mate = s.js("() => document.querySelector('#vComp button[aria-pressed=true]').dataset.p")
        check("попутчик выбран — под длительностью ссылка «Кто-то ушёл раньше или остался дольше?», строки спрятаны",
              s.js("() => !document.getElementById('vDursToggle').hidden && document.getElementById('vDurs').hidden && /ушёл раньше/.test(document.getElementById('vDursToggle').innerText)"))
        s.page.click("#vDursToggle")
        check("…вместо больших кнопок — у каждого своё: ты первым, у попутчика как у тебя (🔥 долгая)",
              s.js(f"""() => document.getElementById('vDurChips').hidden && document.querySelectorAll('#vDurs .durs-row').length === 2
                && /ты/.test(document.querySelector('#vDurs .durs-row').innerText)
                && document.querySelector('#vDurs [data-dp="{mate}"][data-m="180"]').getAttribute('aria-pressed') === 'true'"""))
        s.page.click(f'#vDurs [data-dp="{mate}"][data-m="120"]')
        s.page.fill("#vPrice", "700"); s.page.fill("#vPrBeer", "280")
        s.page.set_input_files("#vPhotos", files=[{"name": "par.png", "mimeType": "image/png", "buffer": TILE}])
        s.page.wait_for_timeout(500)
        check("итог — и в кнопке: «Отправить · +N»", s.js("() => /Отправить · \\+[1-9]/.test(document.getElementById('vSubmit').innerText)"))
        check("в талоне есть очки", s.js("() => /Итого\\s*\\+[1-9]/.test(document.getElementById('calc').innerText)"),
              s.js("() => document.getElementById('calc').innerText"))
        s.page.click("#vSubmit")
        s.page.wait_for_selector("#visitModal", state="hidden", timeout=10000)
        new = set(sql("select coalesce(string_agg(id::text, ','), '') from visits").split(",")) - {""} - before
        vid = max(map(int, new)) if new else None
        row = sql(f"select source || ' ' || status || ' ' || (select count(*) from visit_players where visit_id = {vid}) from visits where id = {vid}") if vid else ""
        check("поход сохранился: с сайта, на модерации, с попутчиком", row == "site pending 2", row)
        durs_row = lambda: sql(f"select string_agg(case when vp.player_id = v.created_by then 'автор' else 'попутчик' end || '=' || coalesce(vp.duration_min::text, '—'), ',' order by vp.player_id = v.created_by) from visit_players vp join visits v on v.id = vp.visit_id where vp.visit_id = {vid}") if vid else ""
        check("у попутчика своя длительность — экспресс, у автора — как у похода", durs_row() == "попутчик=120,автор=—", durs_row())
        # фото из формы: браузер уменьшил, положил в бакет по одноразовой ссылке, функция проверила оба файла и показала
        ph = lambda: sql(f"select coalesce(string_agg(key || ' ' || ready || ' ' || source || ' ' || w || 'x' || h, ','), '') from visit_photos where visit_id = {vid}") if vid else ""
        for _ in range(40):   # не time.sleep: он стопорит Playwright, и запись в бакет (через _offline) не идёт
            if " true " in ph(): break
            s.page.wait_for_timeout(500)
        row = ph()
        check("фото из формы похода легло в бакет и показано", row.endswith(" true site 1x1"), row)
        pk = row.split(" ")[0]
        check("в бакете — большое и превью, кэш на год", all(TELEGRAM.s3.get(f"ebl-photos/{pk}{x}.jpg", {}).get("cache", "").endswith("immutable") for x in ("", "_s")),
              {k: v.get("cache") for k, v in TELEGRAM.s3.items() if pk in k})
        check("загрузка — без ошибок в консоли", not s.errors, s.errors[:3])
        # цена и цена пива, вписанные прямо в форму похода, сохраняются тем же путём, что и через карточку бани
        check("цена из формы похода сохранилась", sql(f"select count(*) from bath_prices where bath_id = {bath}") == "1")
        check("цена пива из формы похода сохранилась", sql(f"select count(*) from bath_beer_prices where bath_id = {bath}") == "1")
        sql(f"delete from bath_prices where bath_id = {bath}"); sql(f"delete from bath_beer_prices where bath_id = {bath}")
        # точка примерная — форма похода просит ссылку и ставит точку сразу, не дожидаясь отправки похода
        orig = sql(f"select lat || ',' || lng || ',' || precision from baths where id = {bath}")
        sql(f"update baths set precision = 'city' where id = {bath}")
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        s.page.click("#dVisit")
        check("баня с примерной точкой — форма похода просит ссылку", s.js("() => !!document.querySelector('#vBathPicked .geo-ask #vGeo')"))
        s.page.fill("#vGeo", "55.7558, 37.6173"); s.page.press("#vGeo", "Enter")
        s.page.wait_for_function("() => /поставлена|Не нашёл|Войди|уже стоит/.test(document.querySelector('.geo-ask')?.innerText || '')", timeout=15000)
        check("Enter в поле точки не отправляет поход", s.js("() => !document.getElementById('visitModal').hidden"))
        point = sql(f"select precision || ' ' || round(lat::numeric, 4) || ' ' || round(lng::numeric, 4) from baths where id = {bath}")
        check("точка из формы похода сохранилась сразу", point == "exact 55.7558 37.6173", point)
        check("форма сказала, что точка стоит", s.js("() => document.querySelector('.geo-ask').innerText.includes('Точка поставлена')"))
        s.page.click("#visitModal .x")
        # точная точка: участник её не меняет, а предлагает Комиссии (Рублевские стояли в Подольске, 14.10); переименовать не может
        sql(f"update baths set lat = 55.7558, lng = 37.6173, precision = 'exact' where id = {bath}")
        sql(f"delete from bath_point_requests where bath_id = {bath}")
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        check("участнику переименовать баню и сменить её тип нельзя, фильтра по точкам нет — это Комиссии",
              s.js("() => !document.getElementById('dRename') && !document.getElementById('dTypeBtn') && !document.getElementById('dCloseBtn') && document.getElementById('fPrec').hidden"))
        s.page.click("#geoFixBtn"); s.page.fill("#geoFixInput", "55.783951, 37.354822"); s.page.click('#geoFixForm button[type="submit"]')
        s.page.wait_for_function("() => /Передал Комиссии|Не нашёл|Войди/.test(document.querySelector('#drawer .geo-move')?.innerText || '')", timeout=15000)
        req_row = sql(f"select status || ' ' || source || ' ' || round(lat::numeric, 4) from bath_point_requests where bath_id = {bath}")
        check("точная точка — предложение Комиссии: запрос ждёт, точка прежняя",
              req_row == "pending site 55.7840" and sql(f"select round(lat::numeric, 4) from baths where id = {bath}") == "55.7558", req_row)
        check("в карточке — «Передал Комиссии … 17 км от нынешней»", s.js("() => /Передал Комиссии.*17 км от нынешней/.test(document.querySelector('#drawer .geo-move').innerText)"),
              s.js("() => document.querySelector('#drawer .geo-move').innerText"))
        sql(f"delete from bath_point_requests where bath_id = {bath}")
        lat, lng, prec = orig.split(",")
        sql(f"update baths set lat = {lat}, lng = {lng}, precision = '{prec}' where id = {bath}")
        # фото похода: лента в карточке бани и просмотр во весь экран (docs/photos.md); файлы — в заглушке хранилища
        sql("delete from visit_photos where key like 'sitetest%'")
        pkeys = [f"sitetest{vid}a", f"sitetest{vid}b"]
        for k in pkeys:
            sql(f"insert into visit_photos (visit_id, added_by, source, key, w, h, ready) values ({vid}, '{player_id('Шурик')}', 'site', '{k}', 800, 600, true)")
            for suf in ("", "_s"):
                TELEGRAM.s3[f"ebl-photos/{k}{suf}.jpg"] = {"body": stub.jpeg(k), "type": "image/jpeg", "cache": None}
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]')
        s.page.wait_for_selector("#dPhotos:not([hidden]) .ph", timeout=8000)
        check("в карточке бани — лента фото похода с датой на первом", s.js("""() => {
          const ph = [...document.querySelectorAll('#dPhotos .ph')];
          return ph.length === 3 && ph[0].querySelector('span')?.innerText === 'сегодня' && !ph[1].querySelector('span') && !ph[2].querySelector('span');
        }"""))   # три фото одного похода: загруженное через форму и два подложенных
        s.page.click("#dPhotos .ph >> nth=1")
        check("фото открывается во весь экран: большое, «2 / 3»", s.js(f"""() => !document.getElementById('photoModal').hidden
          && document.getElementById('pvImg').src.endsWith('{pkeys[0]}.jpg') && document.getElementById('pvCap').innerText.startsWith('2 / 3')"""))
        s.page.keyboard.press("ArrowRight")
        check("стрелка — следующее фото", s.js(f"() => document.getElementById('pvImg').src.endsWith('{pkeys[1]}.jpg')"))
        s.page.keyboard.press("Escape")
        check("Esc закрывает просмотр, карточка бани остаётся", s.js("() => document.getElementById('photoModal').hidden && !document.getElementById('drawer').hidden"))
        s.page.click("#drawer .x")
        g = Site(browser, url, name="guest-photos")
        g.view("map"); g.page.fill("#q", "Василевские"); g.page.wait_for_timeout(300)
        g.page.click(f'#list .item[data-id="{bath}"]'); g.page.wait_for_timeout(1500)
        check("гостю фото не видны: ленты нет", g.js("() => document.getElementById('dPhotos').hidden && !document.querySelector('#dPhotos .ph')"))
        g.close()
        s.view("feed")
        check("в ленте у своего похода — «📷 Фото»", s.js(f"() => !!document.querySelector('#feed [data-addph=\"{vid}\"]')"))
        s.view("map")
        # отзывы: второй не затирает первый, свой можно удалить
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        check("в карточке сначала то, что знаем о бане: формы цены и отзыва — по кнопке, «Я тут парился» внизу на виду",
              s.js("() => document.getElementById('prForm').hidden && document.getElementById('rvForm').hidden && !!document.querySelector('#drawer .d-foot #dVisit')"))
        s.page.click("#rvOpen")
        for t in ("Первый отзыв — проверка сайта", "Второй отзыв — проверка сайта"):
            s.page.fill("#rvText", t); s.page.click('#rvForm button[type="submit"]'); s.page.wait_for_timeout(900)
        my_reviews = f"select count(*) from reviews where bath_id = {bath} and player_id = '{player_id('Шурик')}' and text like '%— проверка сайта'"
        check("второй отзыв на ту же баню не затирает первый", sql(my_reviews) == "2", sql(my_reviews))
        s.page.click("#drawer [data-rvdel]"); s.page.wait_for_timeout(900)
        check("свой отзыв можно удалить", sql(my_reviews) == "1", sql(my_reviews))
        # цена: новая запись, повтор той же цены не дублирует, другая цена — новая строка (история, не перезапись)
        price_rows = f"select count(*) from bath_prices where bath_id = {bath}"
        s.page.click("#prOpen")   # дальше форма остаётся открытой, пока карточка та же
        s.page.fill("#prPrice", "500"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("цена сохранилась", sql(price_rows) == "1", sql(price_rows))
        s.page.fill("#prPrice", "500"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("та же цена ещё раз — не дублируем", sql(price_rows) == "1", sql(price_rows))
        s.page.fill("#prPrice", "600"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("цена изменилась — новая запись, старая осталась", sql(price_rows) == "2", sql(price_rows))
        check("карточка показывает свежую цену", s.js("() => document.querySelector('#drawer').innerText.includes('600')"))
        # цена по выходным до 16:00 — отдельная история от обычной, показывается с пометкой
        s.page.fill("#prPrice", "600"); s.page.click("#prMore"); s.page.click('#prWeekend button[data-w="1"]'); s.page.fill("#prBefore", "16:00")
        s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("цена с будни/выходной и временем — своя запись, не путается с обычной", sql(price_rows) == "3", sql(price_rows))
        check("карточка показывает пометку вых/до 16:00", s.js("() => document.querySelector('#drawer').innerText.includes('до 16:00')"))
        # цена пива — отдельная история, не путается с ценой входа
        beer_rows = f"select count(*) from bath_beer_prices where bath_id = {bath}"
        s.page.fill("#prPrice", "600"); s.page.fill("#prBeer", "250"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("цена пива сохранилась", sql(beer_rows) == "1", sql(beer_rows))
        check("карточка показывает цену пива", s.js("() => document.querySelector('#drawer').innerText.includes('250')"))
        s.page.fill("#prPrice", "600"); s.page.fill("#prBeer", "250"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("та же цена пива ещё раз — не дублируем", sql(beer_rows) == "1", sql(beer_rows))
        s.page.fill("#prPrice", "600"); s.page.fill("#prBeer", "300"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("цена пива изменилась — новая запись, старая осталась", sql(beer_rows) == "2", sql(beer_rows))
        s.clean("участник после отправки похода")
        s.close()

        print("Комиссия")
        s = Site(browser, url, sess=vitek, name="commission")
        s.view("feed")
        # ждём кнопку, а не фиксированные доли секунды: лента дорисовывается после загрузки данных
        try: s.page.wait_for_selector(f'[data-ok="{vid}"]', timeout=8000)
        except Exception: pass
        check("Комиссия сразу видит кнопки решения — без переключателя «Режим Комиссии»", s.js(f"() => !!document.querySelector('[data-ok=\"{vid}\"]')"))
        s.page.click(f'[data-ok="{vid}"]')
        s.page.wait_for_timeout(1500)
        check("«Засчитать» с сайта: поход засчитан", sql(f"select status from visits where id = {vid}") == "ok")
        s.page.wait_for_timeout(4000)   # пересчёт пачкой и обновление без перезагрузки
        check("очки за поход посчитаны", int(sql(f"select count(*) from visit_points where visit_id = {vid}") or 0) >= 1)
        check("повторное решение по уже решённой заявке не проходит",
              s.js(f"async () => {{ try {{ await window.EBLData.moderate({vid}, 'rejected'); return false; }} catch (e) {{ return /уже решили/.test(e.message); }} }}"))
        # правка засчитанного похода: «🔥 Долгая» вместо минут
        s.page.click('#feedFilter button[data-f="all"]'); s.page.wait_for_timeout(300)
        check("в ленте видно, у кого была другая длительность", s.js(f"() => (document.querySelector('[data-edit=\"{vid}\"]')?.closest('.post')?.innerText || '').includes('— ⚡ экспресс')"))
        s.page.click(f'[data-edit="{vid}"]'); s.page.wait_for_timeout(300)
        check("в правке у Комиссии строки длительности открыты сразу: у попутчика — экспресс",
              s.js("() => document.querySelector('#ePeople [data-ed][data-m=\"120\"]')?.getAttribute('aria-pressed') === 'true'"))
        s.page.click('#eDur button[data-long="1"]')
        s.page.click('#editForm button[type="submit"]'); s.page.wait_for_timeout(1500)
        check("Комиссия правит засчитанный поход: «🔥 Долгая» — в базе больше 150 минут", int(sql(f"select duration_min from visits where id = {vid}")) > 150)
        check("…а у попутчика остался экспресс", durs_row() == "попутчик=120,автор=—", durs_row())
        s.page.click(f'[data-edit="{vid}"]'); s.page.wait_for_timeout(300)
        s.page.click("#eDursSame"); s.page.click('#editForm button[type="submit"]'); s.page.wait_for_timeout(1500)
        check("«Всем одинаково» в правке — своя длительность снята", durs_row() == "попутчик=—,автор=—", durs_row())
        # справочник бань — вкладка только у Комиссии (просьба Витька 02.10): тип, где, сколько походов, кто где был
        s.view("dir")
        s.page.wait_for_selector("#dirTable tbody tr", timeout=8000)
        check("Комиссии видна вкладка «Бани»: справочник всех бань", s.js("() => document.querySelectorAll('#dirTable tbody tr').length") >= 100)
        s.page.click('#dirType [data-t="spa"]'); s.page.wait_for_timeout(300)
        check("фильтр «Хуитнесы» — только хуитнесы", s.js("() => { const r = [...document.querySelectorAll('#dirTable tbody tr')]; return r.length > 0 && r.every((x) => x.dataset.t === 'spa'); }"))
        s.page.click('#dirType [data-t=""]'); s.page.wait_for_timeout(200)
        s.page.click('#dirTable [data-sort="name"]'); s.page.wait_for_timeout(300)
        names = s.js("() => [...document.querySelectorAll('#dirTable tbody .dir-bath')].slice(0, 20).map((x) => x.textContent.toLowerCase().replace(/ё/g, 'е'))")
        check("сортировка по заголовку «Баня» — по алфавиту", names == sorted(names, key=lambda x: x), names[:5])
        s.page.click('#dirTable [data-sort="n26"]'); s.page.wait_for_timeout(300)
        n26 = s.js("() => [...document.querySelectorAll('#dirTable tbody tr')].slice(0, 30).map((r) => parseInt(r.querySelector('td[data-label=\"в 2026\"]').textContent) || 0)")
        check("сортировка по «2026» — сначала больше походов", n26 == sorted(n26, reverse=True) and n26[0] > 0, n26[:5])
        s.page.click('#dirTable [data-sort="country"]'); s.page.wait_for_timeout(300)
        cs = s.js("() => [...document.querySelectorAll('#dirTable tbody .dir-country')].slice(0, 40).map((x) => x.textContent.trim().toLowerCase().replace(/ё/g, 'е'))")
        known = [c for c in cs if c != "—"]
        check("страна — отдельным столбцом, сортировка по ней по алфавиту (пустые — в конце)", known == sorted(known) and cs[:len(known)] == known, cs[:6])
        check("одна строка на баню: высота строки как у одной строки текста",
              s.js("() => Math.max(...[...document.querySelectorAll('#dirTable tbody tr')].slice(0, 20).map((r) => r.getBoundingClientRect().height))") < 48)
        s.page.click('#dirSeason [data-s="no"]'); s.page.wait_for_timeout(300)
        check("«Не были в 2026» — только бани без походов в этом сезоне",
              s.js("() => [...document.querySelectorAll('#dirTable tbody td[data-label=\"в 2026\"]')].every((x) => x.textContent.trim() === '—')"))
        s.page.click('#dirSeason [data-s=""]'); s.page.wait_for_timeout(200)
        s.page.fill("#dirQ", "Василевские"); s.page.wait_for_timeout(300)
        row = f'#dirTable tr[data-id="{bath}"]'
        check("поиск по названию — строка бани с теми, кто там был", s.js(f"() => !!document.querySelector('{row}') && document.querySelector('{row} .dir-who').innerText.length > 0"))
        old_type = sql(f"select coalesce(type, '') from baths where id = {bath}")
        new_type = "private" if old_type != "private" else "public"
        s.page.select_option(f"{row} select[data-dirtype]", new_type); s.page.wait_for_timeout(1500)
        check("тип бани меняется прямо в справочнике", sql(f"select type from baths where id = {bath}") == new_type)
        sql(f"update baths set type = {repr(old_type) if old_type else 'null'} where id = {bath}")
        # название бани Комиссия правит прямо в карточке (prompt отвечает «проверка сайта»)
        bath_name = sql(f"select name from baths where id = {bath}")
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        s.page.click("#dRename"); s.page.wait_for_timeout(900)
        check("Комиссия переименовывает баню в карточке", sql(f"select name from baths where id = {bath}") == "проверка сайта")
        sql(f"update baths set name = '{bath_name}' where id = {bath}")
        # тип бани — и из карточки (18.10), но только Комиссии и только после подтверждения
        btype = lambda: sql(f"select coalesce(type, '') from baths where id = {bath}")
        s.page.click("#dTypeBtn")
        # страница помнит тип из справочника выше (в базе его уже откатили) — берём тип, отличный от показанного в карточке
        shown = s.js("() => document.querySelector('#dTypeAsk [aria-pressed=\"true\"]')?.dataset.newtype || ''")
        card_type = next(t for t in ("public", "spa", "private") if t != shown)
        s.page.click(f'#dTypeAsk [data-newtype="{card_type}"]')
        check("смена типа в карточке: видно «было → станет» и что очки пересчитаются; без «Сменить» тип прежний",
              s.js("() => /→/.test(document.getElementById('dTypeNote').innerText) && /пересчита/.test(document.getElementById('dTypeNote').innerText)") and btype() == old_type)
        s.page.click("#dTypeCancel")
        check("«Отмена» — строка закрылась, тип прежний", s.js("() => document.getElementById('dTypeAsk').hidden") and btype() == old_type)
        s.page.click("#dTypeBtn"); s.page.click(f'#dTypeAsk [data-newtype="{card_type}"]'); s.page.click("#dTypeGo"); s.page.wait_for_timeout(1500)
        check("«Сменить» — тип бани поменялся", btype() == card_type)
        sql(f"update baths set type = {repr(old_type) if old_type else 'null'} where id = {bath}")
        # баня закрылась (19.10): Комиссия отмечает в карточке с подтверждением; походы остаются, в форме похода не предлагаем
        bclosed = lambda: sql(f"select coalesce(closed_on::text, '') from baths where id = {bath}")
        s.page.click("#dCloseBtn")
        check("«Закрылась?» — строка подтверждения с месяцем, без «Закрыта» ничего не меняется",
              s.js("() => !document.getElementById('dCloseAsk').hidden && /Походы и очки останутся/.test(document.getElementById('dCloseAsk').innerText) && !!document.getElementById('dCloseMonth')") and bclosed() == "")
        s.page.click("#dCloseGo"); s.page.wait_for_timeout(1500)
        month = sql("select to_char(now(), 'YYYY-MM')")
        check("«Закрыта» — в лиге дата закрытия, в карточке «закрыта с …», кнопка — «Работает снова?»",
              bclosed() == f"{month}-01" and s.js("() => /закрыта с/.test(document.querySelector('#drawer .d-meta').innerText) && /Работает снова/.test(document.getElementById('dCloseBtn').innerText)"), bclosed())
        s.page.click("#drawer .x"); s.page.click("#addVisitBtn"); s.page.wait_for_timeout(400)
        s.page.fill("#vBathQ", "Василевские"); s.page.wait_for_timeout(300)
        check("закрытую баню форма похода не предлагает", s.js(f"() => !!document.querySelector('#vSuggest button') && !document.querySelector('#vSuggest [data-id=\"{bath}\"]')"))
        s.page.click("#visitModal [data-close]"); s.page.wait_for_timeout(300)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        # метки собраны в группы и в странице только видимые — сначала к бане (открыл и закрыл карточку), потом смотрим метку
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(900); s.page.click("#drawer .x"); s.page.wait_for_timeout(500)
        check("на карте закрытая баня — бледная", s.js("() => !!document.querySelector('#map .pin.closed')"))
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        s.page.click("#dCloseBtn"); s.page.click("#dCloseGo"); s.page.wait_for_timeout(1500)
        check("«Работает снова» — дата закрытия снята", bclosed() == "")
        sql(f"update baths set closed_on = null where id = {bath}")
        # поход за другого (только на сайте): Комиссия сама выбирает «Кто» и в бане могла не быть
        s.page.click("#dVisit")   # из карточки этой бани: на странице она ещё под временным названием
        check("Комиссии «Кто» можно выбрать", s.js("() => !document.getElementById('vPlayer').disabled && !document.getElementById('vPlayerHint').hidden"))
        s.page.select_option("#vPlayer", "Леха")
        s.page.fill("#vDate", "2026-10-01T19:00"); s.page.wait_for_timeout(300)
        s.page.click("#vSubmit"); s.page.wait_for_selector("#visitModal", state="hidden", timeout=10000)
        fv = sql("select coalesce(max(id), 0) from visits where entered_by = (select id from players where nick = 'Витёк')")
        who = sql(f"select a.nick || '/' || (select string_agg(p.nick, ',' order by p.nick) from visit_players vp join players p on p.id = vp.player_id where vp.visit_id = v.id) "
                  f"from visits v join players a on a.id = v.created_by where v.id = {fv}")
        check("поход — Лехи, внёс Витёк, Витька в компании нет", who == "Леха/Леха", who)
        s.view("feed"); s.page.click('#feedFilter button[data-f="pending"]'); s.page.wait_for_timeout(500)
        check("в ленте у такого похода — «внёс Витёк»", s.js(f"() => (document.querySelector('[data-ok=\"{fv}\"]')?.closest('.post')?.innerText || '').includes('внёс Витёк')"))
        sql(f"delete from visits where id = {fv}")
        # 18.10: фильтр Комиссии — бани с примерной точкой и без точки, чтобы пройтись и поправить
        s.view("map"); s.page.fill("#q", ""); s.page.select_option("#fPrec", "rough"); s.page.wait_for_timeout(600)
        rough = s.js("""() => ({ season: document.querySelector('#fSeason [aria-pressed=true]').dataset.v, count: document.getElementById('count').innerText,
          items: document.querySelectorAll('#list .item').length,
          bad: [...document.querySelectorAll('#list .item .it-meta')].slice(0, 30).map((m) => m.innerText).filter((t) => !/точка (по (городу|региону|стране)|автоматом)/.test(t)).slice(0, 3) })""")
        check("Комиссии: «Точка примерная» — бани всех лет, у каждой видно, насколько точка примерная",
              rough["season"] == "all" and "точка примерная" in rough["count"] and rough["items"] > 0 and not rough["bad"], rough)
        s.page.select_option("#fPrec", "none"); s.page.wait_for_timeout(600)
        check("…«Без точки» — на карте ни одной метки, в счётчике так и сказано",
              s.js("() => /без точки/.test(document.getElementById('count').innerText) && !document.querySelector('#map .pin')"))
        # 19.10: «среднеточные» — точку нашёл геокодер по названию, никто не проверял
        auto_id = sql("select id from baths where precision = 'auto' and status = 'ok' order by id limit 1")
        if auto_id:
            s.page.select_option("#fPrec", "auto"); s.page.wait_for_timeout(600)
            check("Комиссии: «Среднеточная» — только бани с точкой от геокодера, с пометкой",
                  s.js("() => /среднеточные/.test(document.getElementById('count').innerText) && [...document.querySelectorAll('#list .item .it-meta')].slice(0, 20).every((m) => /точка автоматом/.test(m.innerText))"))
            s.page.select_option("#fPrec", ""); s.page.wait_for_timeout(300)
            s.js(f"() => document.querySelector('#list .item[data-id=\"{auto_id}\"]') || null")
            s.page.fill("#q", sql(f"select name from baths where id = {auto_id}")); s.page.wait_for_timeout(400)
            s.page.click(f'#list .item[data-id="{auto_id}"]'); s.page.wait_for_timeout(1200)
            check("карточка среднеточной бани: «точка найдена автоматически — может быть не та баня»",
                  s.js("() => /найдена автоматически/.test(document.querySelector('#drawer .geo-move')?.innerText || '')"))
            s.page.click("#drawer .x"); s.page.fill("#q", "")
        s.page.select_option("#fPrec", ""); s.page.click('#fSeason [data-v="2026"]'); s.page.wait_for_timeout(300)
        s.clean("Комиссия")
        s.close()
        # Радар (16.10): места из прогона агентов, решает Комиссия; участнику и гостю его нет
        sql("delete from radar_places where key like 'test:%'")
        hint = sql("select id from baths where name = 'Василевские' limit 1")
        sql(f"""insert into radar_places (key, name, region, city, address, lat, lng, kind, public_index, note, league_hint, website) values
              ('test:new', 'Тестовые общественные бани', 'Московская обл', 'Тестово', 'ул. Пара, 1', 55.9, 37.9, 'public', 93, 'Билет на сеанс, мужские и женские дни', null, 'https://example.org'),
              ('test:ours', 'Василевские бани', 'Москва', 'Москва', 'ул. Пара, 2', 55.75, 37.6, 'public', 90, 'Похоже на нашу', {hint}, null),
              ('test:rest', 'Сауна у Тестового', 'Москва', 'Москва', null, null, null, 'private', 5, 'Почасовая аренда', null, null)""")
        s = Site(browser, url, sess=vitek, name="commission-radar")
        s.view("dir"); s.page.click('#dirMode [data-mode="radar"]')
        s.page.wait_for_selector("#radarList .radar-card", timeout=8000)
        tabs = lambda: s.js("() => Object.fromEntries([...document.querySelectorAll('#radarTabs button')].map((b) => [b.dataset.tab, +b.querySelector('.n').innerText]))")
        check("Радар у Комиссии: вкладки по решению со счётчиками, открыты «Новые», прогресс разбора",
              tabs() == {"new": 1, "ours": 1, "review": 0, "search": 0, "rest": 1, "done": 0}
              and s.js("() => document.querySelector('#radarTabs [aria-pressed=\"true\"]').dataset.tab === 'new' && /Разобрано 0 из 2/.test(document.getElementById('radarProgress').innerText)"), tabs())
        check("карточка: вердикт словами и факты, ссылки на сайт, Яндекс Карты и 2ГИС, главная кнопка «Завести в лигу»",
              s.js("""() => { const c = document.querySelector('#radarList .radar-card'); return /точно общественная · 93/.test(c.innerText)
                && c.querySelectorAll('.radar-links a').length === 3 && !!c.querySelector('[data-radar="add"].solid'); }"""))
        check("на карте рядом со списком — точки этой вкладки", s.js("() => document.querySelectorAll('#radarmap path.rd').length === 1"))
        rid = sql("select id from radar_places where key = 'test:new'")
        s.page.click(f'#radarList .radar-card[data-id="{rid}"] [data-radar="hide"]')
        s.page.click(f'#radarList .radar-card[data-id="{rid}"] [data-radar="hide-go"][data-reason="rental"]'); s.page.wait_for_timeout(1200)
        check("«Скрыть» — причина одним нажатием, место в «Решено», внизу «Отменить»",
              sql(f"select status || ' ' || hide_reason from radar_places where id = {rid}") == "hidden rental"
              and s.js("() => /Отменить/.test(document.querySelector('.toast')?.innerText || '')") and tabs()["done"] == 1)
        s.page.click('#radarTabs [data-tab="done"]'); s.page.wait_for_timeout(300)
        check("«Решено»: у скрытого — причина и «Вернуть»",
              s.js("() => /Скрыта: аренда, сауна/.test(document.getElementById('radarList').innerText) && document.querySelectorAll('#radarList [data-radar=\"reopen\"]').length === 1"))
        s.page.click('#radarTabs [data-tab="ours"]'); s.page.wait_for_timeout(300)
        check("«Наши»: почему похоже на нашу и главная кнопка «Перенести точку „Василевские“ сюда»",
              s.js("() => /Похоже на нашу «Василевские»/.test(document.getElementById('radarList').innerText) && /Перенести точку «Василевские» сюда/.test(document.getElementById('radarList').innerText)"))
        ours = sql("select id from radar_places where key = 'test:ours'")
        s.page.click(f'#radarList .radar-card[data-id="{ours}"] [data-radar="fly"]'); s.page.wait_for_timeout(400)
        check("клик по названию в «Наших» — на карте наша точка сейчас и пунктир до найденного места",
              s.js("() => document.querySelectorAll('#radarmap path.rd-league').length === 1 && document.querySelectorAll('#radarmap path.rd-link').length === 1"))
        s.page.click(f'#radarList .radar-card[data-id="{ours}"] [data-radar="add"]')
        check("«Это другая — завести» — строка подтверждения с выбором типа, без нажатия «Завести» ничего не заводится",
              s.js("() => document.querySelectorAll('#radarList .radar-ask [data-type]').length === 3") and sql("select status from radar_places where key = 'test:ours'") == "new")
        s.page.keyboard.press("Escape")
        s.no_clip("Радар у Комиссии")
        s.clean("Радар")
        s.close()
        s = Site(browser, url, sess=vitek, mobile=True, name="commission-radar-phone")
        s.view("dir"); s.page.click('#dirMode [data-mode="radar"]')
        s.page.wait_for_selector("#radarList .radar-card", timeout=8000)
        s.no_clip("Радар на телефоне")
        s.close()
        sql("delete from radar_places where key like 'test:%'")
        # Сверка каталога (19.10): что агенты нашли по баням лиги; решает Комиссия — по одной или уверенные пачкой
        sql("delete from catalog_proposals where run = 'test'")
        cb_id, cb_lat, cb_lng, cb_prec = sql("select id || '|' || coalesce(lat::text, '') || '|' || coalesce(lng::text, '') || '|' || coalesce(precision, '') from baths where name = 'Василевские' limit 1").split("|")
        other = sql("select id from baths where status = 'ok' and name <> 'Василевские' order by id limit 1")
        sql(f"""insert into catalog_proposals (run, bath_id, found_name, address, lat, lng, point_src, match, match_why, bin, website, hours, gender_days, price, place_status, is_public, note) values
              ('test', {cb_id}, 'Тестовые бани сверки', 'ул. Пара, 2', 55.7, 37.55, '2gis', 95, 'адрес совпал в 2ГИС и на сайте', 'new', 'https://example.org', 'ежедневно 8–22', 'мужские пн, ср', '1500 ₽', 'open', true, 'Точка из 2ГИС'),
              ('test', {other}, 'Тестовая неизвестная баня', null, null, null, null, 30, 'не нашли', 'notfound', null, null, null, null, 'unknown', null, 'Спросить у участников')""")
        c_sure, c_doubt = (sql(f"select id from catalog_proposals where run = 'test' and bath_id = {b}") for b in (cb_id, other))
        s = Site(browser, url, sess=vitek, name="commission-catalog")
        s.view("dir"); s.page.click('#dirMode [data-mode="catalog"]')
        s.page.wait_for_selector("#catList .radar-card", timeout=8000)
        s.page.fill("#catQ", "Тестовые бани сверки"); s.page.wait_for_timeout(400)
        card = f'#catList .radar-card[data-id="{c_sure}"]'
        check("Сверка у Комиссии: «Уверенные» с пачкой, в карточке — как записано у нас (регион, кто был) и что нашли",
              s.js(f"""() => {{ const c = document.querySelector('{card}'); return !!c && /у нас/i.test(c.innerText) && /Василевские/.test(c.innerText)
                && /нашли/i.test(c.innerText) && /Тестовые бани сверки · ул. Пара, 2/.test(c.innerText) && /точка — 2ГИС/.test(c.innerText) && /1500 ₽/.test(c.innerText)
                && c.querySelectorAll('.radar-links a').length === 3 && /уверенность 95/.test(c.innerText)
                && document.querySelector('#catTabs [aria-pressed="true"]').dataset.tab === 'sure' && /Принять все 1/.test(document.getElementById('catBatch').innerText); }}"""))
        s.page.hover(f'{card} .cat-prop'); s.page.wait_for_timeout(1200)
        check("навёл на карточку — карта переехала к бане: найденная и наша точки в кадре, между ними пунктир",
              s.js("""() => { const m = document.getElementById('catmap').getBoundingClientRect();
                const inside = (el) => { const r = el?.getBoundingClientRect(); return !!r && r.left >= m.left && r.right <= m.right && r.top >= m.top && r.bottom <= m.bottom; };
                return inside(document.querySelector('#catmap path.rd-league')) && inside(document.querySelector('#catmap path.rd-new')) && !!document.querySelector('#catmap path.rd-link'); }"""))
        s.page.click('#catBatch [data-cat="batch"]')
        check("«Принять все» — сначала строка подтверждения, без неё ничего не меняется",
              s.js("() => /Принять 1 баню\\?/.test(document.getElementById('catBatch').innerText)") and sql(f"select status from catalog_proposals where id = {c_sure}") == "new")
        s.page.click('#catBatch [data-cat="batch-go"]'); s.page.wait_for_timeout(1500)
        check("…подтвердил — точка бани стала найденной точной, внизу «Отменить»",
              sql(f"select status from catalog_proposals where id = {c_sure}") == "accepted" and sql(f"select lat || ' ' || lng || ' ' || precision from baths where id = {cb_id}") == "55.7 37.55 exact"
              and s.js("() => /Принято 1 баня/.test(document.querySelector('.toast')?.innerText || '')"))
        s.page.click(".toast .toast-act"); s.page.wait_for_timeout(1500)
        check("…«Отменить» — точка прежняя, предложение снова ждёт решения",
              sql(f"select status from catalog_proposals where id = {c_sure}") == "new"
              and sql(f"select coalesce(lat::text, '') || '|' || coalesce(lng::text, '') || '|' || coalesce(precision, '') from baths where id = {cb_id}") == f"{cb_lat}|{cb_lng}|{cb_prec}")
        s.page.fill("#catQ", "Тестовая неизвестная"); s.page.click('#catTabs [data-tab="doubt"]'); s.page.wait_for_timeout(400)
        card = f'#catList .radar-card[data-id="{c_doubt}"]'
        s.page.click(f'{card} [data-cat="reject"]')
        s.page.click(f'{card} [data-cat="reject-go"][data-reason="closed"]'); s.page.wait_for_timeout(1200)
        check("«Не нашли»: «Отклонить» — причина одним нажатием, предложение уходит в «Решено»",
              sql(f"select status || ' ' || reject_reason from catalog_proposals where id = {c_doubt}") == "rejected closed")
        s.page.fill("#catQ", "")
        s.no_clip("Сверка у Комиссии")
        s.clean("Сверка")
        s.close()
        s = Site(browser, url, sess=vitek, mobile=True, name="commission-catalog-phone")
        s.view("dir"); s.page.click('#dirMode [data-mode="catalog"]')
        s.page.wait_for_selector("#catList .radar-card", timeout=8000)
        s.no_clip("Сверка на телефоне")
        s.close()
        sql("delete from catalog_proposals where run = 'test'")
        # второй поход в ту же баню в те же сутки: Комиссия должна видеть до решения, что очков не будет (п. 5)
        dup = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, source) select {bath}, now(), 120, id, 'site' from players where nick='Шурик' returning id").splitlines()[0]
        sql(f"insert into visit_players (visit_id, player_id) select {dup}, id from players where nick='Шурик'")
        s = Site(browser, url, sess=vitek, name="commission-repeat")
        s.view("feed")
        try: s.page.wait_for_selector(f'[data-ok="{dup}"]', timeout=8000)
        except Exception: pass
        check("Комиссия видит пометку «похоже на повтор бани в те же сутки — проверь дату»",
              s.js(f"() => (document.querySelector('[data-ok=\"{dup}\"]')?.closest('.post')?.innerText || '').includes('повтор бани')"))
        check("…а у уже решённых походов пометки о повторе нет — Комиссия решила",
              s.js("() => ![...document.querySelectorAll('#feedList .post, .feed .post')].some((p) => !p.querySelector('[data-ok]') && /повтор бани/.test(p.innerText))"))
        s.clean("Комиссия: повтор")
        s.close()

        print("Даты в карточках")
        # ждём строку таблицы, а не надеемся, что она уже нарисована
        open_shurik = "async () => { for (let i = 0; i < 50; i++) { const tr = [...document.querySelectorAll('#standings tbody tr')].find((x) => x.innerText.includes('Шурик')); if (tr) { tr.click(); return true; } await new Promise((r) => setTimeout(r, 100)); } return false; }"
        first_row = "() => document.querySelector('#playerBody .blist button')?.innerText || ''"
        s = Site(browser, url, sess=shurik, name="member-dates")
        s.view("table"); s.js(open_shurik)
        s.page.wait_for_selector("#playerBody .blist button", timeout=8000)
        row = s.js(first_row)
        check("карточка участника: сверху свежая баня с портала — с датой и «на проверке»",
              "Василевские" in row and "сегодня" in row and "на проверке" in row, row)
        check("ниже — бани из таблицы Комиссии, подписано, что там без дат",
              s.js("() => /таблице Комиссии/.test(document.querySelector('#playerBody .bl-sep')?.textContent || '')"),
              s.js("() => document.querySelector('#playerBody .blist')?.textContent.slice(0, 300)"))
        s.js("() => (document.getElementById('playerModal').hidden = true)")
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        check("карточка бани: «Последний раз — сегодня» с компанией",
              s.js("() => /Последний раз — сегодня: .*Шурик/.test(document.querySelector('#drawer .last-visit')?.innerText || '')"))
        s.clean("даты в карточках")
        s.close()
        s = Site(browser, url, name="guest-dates")
        s.view("table"); s.js(open_shurik)
        check("гостю даты не показываем и говорим, что их видят участники",
              "сегодня" not in s.js(first_row) and s.js("() => /видны участникам/.test(document.getElementById('playerBody').innerText)"))
        s.close()

        print("Куда сходить за очками: «Я», «Не были в 2026», «Рядом»")
        s = Site(browser, url, sess=shurik, name="where-to-go")
        s.ctx.grant_permissions(["geolocation"]); s.ctx.set_geolocation({"latitude": 55.7558, "longitude": 37.6176})
        s.page.click("#fMe"); s.page.click('#fSeason [data-v="never"]'); s.page.wait_for_timeout(500)
        check("«Я» выбирает себя одним нажатием", s.js("() => document.getElementById('fPlayer').value") == "Шурик")
        ids = s.js("() => [...document.querySelectorAll('#list .item')].slice(0, 25).map((x) => +x.dataset.id)")
        pots = s.js("() => [...document.querySelectorAll('#list .item .it-pot b')].slice(0, 25).map((x) => +x.textContent)")
        check("«Не были в 2026» у участника — очки за первый поход, выгодные сверху", len(pots) == len(ids) > 0 and min(pots) >= 2 and pots == sorted(pots, reverse=True), pots)
        been = sql(f"select count(*) from bath_counts where nick = 'Шурик' and year = 2026 and bath_id in ({','.join(map(str, ids))})")
        check("в этом списке нет бань, где он уже был в 2026", been == "0", been)
        s.page.click("#fNear"); s.page.wait_for_timeout(1200)
        meters = s.js("""() => [...document.querySelectorAll('#list .item .it-meta')].slice(0, 12).map((m) => {
          const x = m.textContent.match(/~?([\\d\\s,]+)\\s(км|м)(?![а-я])/); if (!x) return null;
          const v = parseFloat(x[1].replace(/\\s/g, '').replace(',', '.')); return x[2] === 'км' ? v * 1000 : v; })""")
        check("«📍 Рядом» — у бань расстояние, ближние сверху", s.js("() => document.getElementById('fNear').getAttribute('aria-pressed')") == "true"
              and meters and None not in meters and meters == sorted(meters), meters)
        s.clean("куда сходить за очками")
        s.close()

        print("Телефон")
        s = Site(browser, url, mobile=True, name="mobile-guest")
        s.no_clip("гость: шапка на телефоне", ".top")
        s.page.click("#meBtn")
        s.page.wait_for_selector("#botLogin", timeout=8000)
        check("вход на телефоне — кнопка сразу в бота, без QR",
              s.js("() => document.getElementById('botLogin').href.startsWith('https://t.me/eblsu_bot?start=login_') && !document.getElementById('loginQr')"))
        s.no_clip("гость: окно входа на телефоне", "#loginModal .sheet")
        s.page.click("#loginModal [data-close]")
        all_views(s, "гость на телефоне", mobile=True)
        # 18.10, отзыв из чата: на телефоне карте мало места — панель со списком стала шторкой снизу, как в Яндекс Картах
        s.view("map"); s.page.wait_for_timeout(300)
        state = lambda: s.js("() => document.querySelector('#view-map .panel').dataset.state")
        top = lambda: s.js("() => document.querySelector('#view-map .panel').getBoundingClientRect().top")
        check("телефон: карта на весь экран, шторка при входе — на половине, гонки недели на карте нет",
              state() == "half" and s.js("""() => { const m = document.getElementById('map').getBoundingClientRect(), v = document.getElementById('view-map').getBoundingClientRect();
                return m.height >= v.height - 1 && getComputedStyle(document.getElementById('race')).display === 'none'; }"""))
        swipe(s, 180, top() + 40, top() + 300)
        check("взмах вниз — от шторки остаётся только поиск, карта почти целиком",
              state() == "peek" and s.js("""() => { const p = document.querySelector('#view-map .panel').getBoundingClientRect(), q = document.getElementById('q').getBoundingClientRect(),
                v = document.getElementById('view-map').getBoundingClientRect(); return q.bottom <= v.bottom && p.top > v.top + v.height * 0.75; }"""))
        swipe(s, 180, top() + 30, top() - 300)
        swipe(s, 180, top() + 40, 60)
        check("взмахи вверх — половина, потом весь список; он листается внутри шторки",
              state() == "full" and s.js("() => { const p = document.querySelector('#view-map .panel'); p.scrollTop = 200; const ok = p.scrollTop > 0; p.scrollTop = 0; return ok; }"))
        swipe(s, 180, top() + 40, top() + 330, steps=24, ms=1200)
        check("медленно вниз от верха списка — шторка встаёт на ближайшую остановку (половина)", state() == "half")
        s.page.click("#sheetGrab"); s.page.wait_for_timeout(450)
        check("полоска шторки: из половины — свернуть", state() == "peek")
        s.page.click("#sheetGrab"); s.page.wait_for_timeout(450)
        s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        check("поиск разворачивает шторку во весь список", state() == "full")
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(1500)
        check("открытая баня на телефоне — точка видна над карточкой, а не под ней",
              s.js("""() => { const p = document.querySelector('#map .pin-drop')?.getBoundingClientRect(), d = document.getElementById('drawer').getBoundingClientRect();
                return !!p && p.bottom <= d.top && p.top >= document.getElementById('map').getBoundingClientRect().top; }"""))
        # 18.10: карточка бани на телефоне — как шторка: потянул вверх — на весь экран, смахнул вниз — назад и закрыть
        dtop = lambda: s.js("() => document.getElementById('drawer').getBoundingClientRect().top")
        swipe(s, 180, dtop() + 10, dtop() - 200)
        check("карточка бани: потянул за верх вверх — на весь экран", s.js("() => document.getElementById('drawer').classList.contains('full')"))
        swipe(s, 180, dtop() + 10, dtop() + 150)
        check("…смахнул вниз — обратно на привычную высоту, не закрылась", s.js("() => !document.getElementById('drawer').hidden && !document.getElementById('drawer').classList.contains('full')"))
        swipe(s, 180, dtop() + 10, dtop() + 300)
        check("…ещё вниз — закрылась", s.js("() => document.getElementById('drawer').hidden"))
        s.page.fill("#q", "")
        s.no_clip("телефон: шторка со списком", "#view-map")
        # «Хозяева»: пока карта летит к баням хозяина из списка, меню не перекрыто и нажимается
        s.view("owners")
        s.page.click("#oList li[data-owner]")
        s.page.wait_for_timeout(200)
        s.nav_free("«Хозяева» на телефоне во время приближения")
        s.page.click('.nav [data-view="table"]', timeout=3000)
        check("…и меню переключает вкладку, не дожидаясь конца анимации", s.js("() => !document.getElementById('view-table').hidden"))
        s.close()
        s = Site(browser, url, sess=vitek, mobile=True, name="mobile-commission")
        s.view("dir")
        s.page.wait_for_selector("#dirTable tbody tr", timeout=8000)
        s.no_clip("Комиссия на телефоне: справочник бань", "#view-dir")
        s.nav_free("Комиссия на телефоне: справочник бань")
        s.no_clip("Комиссия на телефоне: шапка и меню из шести вкладок", ".top")
        s.clean("Комиссия на телефоне")
        s.close()
        s = Site(browser, url, sess=shurik, mobile=True, name="mobile-member")
        check("участник на телефоне: аватарка видна (не белая точка)",
              s.js("() => { const a = document.querySelector('#meBtn .ava'); return !!a && a.getBoundingClientRect().width >= 24; }"))
        all_views(s, "участник на телефоне", mobile=True)
        # 18.10: профиль — быстрые действия вместо пустого окна
        s.page.click("#meBtn"); s.page.wait_for_timeout(300)
        check("профиль: мой сезон, мои бани на карте, мои походы в ленте", s.js("() => ['myProfile', 'myMap', 'myFeed', 'logoutBtn'].every((id) => !!document.getElementById(id))"))
        s.no_clip("профиль на телефоне", "#loginModal .sheet")
        s.page.click("#myMap"); s.page.wait_for_timeout(500)
        check("…«Мои бани на карте» — карта с моими банями", s.js("() => !document.getElementById('view-map').hidden && document.getElementById('fPlayer').value === 'Шурик' && document.getElementById('loginModal').hidden"))
        s.page.select_option("#fPlayer", ""); s.page.wait_for_timeout(300)
        # таблица шире экрана — тень у правого края, пока можно листать вбок
        s.view("table"); s.page.wait_for_timeout(500)
        hint = lambda: s.js("() => document.getElementById('standings').closest('.tablecard').classList.contains('more-right')")
        had = hint()
        s.js("() => { const w = document.getElementById('standings').closest('.tablewrap'); w.scrollLeft = w.scrollWidth; }"); s.page.wait_for_timeout(300)
        check("таблица на телефоне: тень у правого края, пока можно листать вбок, и пропадает в конце", had and not hint())
        s.view("map"); s.page.wait_for_timeout(300)
        s.page.click("#fMe"); s.page.click('#fSeason [data-v="never"]'); s.page.wait_for_timeout(500)
        s.no_clip("телефон: «Я» + «Не были в 2026» с очками", "#view-map")
        s.page.click("#fMe"); s.page.click('#fSeason [data-v="2026"]'); s.page.wait_for_timeout(300)
        s.view("table"); s.js(open_shurik)
        s.no_clip("карточка участника с датами на телефоне", "#playerModal")
        s.js("() => (document.getElementById('playerModal').hidden = true)")
        s.page.click("#addVisitBtn")
        s.page.wait_for_timeout(350)
        check("телефон: по нажатию сначала виден ковш, форма ещё не закрыла кнопку",
              s.js("() => document.getElementById('visitModal').hidden && getComputedStyle(document.querySelector('#addVisitBtn .kovsh')).opacity > 0.5"))
        s.page.wait_for_selector("#visitModal:not([hidden])", timeout=3000)
        check("телефон: после анимации открылась форма", True)
        s.no_clip("форма «Добавить баню» на телефоне", "#visitModal")
        check("телефон: «Отправить» видна сразу, без прокрутки формы (прилипает к низу)",
              s.js("() => { const r = document.getElementById('vSubmit').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }"))
        s.page.click("#vComp button"); s.page.click("#vDursToggle"); s.page.wait_for_timeout(200)
        check("телефон: строки «у каждого своё» — кнопки под палец (не ниже 36 px), строка — в одну линию",
              s.js("""() => { const b = [...document.querySelectorAll('#vDurs .durs-seg button')], r = document.querySelector('#vDurs .durs-row');
                return b.length === 4 && b.every((x) => x.getBoundingClientRect().height >= 36) && r.getBoundingClientRect().height < 60; }"""))
        s.no_clip("телефон: своя длительность у попутчика", "#visitModal")
        s.close()

        # 18.10: решения Комиссии с прошлого захода — один раз при входе на сайт
        dv = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, status, source, moderated_by, moderated_at) values ({bath}, now() - interval '5 hours', 120, '{player_id('Шурик')}', 'ok', 'site', '{player_id('Витёк')}', now()) returning id").splitlines()[0]
        s = Site(browser, url, sess=shurik, name="decisions",
                 init="if (!localStorage.getItem('ebl.seenDecisions.Шурик')) localStorage.setItem('ebl.seenDecisions.Шурик', String(Date.now() - 86400000))")
        s.page.wait_for_timeout(1500)
        # одно решение — «Комиссия засчитала „…“», несколько (на стенде остаются засчитанные выше) — «Комиссия решила N твоих походов»
        check("при заходе — о решениях Комиссии с прошлого раза, с кнопкой «В ленту»",
              s.js("() => /Комиссия (засчитала|решила)/.test(document.querySelector('.toast')?.innerText || '') && !!document.querySelector('.toast .toast-act')"),
              s.js("() => document.querySelector('.toast')?.innerText"))
        s.page.click(".toast .toast-act"); s.page.wait_for_timeout(400)
        check("…«В ленту» — открыта лента", s.js("() => !document.getElementById('view-feed').hidden"))
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000); s.page.wait_for_timeout(1500)
        check("…и только один раз: после перезагрузки уже не показывается", s.js("() => !/Комиссия (засчитала|решила)/.test(document.querySelector('.toast')?.innerText || '')"))
        s.close(); sql(f"delete from visits where id = {dv}")

        print("Режим витрины (пустой config.js)")
        s = Site(browser, url, config=SHOWCASE_CONFIG, name="showcase")
        all_views(s, "витрина")
        s.close()
    finally:
        sql(f"delete from visits where source = 'site' and created_at > now() - interval '1 hour' and created_by = '{player_id('Шурик')}'")
        sql("delete from reviews where text like '%— проверка сайта'")
        sql(f"delete from bath_prices where bath_id = {bath}")
        sql(f"delete from bath_beer_prices where bath_id = {bath}")
        sql(f"update baths set name = 'Василевские' where id = {bath} and name = 'проверка сайта'")
    browser.close()
    sql(f"update settings set value = '{cutover}' where key = 'cutover_week'")
    print("Готово.")
