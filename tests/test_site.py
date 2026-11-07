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
from local import API, KEY, TELEGRAM, check, link, player_id, session, sql, webapp_init

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
  // веник «+ Баня» (02.11) — часть меню: стоит посередине, над пустым местом между «Таблицей» и «Лентой»
  const nav = document.querySelector('.nav'), cta = document.getElementById('addVisitBtn'), n = nav.getBoundingClientRect(), out = [];
  const view = [...document.querySelectorAll('.view')].find((v) => !v.hidden)?.getBoundingClientRect();
  if (view && view.bottom > n.top + 0.5) out.push(`вкладка уходит под меню на ${Math.round(view.bottom - n.top)} px`);
  for (const y of [n.top + 1, n.top + 6, (n.top + n.bottom) / 2, n.bottom - 2]) for (let x = 2; x < innerWidth; x += 16) {
    const el = document.elementFromPoint(x, y);
    if (el && !nav.contains(el) && !cta.contains(el)) out.push(`${x},${Math.round(y)}: ${el.tagName}.${[...el.classList].slice(0, 2).join('.')}`);
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
        b = self.page.locator(f'.nav [data-view="{v}"]')
        if b.is_visible(): b.click()
        else:   # на телефоне «Хозяева», «Правила» и «Бани» — в «Ещё» (02.11)
            self.page.click("#moreBtn"); self.page.click(f'#moreModal [data-go="{v}"]')
        # вкладка рисуется сразу (show в app.js); дальше — только перерисовка карты Leaflet: ждём вкладку и чуть-чуть, а не
        # полсекунды вслепую (вкладки переключаются ~70 раз за прогон)
        self.page.wait_for_selector(f"#view-{v}:not([hidden])", timeout=8000)
        self.page.wait_for_timeout(250)

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


def kom_click(s, sel):
    """Правка Комиссии в карточке бани — пункты меню под карандашом (02.11): открыть меню, если закрыто, и нажать пункт."""
    if s.js("() => !!document.getElementById('dEditMenu') && document.getElementById('dEditMenu').hidden"):
        s.page.click("#dEditBtn")
    s.page.click(sel)


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
    # таблица по макету (04.11): линия Кубка с подписью, движение за неделю, столбцы словами с расшифровкой
    check(f"{label}: таблица — линия Кубка после 16-го, расшифровки у столбцов",
          s.js("() => !!document.querySelector('#standings tr.cupline')"
               " && [...document.querySelectorAll('#standings th[data-tip]')].length >= 7 && !document.querySelector('.legend-cols')"))
    if mobile:
        # телефон: «Войти»/аватарка не лежит на подзаголовке; таблица не листается вбок; строка раскрывается, а профиль — кнопкой
        check(f"{label}: шапка таблицы — кнопка входа не на подзаголовке",
              s.js("() => { const a = document.querySelector('#view-table .page-head .me-btn')?.getBoundingClientRect(), t = document.querySelector('#tableEyebrow > span')?.getBoundingClientRect();"
                   " return !!a && !!t && (t.right <= a.left || t.top >= a.bottom); }"))
        # 04.11 (отзыв): таблица целиком, листается вбок, а участник прилип слева — видно, чьи цифры
        s.js("() => { const w = document.getElementById('standings').closest('.tablewrap'); w.scrollLeft = w.scrollWidth; }"); s.page.wait_for_timeout(200)
        check(f"{label}: таблица листается вбок, участник остаётся слева",
              s.js("() => { const w = document.getElementById('standings').closest('.tablewrap'), c = document.querySelector('#standings tbody td.who-cell').getBoundingClientRect();"
                   " return w.scrollLeft > 0 && c.left >= w.getBoundingClientRect().left - 1 && c.left < w.getBoundingClientRect().left + 10; }"))
    s.page.click("#standings tbody tr")
    check(f"{label}: карточка участника открылась", s.js("() => !document.getElementById('playerModal').hidden"))
    # профиль (05.11): у бани — значок типа; на телефоне география выше списка, а в списке первые 8 и «Показать все»
    check(f"{label}: профиль — у бань в списке значок типа", s.js("() => !!document.querySelector('#playerBody .blist button .dot')"))
    # 05.11: годы в профиле — нажал прошлый год, ниже его бани; «Показать на карте» — бани участника за этот год
    yb = s.js("() => document.querySelector('#playerBody [data-year]:not([aria-pressed=true])')?.dataset.year || ''")
    if yb and not mobile:
        s.page.click(f'#playerBody [data-year="{yb}"]'); s.page.wait_for_timeout(200)
        check(f"{label}: профиль — нажал {yb}: список «Бани {yb}», год выбран",
              s.js(f"() => [...document.querySelectorAll('#playerBody h3')].some((h) => h.textContent.startsWith('Бани {yb}')) && document.querySelector('#playerBody [data-year=\"{yb}\"]').getAttribute('aria-pressed') === 'true'"))
        s.page.click("#pOnMap"); s.page.wait_for_timeout(400)
        check(f"{label}: …«Показать на карте» — бани участника за {yb}",
              s.js("() => document.getElementById('fSeason').value") == yb and s.js("() => document.querySelectorAll('#list .item').length > 0") and f"в {yb}" in s.js("() => document.getElementById('count').innerText"))
        s.js("() => { const f = document.getElementById('fSeason'); f.value = 'all'; document.getElementById('fPlayer').value = ''; f.dispatchEvent(new Event('change')); }")
        s.view("table"); s.page.click("#standings tbody tr")
        # «Всё» — за все годы: плитки «походов / разных бань», график по годам
        s.page.click('#playerBody [data-year="all"]'); s.page.wait_for_timeout(200)
        check(f"{label}: профиль — «Всё»: плитки за все годы и бани по годам",
              s.js("() => /разных бань/.test(document.querySelector('#playerBody .stats').innerText) && !!document.querySelector('#playerBody .ybars') && !document.getElementById('pBars')"))
    if mobile and s.js("() => !!document.querySelector('#playerBody .bl-all')"):
        check(f"{label}: профиль на телефоне — география выше списка бань, в списке 8, остальное спрятано",
              s.js("() => { const g = [...document.querySelectorAll('#playerBody h3')].find((h) => h.textContent === 'География'), l = document.querySelector('#playerBody .blist');"
                   " return g.getBoundingClientRect().top < l.getBoundingClientRect().top && [...l.querySelectorAll('button[data-bath]')].filter((b) => b.offsetParent).length === 8; }"))
        s.page.click("#playerBody .bl-all")
        check(f"{label}: «Показать все» раскрывает весь список", s.js("() => [...document.querySelectorAll('#playerBody .blist button[data-bath]')].every((b) => b.offsetParent)"))
    # бани по неделям (24.10): над графиком итог и рекорд; нажал на столбик — его неделя и сколько бань, ещё раз — снова итог
    if s.js("() => !!document.querySelector('#pBars [data-w]:not(.zero)')"):
        read = lambda: s.js("() => document.getElementById('pBarsRead').innerText")
        summary = read()
        if mobile:
            s.page.tap("#pBars [data-w]:not(.zero)"); picked = read(); s.page.tap("#pBars [data-w].on")
        else:
            s.page.hover("#pBars [data-w]:not(.zero)"); picked = read(); s.page.mouse.move(2, 2)
        check(f"{label}: график недель — итог, по нажатию неделя с числом бань, повторно — снова итог",
              "рекорд" in summary and picked.startswith("W") and re.search(r"\d+ бан", picked) and read() == summary, (summary, picked, read()))
    s.js("() => (document.getElementById('playerModal').hidden = true)")
    s.view("map")
    s.page.click("#list .item[data-id]")
    s.page.wait_for_timeout(700)
    check(f"{label}: карточка бани открылась", s.js("() => !document.getElementById('drawer').hidden"))
    s.page.click("#drawer .x")
    s.clean(label)


with sync_playwright() as pw:
    url = serve()
    # Chromium из playwright, не установленный Chrome: тот обновляется сам и с Python под Intel идёт через Rosetta (в 20 раз медленнее)
    browser = pw.chromium.launch(headless=True)
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
        check("на главной при старте — все бани, не только 2026 (30.10)", s.js("() => document.getElementById('fSeason').value") == "all")
        s.close()
        # 30.10: ссылка на баню — ebl.su/#bath=<номер> открывает её карточку; закрыл — снова #map
        vb = sql("select id from baths where name = 'Василевские' limit 1")
        s = Site(browser, url + f"#bath={vb}", config=cfg2(API, dead), name="bath-link")
        s.page.wait_for_selector("#drawer:not([hidden])", timeout=8000)
        check("ссылка #bath=<номер> открывает карточку этой бани, в карточке — «Поделиться»",
              s.js("() => document.querySelector('#drawer').innerText.includes('Василевские') && !!document.getElementById('dShare')"))
        # 02.11: потерянная скобка в style.css спрятала стили карточки в правила телефона — на компьютере лист-оценка был на пол-экрана
        check("карточка на компьютере со своими стилями: главное — тремя колонками, веник-оценка маленький",
              s.js("() => { const k = document.querySelector('#drawer .d-key'), f = document.querySelector('#drawer .fan'); return !!k && getComputedStyle(k).display === 'grid' && (!f || f.getBoundingClientRect().width < 40); }"))
        s.page.click("#drawer .x:not(.x-share)"); s.page.wait_for_timeout(200)
        check("…закрыл карточку — в адресе снова #map", s.js("() => location.hash") == "#map")
        # 04.11: «Назад» в браузере (кнопка Android) — закрывает верхнее открытое, а не уводит с сайта
        here = lambda: s.js("() => location.href").startswith(url)
        back = lambda: (s.page.go_back(wait_until="commit"), s.page.wait_for_timeout(400))
        s.page.click("#list .item"); s.page.wait_for_selector("#drawer:not([hidden])", timeout=5000)
        back()
        check("«Назад» с карточки бани — снова карта, на сайте", here() and s.js("() => document.getElementById('drawer').hidden && location.hash === '#map'"))
        s.view("table"); s.view("feed"); back()
        check("«Назад» с вкладки — на прошлую вкладку", here() and s.js("() => document.body.dataset.view") == "table")
        back()
        check("…и ещё раз — на карту", here() and s.js("() => document.body.dataset.view") == "map")
        s.page.click("#addVisitBtn"); s.page.wait_for_selector(".modal:not([hidden])", timeout=5000)
        back()
        check("«Назад» в открытом окне — окно закрылось, сайт на месте", here() and s.js("() => ![...document.querySelectorAll('.modal')].some((m) => !m.hidden)"))
        s.page.click("#list .item"); s.page.wait_for_selector("#drawer:not([hidden])", timeout=5000)
        s.page.click("#drawer .x:not(.x-share)"); s.page.wait_for_timeout(200)
        s.view("table"); back()
        check("закрыл карточку крестиком — «Назад» с вкладки ведёт на карту, а не открывает баню снова",
              here() and s.js("() => document.body.dataset.view === 'map' && document.getElementById('drawer').hidden"))
        s.close()
        # 05.11: Радар на карте всем — места 70+, где лига не была: кольца, чип «Никто не был», карточка с индексом;
        # у бани лиги, привязанной к месту Радара, — индекс в «О бане»; участник «Отметить поход» — место становится баней
        sql("delete from radar_places where key like 'site:%'")
        vbid = sql("select id from baths where name = 'Василевские' limit 1")
        sql(f"""insert into radar_places (key, name, city, region, address, lat, lng, kind, public_index, price_example, note, gender_split, ticket_per_person, status, bath_id) values
              ('site:1', 'Тестовая баня Радара', 'Тестово', 'Новосибирская область', 'ул. Пара, 9', 55.03, 82.92, 'public', 96, 'от 293 ₽ (2ГИС)', 'Муниципальная баня на дровах', true, true, 'new', null),
              ('site:2', 'Тестовая баня под вопросом', 'Тестово', 'Москва', null, 55.62, 37.42, 'public', 60, null, null, null, null, 'new', null),
              ('site:3', 'Василевские в Радаре', 'Москва', 'Москва', null, 55.7, 37.6, 'public', 86, null, null, null, null, 'matched', {vbid})""")
        r1 = sql("select id from radar_places where key = 'site:1'")
        s = Site(browser, url, config=cfg2(API, dead), name="radar-guest")
        s.page.wait_for_selector("#fRadar:not([hidden])", timeout=8000)
        check("Радар на карте: чип «УУ» с числом мест 50+ (и «под вопросом»)", s.js("() => document.querySelector('#fRadar small').textContent") == "2" and s.js("() => document.getElementById('fRadar').innerText").startswith("УУ"))
        check("…без чипа колец УУ нет: в подписи списка — только бани лиги", not s.js("() => /УУ/.test(document.getElementById('count').innerText)"))
        s.page.click("#fRadar"); s.page.wait_for_timeout(500)
        check("…нажал — в списке только места Радара, по индексу; «под вопросом» — светлее и последним",
              s.js("() => { const it = [...document.querySelectorAll('#list .item[data-radar-id]')]; return it.length === 2 && !document.querySelector('#list .item[data-id]') && /96/.test(it[0].innerText) && it[1].querySelector('.uu-dot.doubt') && /под вопросом/.test(it[1].innerText); }"))
        s.page.click("#list .item[data-radar-id]"); s.page.wait_for_selector("#drawer:not([hidden])", timeout=5000)
        check("…карточка места: «никто из лиги ещё не был», индекс 96 «точно общественная», «Первый поход +4», «Отметить поход»",
              s.js("() => { const t = document.getElementById('drawer').innerText; return /никто из лиги ещё не был/.test(t) && /96/.test(t) && /точно общественная/.test(t) && /\\+4 очка/.test(t) && !!document.getElementById('dRadarGo'); }"))
        s.page.click("#dRadarGo"); s.page.wait_for_timeout(300)
        check("…гость нажал «Отметить поход» — просят войти, баня не заводится", s.js("() => !document.getElementById('loginModal').hidden") and sql(f"select status from radar_places where id = {r1}") == "new")
        s.js("() => (document.getElementById('loginModal').hidden = true)"); s.page.click("#drawer .x"); s.page.click("#fRadar"); s.page.wait_for_timeout(300)
        s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300); s.page.click(f'#list .item[data-id="{vbid}"]'); s.page.wait_for_selector("#dIdx:not([hidden])", timeout=8000)
        check("у бани лиги, привязанной к месту Радара, — индекс в «О бане»", s.js("() => /86/.test(document.getElementById('dIdx').innerText) && /скорее общественная/.test(document.getElementById('dIdx').innerText)"))
        # 05.11: фильтры вместе — «Общественные» + «Хуитнесы» — обе группы; + «УУ» — и бани лиги, и УУ
        s.page.click("#drawer .x"); s.page.fill("#q", ""); s.page.wait_for_timeout(300)
        s.page.click('#fType [data-t="public"]'); s.page.click('#fType [data-t="spa"]'); s.page.wait_for_timeout(400)
        dots = s.js("() => [...new Set([...document.querySelectorAll('#list .item[data-id] .dot')].map((d) => [...d.classList].find((c) => c.startsWith('t-'))))].sort().join()")
        check("типы вместе: «Общественные» + «Хуитнесы» — в списке ровно они", dots == "t-public,t-spa", dots)
        s.page.click('#fType [data-t="spa"]'); s.page.click("#fRadar"); s.page.wait_for_timeout(400)
        check("«Общественные» + «УУ»: в списке общественные бани лиги, в подписи — сколько УУ на карте",
              s.js("() => [...document.querySelectorAll('#list .item[data-id] .dot')].every((d) => d.classList.contains('t-public')) && /\\+ 2 УУ/.test(document.getElementById('count').innerText)"))
        s.page.click('#fType [data-t="public"]'); s.page.click("#fRadar"); s.page.wait_for_timeout(600)
        # 05.11: «карта отскакивает при переборе фильтров» — пока в кадре есть что показать, карта стоит на месте
        where = lambda: s.js("() => document.querySelector('#map .leaflet-map-pane').style.transform + '|' + document.querySelector('#map .leaflet-tile')?.src.match(/\\/(\\d+)\\/\\d+\\/\\d+/)?.[1]")
        w0 = where()
        for sel in ('#fType [data-t="public"]', "#fRadar", '#fType [data-t="public"]', "#fRadar", '#fType [data-t="spa"]', '#fType [data-t="spa"]'):
            s.page.click(sel); s.page.wait_for_timeout(350)
        check("перебор «Общественные» / «УУ» / «Хуитнесы» туда и обратно — карта не двигается", where() == w0, (w0, where()))
        s.close()
        # 05.11 (на мобилке): тап по кольцу открывал карточку и тут же закрывал — нажатие доходило до карты; теперь УУ —
        # эмблемы, как у бань лиги
        s = Site(browser, url, config=cfg2(API, dead), mobile=True, name="radar-mobile")
        s.page.wait_for_selector("#fRadar:not([hidden])", timeout=8000); s.page.wait_for_timeout(800)
        check("телефон: без чипа «УУ» эмблем УУ на карте нет", not s.js("() => !!document.querySelector('#map .pin.uu')"))
        s.page.click("#fRadar"); s.page.wait_for_timeout(1500)
        s.page.locator("#map .pin.uu").first.tap(); s.page.wait_for_timeout(1000)
        check("телефон: тап по фиолетовой эмблеме УУ — карточка места открылась и осталась открытой",
              s.js("() => !document.getElementById('drawer').hidden && /УУ/.test(document.querySelector('#drawer .uu-flag')?.innerText || '')"))
        s.close()
        s = Site(browser, url, sess=shurik, name="radar-member")
        s.page.wait_for_selector("#fRadar:not([hidden])", timeout=8000); s.page.click("#fRadar"); s.page.wait_for_timeout(300)
        s.page.click("#list .item[data-radar-id]"); s.page.wait_for_selector("#dRadarGo", timeout=5000); s.page.click("#dRadarGo")
        s.page.wait_for_selector("#visitModal:not([hidden])", timeout=10000)
        nb = sql(f"select bath_id from radar_places where id = {r1}")
        check("участник «Отметить поход» — место стало баней лиги, открылась форма похода с этой баней",
              sql(f"select status from radar_places where id = {r1}") == "added" and s.js("() => document.getElementById('visitModal').innerText").find("Тестовая баня Радара") >= 0)
        s.js("() => (document.getElementById('visitModal').hidden = true)")
        s.clean("Радар на карте"); s.close()
        sql("delete from radar_places where key like 'site:%'"); sql(f"delete from baths where id = {nb}")
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

        # кнопка «Отметить поход» в закрепе группы (02.11): t.me/eblsu_bot?startapp=visit — Telegram открывает сайт
        # с ?tgWebAppStartParam=visit и подписанными данными в адресе; входим без кода и сразу показываем форму похода
        from urllib.parse import quote
        s = Site(browser, url + "?tgWebAppStartParam=visit#tgWebAppData=" + quote(webapp_init(2002, "Shurik_TG"), safe="")
                 + "&tgWebAppVersion=8.0&tgWebAppPlatform=ios", name="tg-app", mobile=True)
        s.page.wait_for_selector("#visitModal:not([hidden])", timeout=15000)
        check("кнопка из Telegram: вошёл сам как Шурик и сразу открыта форма похода, данные Telegram из адреса убраны",
              s.js("() => document.getElementById('meBtn').getAttribute('aria-label') === 'Профиль: Шурик'")
              and s.js("() => document.getElementById('vPlayer').value") == "Шурик" and "tgWebAppData" not in s.page.url, s.page.url)
        s.clean("кнопка из Telegram")
        s.close()
        s = Site(browser, url + "?tgWebAppStartParam=visit#tgWebAppData=" + quote(webapp_init(2002, "Shurik_TG").replace("Shurik_TG", "Vitek_TG"), safe=""),
                 name="tg-app-bad", mobile=True, noise="/functions/v1/tg-login")
        s.page.wait_for_selector("#loginModal:not([hidden])", timeout=15000)
        check("подделанные данные Telegram — не вошёл, форма просит войти", s.js("() => !document.getElementById('meBtn').getAttribute('aria-label')?.startsWith('Профиль')"))
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
        # 05.11 (макет): у выбранного хозяина — его шапки списком, у каждой — кто следом; правило — сверху
        check("нажал на хозяина — под ним его шапки и кто следом", s.js("() => document.querySelectorAll('#oList li.own-sub[data-bath]').length >= 1 && /следом|дышит в спину|больше никто/.test(document.querySelector('#oList li.own-sub').innerText)"))
        check("правило шапки — сверху карточки, а не внизу", s.js("() => /Шапка — у кого больше всех походов/.test(document.querySelector('.own-rule').innerText)"))
        if s.js("() => !!document.querySelector('.own-grab li[data-bath]')"):
            check("«Отжать шапку»: у каждой бани — сколько ещё походов", s.js("() => [...document.querySelectorAll('.own-grab .hv')].every((x) => /^\\+\\d+$/.test(x.innerText))"))
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
        check("попутчик выбран — у «Сколько парились» ссылка «у кого-то иначе», строки спрятаны",
              s.js("() => !document.getElementById('vDursToggle').hidden && document.getElementById('vDurs').hidden && /иначе/.test(document.getElementById('vDursToggle').innerText)"))
        s.page.click("#vDursToggle")
        check("…вместо больших кнопок — у каждого своё: ты первым, у попутчика как у тебя (🔥 долгая)",
              s.js(f"""() => document.getElementById('vDurChips').hidden && document.querySelectorAll('#vDurs .durs-row').length === 2
                && /ты/.test(document.querySelector('#vDurs .durs-row').innerText)
                && document.querySelector('#vDurs [data-dp="{mate}"][data-m="180"]').getAttribute('aria-pressed') === 'true'"""))
        s.page.click(f'#vDurs [data-dp="{mate}"][data-m="120"]')
        s.page.fill("#vPrice", "700"); s.page.fill("#vPrBeer", "280")
        s.page.set_input_files("#vPhotos", files=[{"name": "par.png", "mimeType": "image/png", "buffer": TILE}])
        s.page.wait_for_timeout(500)
        check("строка «Когда зашёл»: «Сегодня, ЧЧ:ММ · МСК · W…»", s.js("() => /^Сегодня, \\d\\d:\\d\\d$/.test(document.getElementById('vWhenTxt').innerText) && /МСК · W\\d+/.test(document.getElementById('vWeekHint').innerText)"))
        check("выбранное фото — плиткой рядом с камерой", s.js("() => document.querySelectorAll('#vPhotosPrev img').length === 1"))
        check("очки по людям: «Ты +N …» и у попутчика своя строка",
              s.js(f"() => {{ const r = [...document.querySelectorAll('#calc .t-who')].map((x) => x.querySelector('b').innerText + ' ' + x.querySelector('em').innerText); return r.length === 2 && /^Ты \\+[1-9]/.test(r[0]) && r[1].startsWith('{mate} +'); }}"),
              s.js("() => document.getElementById('calc').innerText"))
        check("кнопка — «Отправить в Комиссию»", s.js("() => /Отправить в Комиссию/.test(document.getElementById('vSubmit').innerText)"))
        s.page.click("#vSubmit")
        s.page.wait_for_selector("#vSent:not([hidden])", timeout=10000)
        check("после отправки — «С лёгким паром!», баня и очки по людям, форма спрятана",
              s.js("() => /С лёгким паром/.test(document.getElementById('vSent').innerText) && document.querySelectorAll('#vSent .t-who').length === 2 && !document.getElementById('vSubmit').offsetParent"))
        s.page.click("#vDone")
        s.page.wait_for_selector("#visitModal", state="hidden", timeout=3000)
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
        sql(f"delete from bath_prices where bath_id = {bath}"); sql(f"delete from bath_beer_prices where bath_id = {bath}"); sql(f"delete from bath_schedule where bath_id = {bath}")
        sql("delete from catalog_proposals where run = 'test'")   # часы из сверки от упавшего прогона спрятали бы поля часов в форме пар
        # точка примерная — форма похода просит ссылку и ставит точку сразу, не дожидаясь отправки похода
        orig = sql(f"select lat || ',' || lng || ',' || precision from baths where id = {bath}")
        sql(f"update baths set precision = 'city' where id = {bath}")
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        s.page.click("#addVisitBtn")   # карточка открыта — эта баня уже подставлена (02.11: «Я тут парился» в карточке больше нет)
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
              s.js("() => !document.getElementById('dRename') && !document.getElementById('dTypeBtn') && !document.getElementById('dCloseBtn') && !document.getElementById('dPlaceBtn') && document.getElementById('fPrecGrp').hidden"))
        kom_click(s, "#geoFixBtn"); s.page.fill("#geoFixInput", "55.783951, 37.354822"); s.page.click('#geoFixForm button[type="submit"]')
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
        check("в карточке сначала главное (сегодня, вход, оценка) и кнопки карт; формы цены и отзыва — по кнопке",
              s.js("() => document.getElementById('prForm').hidden && !!document.querySelector('#drawer #dMain #dPriceV') && !!document.querySelector('#drawer .d-acts #dShare') && !document.querySelector('#drawer .d-foot')"))
        # 02.11: «Отзывы и оценки» — одной лентой; пишут на странице оценки (кнопка — тем, кто был), в карточке формы нет
        check("в карточке нет своей формы отзыва — кнопка ведёт на страницу оценки или её нет",
              s.js(f"() => !document.getElementById('rvForm') && (!document.getElementById('rvGo') || document.getElementById('rvGo').getAttribute('href') === 'rate.html?b={bath}')"))
        shurik_id = player_id('Шурик')
        for t in ("Первый отзыв — проверка сайта", "Второй отзыв — проверка сайта"):
            sql(f"insert into reviews (bath_id, player_id, rating, text) values ({bath}, '{shurik_id}', 4, '{t}')")
        sql(f"insert into bath_ratings (visit_id, bath_id, player_id, stove, steam, aqua, outdoor, kitchen, atmosphere, service, prices) values (null, {bath}, '{player_id('Витёк')}', 5, 5, 4, 4, 3, 5, 4, 4)")
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_function("() => /оценка без отзыва/.test(document.getElementById('dFeedback')?.innerText || '')", timeout=8000)
        fb = s.js("() => document.getElementById('dFeedback').innerText")
        check("лента: оба отзыва и оценка Витька без текста (с цифрой и веником)", "Первый отзыв" in fb and "Второй отзыв" in fb and "Витёк" in fb and "оценка без отзыва" in fb
              and s.js("() => document.querySelectorAll('#dFeedback .review .fan').length >= 1"), fb[:400])
        my_reviews = f"select count(*) from reviews where bath_id = {bath} and player_id = '{shurik_id}' and text like '%— проверка сайта'"
        s.page.click("#dFeedback .review.mine [data-rvmenu]"); s.page.click("#dFeedback .review.mine [data-rvdel]"); s.page.wait_for_timeout(900)
        check("свой отзыв можно удалить — оценка остаётся", sql(my_reviews) == "1", sql(my_reviews))
        sql(f"delete from reviews where bath_id = {bath} and text like '%— проверка сайта'"); sql(f"delete from bath_ratings where bath_id = {bath} and visit_id is null")
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
        # 25.10: цена с центами — «12,5» с запятой в евро сохраняется как есть и показывается «12,50 EUR»
        if s.js("() => document.getElementById('prExtra').hidden"): s.page.click("#prMore")
        s.page.fill("#prPrice", "12,5"); s.page.fill("#prCurrency", "EUR"); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("цена с центами (EUR, через запятую) — сохранилась без округления",
              sql(f"select count(*) from bath_prices where bath_id = {bath} and currency = 'EUR' and price = 12.5") == "1")
        check("…и показывается с двумя знаками", s.js("() => document.querySelector('#drawer').innerText.includes('12,50')"),
              s.js("() => document.querySelector('#drawer').innerText.slice(0, 600)"))
        if s.js("() => document.getElementById('prExtra').hidden"): s.page.click("#prMore")
        s.page.fill("#prPrice", "640,4"); s.page.fill("#prCurrency", ""); s.page.click('#prForm button[type="submit"]'); s.page.wait_for_timeout(900)
        check("рубли — только целые: «640,4» без валюты сохранилась как 640",
              sql(f"select count(*) from bath_prices where bath_id = {bath} and currency = 'RUB' and price = 640") == "1")
        # 27.10: пары и часы работы — «каждый час» раскладывается из «с — до», «другое» — часы отмечает сам, повтор не дублирует
        sched_rows = f"select count(*) from bath_schedule where bath_id = {bath}"
        s.page.click("#shOpen"); s.page.click('#shEvery button[data-e="60"]')
        check("время — только :00 и :30 (28.10)", s.js("() => ['shFrom', 'shTo', 'shOpenT', 'shCloseT'].every((x) => { const o = [...document.getElementById(x).options].filter((o) => o.value); return o.length === 48 && o.every((o) => /:(00|30)$/.test(o.value)); })"))
        s.page.select_option("#shFrom", "14:00"); s.page.select_option("#shTo", "17:00")
        check("«каждый час с 14 до 17» — сайт сам показывает пары", s.js("() => document.getElementById('shPreview').innerText.includes('14:00 · 15:00 · 16:00 · 17:00')"))
        s.page.select_option("#shOpenT", "10:00"); s.page.select_option("#shCloseT", "23:00")
        s.page.click('#shForm button[type="submit"]'); s.page.wait_for_timeout(1200)
        check("пары и часы работы сохранились", sql(sched_rows) == "2", sql(sched_rows))
        check("…пары — списком времени", sql(f"select times::text from bath_schedule where bath_id = {bath} and kind = 'steam'") == "{14:00:00,15:00:00,16:00:00,17:00:00}")
        check("карточка показывает пары и часы", s.js("() => { const t = document.getElementById('dSched').innerText; return t.includes('каждый час с 14:00 до 17:00') && t.includes('10:00–23:00') }"),
              s.js("() => document.getElementById('dSched').innerText"))
        s.page.click("#shOpen")
        check("часы работы уже есть — в форме их не спрашиваем, только «изменить»",
              s.js("() => document.getElementById('shHours').hidden && !document.getElementById('shHoursEdit').hidden && document.getElementById('shOpen').textContent === '+ Указать пары'"))
        s.page.click('#shEvery button[data-e="60"]'); s.page.select_option("#shFrom", "14:00"); s.page.select_option("#shTo", "17:00")
        s.page.click('#shForm button[type="submit"]'); s.page.wait_for_timeout(1200)
        check("те же пары ещё раз — не дублируем", sql(sched_rows) == "2", sql(sched_rows))
        s.page.click('#shEvery button[data-e="other"]')
        for t in ("12:00", "15:00", "19:00"): s.page.click(f'#shPick button[data-t="{t}"]')
        s.page.click('#shForm button[type="submit"]'); s.page.wait_for_timeout(1200)
        check("«другое» — отмеченные часы, новая запись, старая осталась", sql(sched_rows) == "3", sql(sched_rows))
        check("карточка показывает свежие пары", s.js("() => document.getElementById('dSched').innerText.includes('12:00 · 15:00 · 19:00')"),
              s.js("() => document.getElementById('dSched').innerText"))
        s.page.click("#dSched [data-hedit]")
        check("«изменить» у часов — поля открыты и заполнены нынешними", s.js("() => !document.getElementById('shForm').hidden && !document.getElementById('shHours').hidden && document.getElementById('shOpenT').value === '10:00'"))
        s.page.select_option("#shOpenT", "09:30"); s.page.click('#shForm button[type="submit"]'); s.page.wait_for_timeout(1200)
        check("…новые часы — новой записью", sql(f"select open_time::text from bath_schedule where bath_id = {bath} and kind = 'hours' order by id desc limit 1") == "09:30:00"
              and s.js("() => document.getElementById('dSched').innerText.includes('09:30–23:00')"), s.js("() => document.getElementById('dSched').innerText"))
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
        # 03.11: лента — дни, засчитанные строками, очки у каждого свои (общей цифры у похода нет)
        check("лента: засчитанный поход — строкой, очки по людям", s.js(f"() => {{ const r = document.querySelector('[data-edit=\"{vid}\"]')?.closest('.frow'); return !!r && /\\+\\d/.test(r.querySelector('.f-split')?.innerText || '') && !!r.closest('.f-day'); }}"))
        check("лента: шапка — неделя, фильтры «Все · Мои · На проверке»", s.js("() => /^W\\d+ · \\d+ поход/.test(document.getElementById('feedWeek').innerText) && [...document.querySelectorAll('#feedFilter button')].map((b) => b.dataset.f).join() === 'all,mine,pending'"))
        check("в ленте видно, у кого была другая длительность", s.js(f"() => (document.querySelector('[data-edit=\"{vid}\"]')?.closest('.frow, .post')?.innerText || '').includes('— экспресс')"))
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
        kom_click(s, "#dRename"); s.page.wait_for_timeout(900)
        check("Комиссия переименовывает баню в карточке", sql(f"select name from baths where id = {bath}") == "проверка сайта")
        sql(f"update baths set name = '{bath_name}' where id = {bath}")
        # тип бани — и из карточки (18.10), но только Комиссии и только после подтверждения
        btype = lambda: sql(f"select coalesce(type, '') from baths where id = {bath}")
        kom_click(s, "#dTypeBtn")
        # страница помнит тип из справочника выше (в базе его уже откатили) — берём тип, отличный от показанного в карточке
        shown = s.js("() => document.querySelector('#dTypeAsk [aria-pressed=\"true\"]')?.dataset.newtype || ''")
        card_type = next(t for t in ("public", "spa", "private") if t != shown)
        s.page.click(f'#dTypeAsk [data-newtype="{card_type}"]')
        check("смена типа в карточке: видно «было → станет» и что очки пересчитаются; без «Сменить» тип прежний",
              s.js("() => /→/.test(document.getElementById('dTypeNote').innerText) && /пересчита/.test(document.getElementById('dTypeNote').innerText)") and btype() == old_type)
        s.page.click("#dTypeCancel")
        check("«Отмена» — строка закрылась, тип прежний", s.js("() => document.getElementById('dTypeAsk').hidden") and btype() == old_type)
        kom_click(s, "#dTypeBtn"); s.page.click(f'#dTypeAsk [data-newtype="{card_type}"]'); s.page.click("#dTypeGo"); s.page.wait_for_timeout(1500)
        check("«Сменить» — тип бани поменялся", btype() == card_type)
        sql(f"update baths set type = {repr(old_type) if old_type else 'null'} where id = {bath}")
        # баня закрылась (19.10): Комиссия отмечает в карточке с подтверждением; походы остаются, в форме похода не предлагаем
        bclosed = lambda: sql(f"select coalesce(closed_on::text, '') from baths where id = {bath}")
        kom_click(s, "#dCloseBtn")
        check("«Закрылась?» — строка подтверждения с месяцем, без «Закрыта» ничего не меняется",
              s.js("() => !document.getElementById('dCloseAsk').hidden && /Походы и очки останутся/.test(document.getElementById('dCloseAsk').innerText) && !!document.getElementById('dCloseMonth')") and bclosed() == "")
        s.page.click("#dCloseGo"); s.page.wait_for_timeout(1500)
        month = sql("select to_char(now(), 'YYYY-MM')")
        check("«Закрыта» — в лиге дата закрытия, в карточке «закрыта с …», в строке места — «работает снова?»",
              bclosed() == f"{month}-01" and s.js("() => /закрыта с/.test(document.querySelector('#drawer .d-meta').innerText) && /работает снова/i.test(document.getElementById('dCloseBtn').innerText)"), bclosed())
        # страница помнит временное название из проверки переименования выше — перезагружаем, чтобы искать по настоящему
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.page.click("#addVisitBtn"); s.page.wait_for_timeout(400)
        s.page.fill("#vBathQ", "Василевские"); s.page.wait_for_timeout(300)
        check("закрытую баню форма похода не предлагает (открытые с похожим названием — предлагает)",
              s.js(f"() => !document.querySelector('#vSuggest [data-id=\"{bath}\"]')") and sql(f"select closed_on is not null from baths where id = {bath}") == "t")
        s.page.click("#visitModal [data-close]"); s.page.wait_for_timeout(300)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        # метки собраны в группы и в странице только видимые — сначала к бане (открыл и закрыл карточку), потом смотрим метку
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(900); s.page.click("#drawer .x"); s.page.wait_for_timeout(500)
        check("на карте закрытая баня — бледная", s.js("() => !!document.querySelector('#map .pin.closed')"))
        s.page.click(f'#list .item[data-id="{bath}"]'); s.page.wait_for_timeout(700)
        kom_click(s, "#dCloseBtn"); s.page.click("#dCloseGo"); s.page.wait_for_timeout(1500)
        check("«Работает снова» — дата закрытия снята", bclosed() == "")
        sql(f"update baths set closed_on = null where id = {bath}")
        # страна и регион (21.10): из таблицы бывают неверные («Хельсинки» в Хабаровском крае) — Комиссия правит в карточке
        bplace = lambda: sql(f"select coalesce(country, '') || '|' || coalesce(region, '') from baths where id = {bath}")
        old_place = bplace(); old_country, old_region = old_place.split("|")
        kom_click(s, "#dPlaceBtn")
        check("«Регион не тот?» — строка со страной и регионом, как сейчас у бани",
              s.js("() => !document.getElementById('dPlaceAsk').hidden") and s.page.input_value("#dPlaceCountry") == old_country and s.page.input_value("#dPlaceRegion") == old_region)
        s.page.fill("#dPlaceCountry", "Финляндия"); s.page.fill("#dPlaceRegion", "Уусимаа"); s.page.click("#dPlaceGo"); s.page.wait_for_timeout(1500)
        check("«Сохранить» — в лиге новые страна и регион, в карточке тоже", bplace() == "Финляндия|Уусимаа" and
              s.js("() => /Уусимаа, Финляндия/.test(document.getElementById('dWhereTxt').innerText)"), bplace())
        # написание — как уже встречалось у лиги: «москва» не заводит новый регион рядом с «Москва»
        kom_click(s, "#dPlaceBtn"); s.page.fill("#dPlaceCountry", old_country.lower()); s.page.fill("#dPlaceRegion", old_region.lower())
        s.page.click("#dPlaceGo"); s.page.wait_for_timeout(1500)
        check("регион строчными — сохранился в написании лиги", bplace() == old_place, bplace())
        sql(f"update baths set country = {repr(old_country) if old_country else 'null'}, region = {repr(old_region) if old_region else 'null'} where id = {bath}")
        # поход за другого (только на сайте): Комиссия сама выбирает «Кто» и в бане могла не быть
        s.page.click("#addVisitBtn")   # при открытой карточке — поход в эту баню
        check("Комиссии «Кто» можно выбрать", s.js("() => !document.getElementById('vPlayer').disabled && !document.getElementById('vPlayerHint').hidden"))
        s.page.select_option("#vPlayer", "Леха")
        s.page.fill("#vDate", "2026-10-01T19:00"); s.page.wait_for_timeout(300)
        s.page.click("#vSubmit"); s.page.wait_for_selector("#vSent:not([hidden])", timeout=10000); s.page.click("#vDone")
        fv = sql("select coalesce(max(id), 0) from visits where entered_by = (select id from players where nick = 'Витёк')")
        who = sql(f"select a.nick || '/' || (select string_agg(p.nick, ',' order by p.nick) from visit_players vp join players p on p.id = vp.player_id where vp.visit_id = v.id) "
                  f"from visits v join players a on a.id = v.created_by where v.id = {fv}")
        check("поход — Лехи, внёс Витёк, Витька в компании нет", who == "Леха/Леха", who)
        s.view("feed"); s.page.click('#feedFilter button[data-f="pending"]'); s.page.wait_for_timeout(500)
        check("в ленте у такого похода — «внёс Витёк»", s.js(f"() => (document.querySelector('[data-ok=\"{fv}\"]')?.closest('.post')?.innerText || '').includes('внёс Витёк')"))
        sql(f"delete from visits where id = {fv}")
        # 18.10: фильтр Комиссии — бани с примерной точкой и без точки, чтобы пройтись и поправить
        s.view("map"); s.page.fill("#q", ""); s.page.select_option("#fPrec", "rough"); s.page.wait_for_timeout(600)
        rough = s.js("""() => ({ season: document.getElementById('fSeason').value, count: document.getElementById('count').innerText,
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
        s.page.select_option("#fPrec", ""); s.page.select_option("#fSeason", "2026"); s.page.wait_for_timeout(300)
        s.clean("Комиссия")
        s.close()
        # Радар (16.10): места из прогона агентов, решает Комиссия; участнику и гостю его нет
        sql("delete from radar_places where key like 'test:%'")
        hint = sql("select id from baths where name = 'Василевские' limit 1")
        # «Наши» — к бане лиги с примерной точкой (24.10): на время проверки Радара Василевские — «по городу»
        hint_prec = sql(f"select coalesce(precision, 'null') from baths where id = {hint}")
        sql(f"update baths set precision = 'city' where id = {hint}")
        sql(f"""insert into radar_places (key, name, region, city, address, lat, lng, kind, public_index, note, league_hint, website) values
              ('test:new', 'Тестовые общественные бани', 'Московская обл', 'Тестово', 'ул. Пара, 1', 55.9, 37.9, 'public', 93, 'Билет на сеанс, мужские и женские дни', null, 'https://example.org'),
              ('test:ours', 'Василевские бани', 'Москва', 'Москва', 'ул. Пара, 2', 55.75, 37.6, 'public', 90, 'Похоже на нашу', {hint}, null),
              ('test:rest', 'Сауна у Тестового', 'Москва', 'Москва', null, null, null, 'private', 5, 'Почасовая аренда', null, null)""")
        # ближе 150 м к точной точке бани лиги — это она (23.10): в Радаре не показываем, только строкой «не показываем 1 место»
        near_b = sql("select lat + 0.0005 || ', ' || lng from baths where precision = 'exact' and status <> 'rejected' and lat is not null "
                     "and lat not between 55.74 and 55.91 order by id limit 1")
        sql(f"insert into radar_places (key, name, region, city, lat, lng, kind, public_index) values ('test:near', 'Баня у нашей точки', 'Москва', 'Москва', {near_b}, 'public', 95)")
        # подсказка на баню с точной точкой, у места точки нет — это она же (24.10, «Сандуновские» → «Сандуны вр»): не показываем
        exact_b = sql("select id from baths where precision = 'exact' and status <> 'rejected' and lat is not null order by id limit 1")
        sql(f"insert into radar_places (key, name, region, city, kind, public_index, league_hint) values ('test:known', 'Наша же баня без точки', 'Москва', 'Москва', 'public', 97, {exact_b})")
        s = Site(browser, url, sess=vitek, name="commission-radar")
        s.view("dir"); s.page.click('#dirMode [data-mode="radar"]')
        s.page.wait_for_selector("#radarList .radar-card", timeout=8000)
        tabs = lambda: s.js("() => Object.fromEntries([...document.querySelectorAll('#radarTabs button')].map((b) => [b.dataset.tab, +b.querySelector('.n').innerText]))")
        check("Радар у Комиссии: вкладки по решению со счётчиками, открыты «Новые», прогресс разбора",
              tabs() == {"new": 1, "ours": 1, "review": 0, "search": 0, "rest": 1, "done": 0}
              and s.js("() => document.querySelector('#radarTabs [aria-pressed=\"true\"]').dataset.tab === 'new' && /Разобрано 0 из 2/.test(document.getElementById('radarProgress').innerText)"), tabs())
        check("место ближе 150 м к точной бане лиги и место без точки с подсказкой на точную — не показываем, только строкой в прогрессе",
              s.js("() => !/Баня у нашей точки|Наша же баня без точки/.test(document.getElementById('radarList').innerText) && /не показываем 2 места: это бани лиги с точной точкой/.test(document.getElementById('radarProgress').innerText)"),
              s.js("() => document.getElementById('radarProgress').innerText"))
        check("карточка: вердикт словами и факты, ссылки на сайт, Яндекс Карты и 2ГИС, главная кнопка «Завести в лигу»",
              s.js("""() => { const c = document.querySelector('#radarList .radar-card'); return /точно общественная · 93/.test(c.innerText)
                && c.querySelectorAll('.radar-links a').length === 3 && !!c.querySelector('[data-radar="add"].solid'); }"""))
        check("на карте рядом со списком — точки этой вкладки", s.js("() => document.querySelectorAll('#radarmap path.rd').length === 1"))
        rid = sql("select id from radar_places where key = 'test:new'")
        # «Это наша баня» (24.10): название не совпало («Лотос» = «Тула, Баня 4») — Комиссия сама выбирает баню лиги
        card = f'#radarList .radar-card[data-id="{rid}"]'
        s.page.click(f'{card} [data-radar="pick"]')
        s.page.fill(f'{card} [data-radarpick]', "Василевск"); s.page.wait_for_timeout(300)
        check("«Это наша баня» — поиск бани лиги по названию прямо в карточке",
              s.js(f"() => [...document.querySelectorAll('{card} [data-radar=\"pick-bath\"]')].some((b) => /Василевские/.test(b.innerText))"))
        s.page.click(f'{card} [data-radar="pick-bath"][data-bath="{hint}"]')
        check("выбрал баню — строка подтверждения «Перенести точку „Василевские“ сюда?», без «Перенести» ничего не меняется",
              s.js(f"() => /Перенести точку «Василевские» сюда/.test(document.querySelector('{card} .radar-ask')?.innerText || '')")
              and sql(f"select status from radar_places where id = {rid}") == "new")
        s.page.click(f'{card} [data-radar="cancel"]'); s.page.wait_for_timeout(200)
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
        sql(f"update baths set precision = {'null' if hint_prec == 'null' else repr(hint_prec)} where id = {hint}")
        # Сверка каталога (19.10): что агенты нашли по баням лиги; решает Комиссия — по одной или уверенные пачкой
        sql("delete from catalog_proposals where run = 'test'")
        cb_id, cb_lat, cb_lng, cb_prec = sql("select id || '|' || coalesce(lat::text, '') || '|' || coalesce(lng::text, '') || '|' || coalesce(precision, '') from baths where name = 'Василевские' limit 1").split("|")
        other = sql("select id from baths where status = 'ok' and name <> 'Василевские' order by id limit 1")
        own_b = sql(f"select id from baths where status = 'ok' and name <> 'Василевские' and id <> {other} order by id limit 1")
        own_was = sql(f"select coalesce(lat::text, 'null') || ',' || coalesce(lng::text, 'null') || ',' || coalesce(quote_literal(precision), 'null') from baths where id = {own_b}")
        sql(f"""insert into catalog_proposals (run, bath_id, found_name, address, lat, lng, point_src, match, match_why, bin, website, hours, gender_days, price, price_src, place_status, is_public, note, amenities, phone) values
              ('test', {cb_id}, 'Тестовые бани сверки', 'ул. Пара, 2', 55.7, 37.55, '2gis', 95, 'адрес совпал в 2ГИС и на сайте', 'new', 'https://example.org', 'ежедневно 8–22; третий понедельник — санитарный день', 'мужские пн, ср (по 2ГИС)', '1500 ₽ — билет на 3 часа; 2000 ₽ — в выходные; 22400 ₽ — кабина на 6 мест', 'https://zoon.ru/msk/sauna/test/', 'open', true, 'Точка из 2ГИС', '["купель", "веники"]', '+7 (495) 123-45-67, +7 900 000-00-00'),
              ('test', {other}, 'Тестовая неизвестная баня', null, null, null, null, 30, 'не нашли', 'notfound', null, null, null, null, null, 'unknown', null, 'Спросить у участников', '[]', null),
              ('test', {own_b}, 'Тестовая баня для своей точки', null, null, null, null, 20, 'не нашли', 'notfound', null, null, null, null, null, 'unknown', null, 'Спросить у участников', '[]', null)""")
        c_sure, c_doubt = (sql(f"select id from catalog_proposals where run = 'test' and bath_id = {b}") for b in (cb_id, other))
        # обратный ход (20.10): у нас хуитнес, по факту — общественная → вкладка «Тип»
        spa_b = sql("insert into baths (name, type, lat, lng, precision, status, country, region) values ('Тестовый хуитнес сверки', 'spa', 55.71, 37.51, 'city', 'ok', 'Россия', 'Москва') returning id").splitlines()[0]
        sql(f"""insert into catalog_proposals (run, bath_id, found_name, address, lat, lng, point_src, match, bin, place_status, kind_found, kind_why) values
              ('test', {spa_b}, 'Тестовые бани на деле', 'ул. Пара, 3', 55.712, 37.512, '2gis', 92, 'new', 'open', 'public', 'билет 800 ₽ на человека, общее мужское отделение')""")
        c_type = sql(f"select id from catalog_proposals where run = 'test' and bath_id = {spa_b}")
        none_b = sql("insert into baths (name, type, lat, lng, precision, status, country, region) values ('Тестовая баня без типа', null, 55.72, 37.52, 'city', 'ok', 'Россия', 'Москва') returning id").splitlines()[0]
        sql(f"""insert into catalog_proposals (run, bath_id, found_name, lat, lng, point_src, match, bin, place_status, kind_found, kind_why) values
              ('test', {none_b}, 'Тестовый фитнес', 55.721, 37.521, '2gis', 90, 'new', 'open', 'spa', 'фитнес-клуб, сауна по абонементу')""")
        c_spa = sql(f"select id from catalog_proposals where run = 'test' and bath_id = {none_b}")
        s = Site(browser, url, sess=vitek, name="commission-catalog")
        s.view("dir"); s.page.click('#dirMode [data-mode="catalog"]')
        s.page.wait_for_selector("#catList .radar-card", timeout=8000)
        check("есть похожие на общественные — Сверка открывается на «Тип»: «по факту — общественная», «Сделать общественной»",
              s.js(f"""() => document.querySelector('#catTabs [aria-pressed="true"]').dataset.tab === 'type'
                && /По факту — общественная: билет 800 ₽ на человека/.test(document.querySelector('#catList .radar-card[data-id="{c_type}"]')?.innerText || '')
                && !!document.querySelector('#catList .radar-card[data-id="{c_type}"] [data-cat="retype"].solid')"""))
        s.page.click(f'#catList .radar-card[data-id="{c_type}"] [data-cat="retype"]'); s.page.wait_for_timeout(1500)
        check("«Сделать общественной» — баня общественная, найденная точка точная",
              sql(f"select type || ' ' || precision from baths where id = {spa_b}") == "public exact")
        check("у бани без типа — и «Сделать хуитнесом», если агенты нашли хуитнес",
              s.js(f"() => /Сделать хуитнесом/.test(document.querySelector('#catList .radar-card[data-id=\"{c_spa}\"] [data-cat=\"retype\"]')?.innerText || '')"))
        s.page.click(f'#catList .radar-card[data-id="{c_spa}"] [data-cat="retype"]'); s.page.wait_for_timeout(1500)
        check("…нажал — тип бани «хуитнес»", sql(f"select type from baths where id = {none_b}") == "spa")
        s.page.click('#catTabs [data-tab="sure"]'); s.page.wait_for_timeout(300)
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
        # своя точка (20.10): Комиссия вставляет ссылку, адрес или координаты прямо в сверке — точка бани точная, предложение в «Решено»
        c_own = sql(f"select id from catalog_proposals where run = 'test' and bath_id = {own_b}")
        s.page.fill("#catQ", "Тестовая баня для своей"); s.page.wait_for_timeout(400)
        card = f'#catList .radar-card[data-id="{c_own}"]'
        s.page.click(f'{card} [data-cat="own"]'); s.page.fill(f'{card} form[data-own] input', "55.7612, 37.6201")
        s.page.click(f'{card} form[data-own] button[type="submit"]'); s.page.wait_for_timeout(2500)
        check("«своя точка» — ссылка или координаты прямо в сверке: точка бани точная, предложение — «поставили свою точку»",
              sql(f"select round(lat::numeric, 4) || ' ' || round(lng::numeric, 4) || ' ' || precision from baths where id = {own_b}") == "55.7612 37.6201 exact"
              and sql(f"select status || ' ' || reject_reason from catalog_proposals where id = {c_own}") == "rejected own_point",
              sql(f"select lat || ' ' || lng || ' ' || precision from baths where id = {own_b}"))
        lat0, lng0, prec0 = own_was.split(",")
        sql(f"update baths set lat = {lat0}, lng = {lng0}, precision = {prec0} where id = {own_b}")
        # принятое из сверки видно в карточке бани всем — «О бане»: часы, дни, цена, ссылки и откуда это (19.10)
        sql(f"update catalog_proposals set status = 'accepted' where id = {c_sure}")
        sql(f"delete from bath_schedule where bath_id = {cb_id}")   # часы от участника (выше, та же баня) показались бы вместо часов из сверки
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000)
        s.view("map"); s.page.fill("#q", "Василевские"); s.page.wait_for_timeout(300)
        s.page.click(f'#list .item[data-id="{cb_id}"]'); s.page.wait_for_selector("#dAbout:not([hidden])", timeout=8000)
        # 02.11 (макет карточки): часы — в главном блоке «Сегодня», удобства и дни — в «О бане», карты и сайт — кнопками
        check("карточка: принятое в сверке — на своих местах: адрес вместо региона, «Сегодня 8–22», дни без пояснений агента, плашки, карты и сайт",
              s.js("""() => { const i = document.getElementById('dInfo').innerText; return /ул. Пара, 2/.test(document.querySelector('#drawer .where').innerText)
                && document.getElementById('dTodayV').innerText === '8–22' && /мужские пн, ср/.test(i) && !/по 2ГИС/.test(i) && document.querySelectorAll('#dInfo .d-tags span').length === 2
                && [...document.querySelectorAll('#drawer .d-acts a')].filter((a) => !a.hidden).length === 4 && !document.getElementById('dSite').hidden
                && document.getElementById('dWeek').hidden; }"""))
        # 05.11: внизу «Пары и часы работы» — часы с сайта по дням и заметка, а не «Пока никто не указал»; «Позвонить» — первый номер
        check("карточка: «Пары и часы работы» — часы с сайта по дням и санитарный день, а не «Пока никто не указал»",
              s.js("() => { const t = document.getElementById('dSched').innerText; return /пн–вс/.test(t) && /8–22/.test(t) && /санитарный день/.test(t) && /по сайту бани/.test(t) && !/Пока никто не указал/.test(t); }"))
        check("карточка: «Позвонить» — первый номер, под кнопками — все номера",
              s.js("() => document.getElementById('dCall').getAttribute('href') === 'tel:+74951234567' && /\\+7 \\(495\\) 123-45-67/.test(document.getElementById('dPhone').innerText) && /\\+7 900/.test(document.getElementById('dPhone').innerText)"))
        check("часы из сверки есть — форма пар их не спрашивает", s.js("() => document.getElementById('shOpen').textContent === '+ Указать пары'"))
        s.page.click("#shOpen"); s.page.click("#shHoursEdit")
        check("…а «изменить часы работы» в форме открывает поля часов", s.js("() => !document.getElementById('shForm').hidden && !document.getElementById('shHours').hidden"))
        s.page.click("#dToday")
        check("…нажатие на «Сегодня» — расписание по дням", s.js("() => !document.getElementById('dWeek').hidden && /пн–вс 8–22/.test(document.getElementById('dWeek').innerText)"))
        check("цена с сайта — в «Цене»: только вход (кабины и аренду не показываем), первая крупно, остальное под «ещё»",
              s.js("""() => { const p = document.getElementById('dPriceSite'); return /1500 ₽/.test(p.querySelector('.ps-main b').innerText) && /ещё 1 вариант/.test(p.innerText)
                && /по сайту бани/.test(p.innerText) && !/Invalid/.test(document.getElementById('drawer').innerText) && !/кабина|22400/.test(p.innerHTML); }"""))
        check("на справочники (Zoon, Yell) ссылок в карточке нет", s.js("() => ![...document.querySelectorAll('#drawer a')].some((a) => /zoon|yell/.test(a.href))"))
        s.page.click("#drawer .x")
        s.view("dir"); s.page.click('#dirMode [data-mode="catalog"]'); s.page.wait_for_selector("#catList li", timeout=8000)   # вкладка могла опустеть
        s.page.fill("#catQ", "")
        s.no_clip("Сверка у Комиссии")
        s.clean("Сверка")
        s.close()
        # больше 1000 предложений (24.10: сайт видел 1000 из 1322 — предел PostgREST) — сайт читает страницами
        sql("insert into catalog_proposals (run, bath_id, match, place_status, status) select 'test', id, 50, 'unknown', 'accepted' "
            "from baths where id not in (select bath_id from catalog_proposals where run = 'test') order by id limit 1001")
        cat_total = sql("select count(*) from catalog_proposals")
        s = Site(browser, url, sess=vitek, mobile=True, name="commission-catalog-phone")
        s.view("dir"); s.page.click('#dirMode [data-mode="catalog"]')
        s.page.wait_for_selector("#catProgress span", timeout=8000)
        check("Сверка видит все предложения, а не первые 1000", s.js(f"() => / из {cat_total}$/.test(document.querySelector('#catProgress span').innerText)"),
              (cat_total, s.js("() => document.querySelector('#catProgress span').innerText")))
        s.page.click('#catTabs [data-tab="done"]'); s.page.wait_for_selector("#catList .radar-card", timeout=8000)   # тестовые уже решены
        s.no_clip("Сверка на телефоне")
        s.close()
        sql("delete from catalog_proposals where run = 'test'"); sql(f"delete from baths where id in ({spa_b}, {none_b})")
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

        print("Рейтинг бани: лёгкая страница оценки по личной ссылке из бота")
        # 01.11: бот шлёт ebl.su/rate.html?t=<ключ> — ключ входит сам, страница без карты, всё на одном экране без прокрутки
        def heat(s, k, n):   # ползунок-градусник: нажать в нужное деление, как пальцем
            box = s.page.locator(f'#rateBody [data-heat="{k}"]').bounding_box()
            s.page.mouse.click(box["x"] + 15 + (n - 1) / 4 * (box["width"] - 30), box["y"] + box["height"] / 2)
        rtb = sql("insert into baths (name, status, type, country, lat, lng, precision) values ('Тест-Рейтинг-Сайт', 'ok', 'public', 'Россия', 55.75, 37.6, 'exact') returning id").splitlines()[0]
        rtv = sql(f"insert into visits (bath_id, entered_at, duration_min, status, created_by) select {rtb}, '2026-11-01T18:00:00+03', 120, 'pending', id from players where nick = 'Шурик' returning id").splitlines()[0]
        sql(f"insert into visit_players (visit_id, player_id) select {rtv}, id from players where nick = 'Шурик'")
        sql(f"update visits set status = 'ok' where id = {rtv}")
        tok = sql(f"select token from rating_asks where visit_id = {rtv}")
        s = Site(browser, url + f"rate.html?v={rtv}", name="rate-noauth", mobile=True)
        s.page.wait_for_selector("#rateBody .rate-done", timeout=8000)
        check("без ключа и без входа — «открой ссылку из бота»", s.js("() => /ссылку «⭐ Оценить»/.test(document.getElementById('rateBody').innerText)"))
        s.close()
        s = Site(browser, url + f"rate.html?t={tok}", name="rate", mobile=True)
        s.ctx.set_default_timeout(10000)
        s.page.set_viewport_size({"width": 390, "height": 700})
        s.page.wait_for_selector("#rateBody [data-heat]", timeout=10000)
        check("личная ссылка: вошёл сам по ключу, восемь ползунков, «Оценить» выключена, ключ из адреса убран",
              s.js("() => document.querySelectorAll('#rateBody [data-heat]').length") == 8 and s.js("() => document.getElementById('rateSave').disabled")
              and "t=" not in s.js("() => location.search"))
        check("всё на одном экране телефона (390×700) — без прокрутки, кнопка видна",
              s.js("() => document.scrollingElement.scrollHeight <= innerHeight + 1 && document.getElementById('rateSave').getBoundingClientRect().bottom <= innerHeight"),
              s.js("() => [document.scrollingElement.scrollHeight, innerHeight]"))
        for k, n in (("stove", 5), ("steam", 5), ("aqua", 3), ("outdoor", 4), ("kitchen", 2), ("atmosphere", 5), ("service", 4), ("prices", 4)):
            heat(s, k, n)
        check("все восемь — на ручках цифры, слова, общая крупно (4) с листьями, «Оценить · 4» включилась",
              s.js("() => [...document.querySelectorAll('#rateBody .heat-knob')].map((x) => x.innerText).join('')") == "55342544"
              and s.js("() => document.querySelector('[data-line=\"stove\"] .rl-w').innerText") == "огонь"
              and s.js("() => document.getElementById('rScore').innerText") == "4" and s.js("() => !!document.querySelector('#rLeaves .fan')")
              and not s.js("() => document.getElementById('rateSave').disabled"))
        s.page.focus('#rateBody [data-heat="kitchen"]'); s.page.keyboard.press("ArrowRight")
        check("…стрелкой на клавиатуре — на деление выше", s.js("() => document.querySelector('[data-heat=\"kitchen\"] .heat-knob').innerText") == "3")
        s.page.keyboard.press("ArrowLeft")
        s.page.click("#rateSave"); s.page.wait_for_selector("#rateRv", timeout=8000)
        check("оценка в базе, дальше — цена, отзыв и фото по желанию", sql(f"select overall from bath_ratings where visit_id = {rtv}") == "4.00")
        check("экран после оценки на одном экране: цены входа и пива рядом, валюта по стране (₽), кнопка видна",
              s.js("() => !!document.getElementById('rateBeer') && document.getElementById('rateCur').value === 'RUB'"
                   " && document.querySelector('#rateRv button[type=submit]').getBoundingClientRect().bottom <= innerHeight"))
        s.page.fill("#ratePrice", "1 500"); s.page.fill("#rateBeer", "450")
        s.page.click("#rateMore"); s.page.click('#rateWeekend [data-w="0"]'); s.page.fill("#rateBefore", "14:00")
        s.page.fill("#rateText", "Пар отличный, кухня так себе")
        s.page.click("#rateRv button[type=submit]"); s.page.wait_for_selector("#rateBody .rate-done a", timeout=8000)
        pr = sql(f"select price || ' ' || currency || ' ' || coalesce(is_weekend::text, '-') || ' ' || coalesce(to_char(before_time, 'HH24:MI'), '-') from bath_prices where bath_id = {rtb}")
        check("…вход 1500 ₽ в будни со скидкой до 14:00, пиво 450 ₽ и отзыв сохранились, «Готово» со ссылкой на баню",
              pr == "1500 RUB false 14:00" and sql(f"select price || ' ' || currency from bath_beer_prices where bath_id = {rtb}") == "450 RUB"
              and sql(f"select count(*) from reviews where bath_id = {rtb}") == "1", pr)
        s.clean("страница оценки")
        s.close()
        s = Site(browser, url + f"#bath={rtb}", name="rate-card")
        s.page.wait_for_selector("#drawer:not([hidden])", timeout=8000); s.page.wait_for_timeout(800)
        check("в карточке бани — рейтинг: общая, одна оценка и восемь пунктов",
              s.js("() => /4.*1 оценка/s.test(document.getElementById('dRateTile').innerText) && document.querySelectorAll('#dRating > div').length === 8"))
        s.close()
        # 01.11: в карточке бани — «Ты тут был … · Оцени баню — 1 минута», если был и ещё не оценивал
        ib = sql("insert into baths (name, status, type, lat, lng, precision) values ('Тест-Приглашение', 'ok', 'public', 55.7, 37.6, 'exact') returning id").splitlines()[0]
        sql(f"insert into legacy_visits (bath_id, year, nick, n) values ({ib}, 2025, 'Шурик', 1)")
        s = Site(browser, url + f"#bath={ib}", sess=shurik, name="rate-invite")
        s.page.wait_for_selector("#dRateInvite .rate-invite", timeout=8000)
        check("в карточке бани, где был по таблице, — «Ты тут был в 2025 · Оцени баню — 1 минута»",
              s.js("() => document.querySelector('#dRateInvite').innerText.replace(/\\s+/g, ' ')") .startswith("Ты тут был в 2025 Оцени баню — 1 минута"),
              s.js("() => document.querySelector('#dRateInvite').innerText"))
        s.page.click("#dRateInvite .rate-invite"); s.page.wait_for_selector("#rateBody [data-heat]", timeout=8000)
        check("…ведёт на страницу оценки этой бани, в шапке — «был в 2025»", "rate.html?b=" in s.page.url and "был в 2025" in s.js("() => document.querySelector('.rate-head').textContent"))
        for k in ("stove", "steam", "aqua", "outdoor", "kitchen", "atmosphere", "service", "prices"):
            heat(s, k, 4)
        s.page.click("#rateSave"); s.page.wait_for_selector("#rateRv", timeout=8000)
        check("…оценка по бане сохранилась, фото без похода не предлагаем",
              sql(f"select overall from bath_ratings where bath_id = {ib} and visit_id is null") == "4.00" and not s.js("() => !!document.getElementById('ratePhotos')"))
        s.page.fill("#rateText", "Первая версия отзыва"); s.page.click("#rateRv button[type=submit]"); s.page.wait_for_selector("#rateBody .rate-done a", timeout=8000)
        rv_ib = lambda: sql(f"select count(*) || ':' || coalesce(max(text), '') from reviews where bath_id = {ib}")
        check("…отзыв с оценкой сохранился", rv_ib() == "1:Первая версия отзыва", rv_ib())
        s.page.goto(url + f"#bath={ib}"); s.page.wait_for_selector("#drawer:not([hidden])", timeout=8000); s.page.wait_for_timeout(1200)
        check("…после оценки приглашения в карточке нет", s.js("() => !document.querySelector('#dRateInvite .rate-invite')"))
        # 02.11: в ленте — своя запись с оценкой и текстом, кнопка «Изменить оценку и отзыв» — на страницу оценки
        s.page.wait_for_function("() => /Первая версия/.test(document.getElementById('dFeedback')?.innerText || '')", timeout=8000)
        check("…в ленте своя оценка с отзывом — первой, с «ты»; большой кнопки уже нет, правка — в «⋯»",
              s.js("() => !document.getElementById('rvGo') && !!document.querySelector('#dFeedback .review.mine .rv-me') && document.querySelector('#dFeedback .review').classList.contains('mine') && !!document.querySelector('#dFeedback .review .fan')"))
        s.page.click("#dFeedback .review.mine [data-rvmenu]"); s.page.click("#dFeedback .review.mine .rv-edit"); s.page.wait_for_selector("#rateBody [data-heat]", timeout=8000)
        for k in ("stove", "steam", "aqua", "outdoor", "kitchen", "atmosphere", "service", "prices"):
            heat(s, k, 5)
        s.page.click("#rateSave"); s.page.wait_for_selector("#rateRv", timeout=8000)
        s.page.wait_for_function("() => document.getElementById('rateText').value === 'Первая версия отзыва'", timeout=8000)
        check("…на странице оценки прежний отзыв уже в поле", True)
        s.page.fill("#rateText", "Вторая версия отзыва"); s.page.click("#rateRv button[type=submit]"); s.page.wait_for_selector("#rateBody .rate-done a", timeout=8000)
        check("…сохранение правит отзыв, а не пишет второй; оценка новая",
              rv_ib() == "1:Вторая версия отзыва" and sql(f"select overall from bath_ratings where bath_id = {ib} and visit_id is null") == "5.00", rv_ib())
        s.close()
        s = Site(browser, url + f"#bath={ib}", name="rate-invite-guest"); s.page.wait_for_selector("#drawer:not([hidden])", timeout=8000); s.page.wait_for_timeout(800)
        check("гостю приглашения нет", s.js("() => !document.querySelector('#dRateInvite .rate-invite')"))
        s.close()
        sql(f"delete from reviews where bath_id = {ib}"); sql(f"delete from baths where id = {ib}")
        # 01.11, баг Витька: поход 2026 года из таблицы (без отметки на портале) — тоже «Ты тут был в 2026»
        ib = sql("insert into baths (name, status, type, lat, lng, precision) values ('Тест-Приглашение-2026', 'ok', 'public', 55.7, 37.6, 'exact') returning id").splitlines()[0]
        sql(f"insert into legacy_visits (bath_id, year, nick, n) values ({ib}, 2026, 'Шурик', 1)")
        s = Site(browser, url + f"#bath={ib}", sess=shurik, name="rate-invite-2026")
        s.page.wait_for_selector("#dRateInvite .rate-invite", timeout=8000)
        check("в карточке бани, где был в 2026 по таблице, — «Ты тут был в 2026»",
              s.js("() => document.querySelector('#dRateInvite').innerText.replace(/\\s+/g, ' ')").startswith("Ты тут был в 2026"))
        s.close()
        sql(f"delete from baths where id = {ib}")
        s = Site(browser, url + f"#rate={rtv}", name="rate-old-link")
        s.page.wait_for_url("**/rate.html?v=*", timeout=8000)
        check("старая ссылка #rate=<поход> ведёт на лёгкую страницу оценки", "rate.html?v=" in s.page.url)
        s.close()
        sql(f"delete from reviews where bath_id = {rtb}"); sql(f"delete from bath_prices where bath_id = {rtb}"); sql(f"delete from bath_beer_prices where bath_id = {rtb}"); sql(f"delete from visits where id = {rtv}"); sql(f"delete from baths where id = {rtb}")

        print("Куда сходить за очками: «Я», «Не были в 2026», «Рядом»")
        s = Site(browser, url, sess=shurik, name="where-to-go")
        s.ctx.grant_permissions(["geolocation"]); s.ctx.set_geolocation({"latitude": 55.7558, "longitude": 37.6176})
        s.page.click("#fMe"); s.page.select_option("#fSeason", "never"); s.page.wait_for_timeout(500)
        check("«Я» выбирает себя одним нажатием", s.js("() => document.getElementById('fPlayer').value") == "Шурик")
        ids = s.js("() => [...document.querySelectorAll('#list .item')].slice(0, 25).map((x) => +x.dataset.id)")
        pots = s.js("() => [...document.querySelectorAll('#list .item .it-pot b')].slice(0, 25).map((x) => +x.textContent)")
        check("«Не были в 2026» у участника — очки за первый поход, выгодные сверху", len(pots) == len(ids) > 0 and min(pots) >= 2 and pots == sorted(pots, reverse=True), pots)
        been = sql(f"select count(*) from bath_counts where nick = 'Шурик' and year = 2026 and bath_id in ({','.join(map(str, ids))})")
        check("в этом списке нет бань, где он уже был в 2026", been == "0", been)
        # 03.11: сортировка — меню «по походам / по рейтингу / рядом со мной»
        s.page.click("#fNear"); s.page.click('#sortMenu [data-sort="rating"]'); s.page.wait_for_timeout(500)
        rates = s.js("() => [...document.querySelectorAll('#list .item .it-rate')].slice(0, 10).map((x) => +x.textContent.replace(',', '.'))")
        check("«по рейтингу» — справа оценка лиги, лучшие сверху", s.js("() => document.querySelector('#fNear span').textContent") == "по рейтингу" and rates == sorted(rates, reverse=True), rates)
        s.page.click("#fNear"); s.page.click('#sortMenu [data-sort="near"]'); s.page.wait_for_timeout(1200)
        check("сортировка «по походам» сменилась на «рядом»", s.js("() => document.querySelector('#fNear span').textContent") == "рядом")
        meters = s.js("""() => [...document.querySelectorAll('#list .item .it-meta')].slice(0, 12).map((m) => {
          const x = m.textContent.match(/~?([\\d\\s,]+)\\s(км|м)(?![а-я])/); if (!x) return null;
          const v = parseFloat(x[1].replace(/\\s/g, '').replace(',', '.')); return x[2] === 'км' ? v * 1000 : v; })""")
        check("«Рядом» — у бань расстояние, ближние сверху", s.js("() => document.getElementById('fNear').getAttribute('aria-pressed')") == "true"
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
        # 05.11: как «Карта» — без полосы шапки над картой, шторка тянется: полоска — свернуть до заголовка и обратно
        s.page.wait_for_timeout(400)
        check("«Хозяева» на телефоне: карта от самого верха, аватарка поверх неё (полосы шапки нет)",
              s.js("() => document.getElementById('ownmap').getBoundingClientRect().top <= 1 && getComputedStyle(document.querySelector('.top')).position === 'fixed'"))
        s.page.click("#ownGrab"); s.page.wait_for_timeout(500)
        peek = s.js("() => [document.getElementById('ownCard').dataset.state, document.querySelector('#ownCard h2').getBoundingClientRect().bottom <= document.querySelector('.nav').getBoundingClientRect().top]")
        swipe(s, 200, s.js("() => document.querySelector('#ownCard h2').getBoundingClientRect().top"), 250, steps=10, ms=300)
        check("…полоска сворачивает шторку до заголовка, потянул вверх — снова раскрылась", peek == ["peek", True] and s.js("() => document.getElementById('ownCard').dataset.state") != "peek", peek)
        s.page.click("#oList li[data-owner]")
        s.page.wait_for_timeout(200)
        s.nav_free("«Хозяева» на телефоне во время приближения")
        s.page.click('.nav [data-view="table"]', timeout=3000)
        check("…и меню переключает вкладку, не дожидаясь конца анимации", s.js("() => !document.getElementById('view-table').hidden"))
        s.page.click('.nav [data-view="map"]'); s.page.wait_for_timeout(300)
        check("…и обратно на карту", s.js("() => !document.getElementById('view-map').hidden && location.hash === '#map'"))
        # 02.11 (макет «карта и навигация»): на телефоне поиск и типы — поверх карты, веника-эмблемы нет; в меню — веник «+ Баня»
        check("телефон: поиск и типы поверх карты, эмблемы нет; чип «Никто не был» — только когда есть места Радара",
              s.js("() => !!document.querySelector('.map-bar .searchbox') && !!document.querySelector('.map-chips #fType') && getComputedStyle(document.querySelector('.brand')).display === 'none' && document.getElementById('fRadar').hidden"))
        check("телефон: в нижнем меню Карта, Таблица, Лента, Ещё — и веник «+ Баня» посередине",
              s.js("""() => { const vis = [...document.querySelectorAll('.nav button')].filter((b) => b.offsetParent).map((b) => b.dataset.view || b.id);
                const c = document.querySelector('#addVisitBtn .cta-venik').getBoundingClientRect();
                return vis.join() === 'map,table,feed,moreBtn' && Math.abs(c.left + c.width / 2 - innerWidth / 2) < 2; }"""))
        # 04.11: нажал тип — карта остаётся, где была (раньше отлетала на весь мир); масштаб — по адресам плиток
        zoom = "() => [...document.querySelectorAll('#map .leaflet-tile')].map((t) => +(t.src.match(/\\/(\\d+)\\/\\d+\\/\\d+/) || [])[1]).find((z) => z >= 0)"
        z0 = s.js(zoom)
        s.page.click('#fType [data-t="public"]'); s.page.wait_for_timeout(600)
        check("тип бани: карта не отдаляется, масштаб тот же", z0 is not None and s.js(zoom) == z0, (z0, s.js(zoom)))
        pub = s.js("() => [...document.querySelectorAll('#list .item .dot')].slice(0, 10).every((d) => d.classList.contains('t-public'))")
        s.page.click('#fType [data-t="public"]'); s.page.wait_for_timeout(300)
        check("типы без «Все»: нажал «Общественные» — только они, ещё раз — снова все",
              pub and s.js("() => !document.querySelector('#fType [aria-pressed=true]') && [...document.querySelectorAll('#list .item .dot')].some((d) => !d.classList.contains('t-public'))"))
        s.page.click("#filtBtn"); s.page.wait_for_selector("#filtModal:not([hidden])", timeout=3000)
        check("кнопка в поиске открывает шторку фильтров: сезон кнопками, страна, «Все» и участник",
              s.js("() => ['fSeasonSeg', 'fCountry', 'fPlayer', 'fWhoAll'].every((id) => document.getElementById(id).closest('#filtModal') && document.getElementById(id).offsetParent)"))
        s.no_clip("шторка фильтров на телефоне", "#filtModal .sheet")
        s.page.click('#fSeasonSeg [data-v="2026"]'); s.page.click("#filtShow")
        check("…выбрал «Были в 2026» — шторка закрылась, на кнопке фильтров «1»",
              s.js("() => document.getElementById('filtModal').hidden && document.getElementById('filtN').textContent === '1' && !document.getElementById('filtN').hidden"))
        s.page.click("#filtBtn"); s.page.click("#filtReset"); s.page.click("#filtShow")
        s.close()
        s = Site(browser, url, sess=vitek, mobile=True, name="mobile-commission")
        # «Лига не была» у Комиссии (02.11) с 05.11 — «Никто не был» у всех, проверки выше (radar-guest, radar-member)
        s.view("dir")
        check("Бани Комиссии на телефоне — через «Ещё», оно подсвечено", s.js("() => document.getElementById('moreBtn').getAttribute('aria-selected') === 'true'"))
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
        # 07.11 (отзыв из ОУД): с клавиатурой строка поиска бани уезжала под подсказки и за «Отправить» — не видно, что набираешь
        s.page.set_viewport_size({"width": 375, "height": 520})   # экран с открытой клавиатурой
        s.page.click("#addVisitBtn"); s.page.wait_for_function("() => !document.getElementById('visitModal').hidden", timeout=5000)
        s.page.fill("#vBathQ", "Ва"); s.page.wait_for_timeout(300)
        got = s.js("""() => { const r = (e) => document.querySelector(e).getBoundingClientRect(), i = r('#vBathBox'), g = r('#vSuggest'), f = r('.visit-side');
          return { above: i.bottom <= g.top, seen: i.top >= 0 && i.bottom <= f.top, first: document.querySelector('#vSuggest .sn')?.textContent || '' }; }""")
        check("форма похода с клавиатурой: строка поиска видна и над подсказками, первыми — бани с «Ва» в названии",
              got["above"] and got["seen"] and got["first"].lower().startswith("ва"), got)
        s.page.click("#visitModal [data-close]"); s.page.wait_for_timeout(300)
        s.page.set_viewport_size({"width": 375, "height": 812})
        # 18.10: профиль — быстрые действия вместо пустого окна
        s.page.click("#meBtn"); s.page.wait_for_timeout(300)
        check("профиль: мой сезон, мои бани на карте, мои походы в ленте", s.js("() => ['myProfile', 'myMap', 'myFeed', 'logoutBtn'].every((id) => !!document.getElementById(id))"))
        s.no_clip("профиль на телефоне", "#loginModal .sheet")
        # 03.11: своя аватарка — нажал на аватарку в профиле, выбрал фото; «вернуть из Telegram» — обратно
        was = sql("select coalesce(p.photo_url, '') || '|' || coalesce(a.tg_photo, '') || '|' || coalesce(a.tg_photo_src, '') from players p join player_accounts a on a.player_id = p.id where p.nick = 'Шурик' and a.tg_id is not null")
        check("профиль: аватарка — кнопка с камерой и ссылка «Сменить/Добавить фото»",
              s.js("() => !!document.querySelector('#loginBody .ava-edit .ava-cam') && /(Сменить|Добавить) фото/.test(document.querySelector('#loginBody .ava-links').innerText)"))
        s.page.set_input_files("#loginBody [data-ava-file]", files=[{"name": "me.png", "mimeType": "image/png", "buffer": TILE}])
        s.page.wait_for_function("() => (document.querySelector('#meBtn .ava img')?.src || '').includes('/avatars/own/')", timeout=15000)
        own = sql("select p.photo_url || '|' || a.tg_photo_src from players p join player_accounts a on a.player_id = p.id where p.nick = 'Шурик' and a.tg_id is not null")
        check("своё фото: в бакете avatars/own/<id>.jpg, у участника на сайте, бот его не перезапишет (src = own)",
              "/storage/v1/object/public/avatars/own/" in own and own.endswith("|own")
              and sql("select count(*) from storage.objects where bucket_id = 'avatars' and name like 'own/%'") != "0", own)
        check("…появилась ссылка «вернуть из Telegram»", s.js("() => !!document.querySelector('#loginBody [data-ava-reset]')"))
        s.page.click("#loginBody [data-ava-reset]")
        s.page.wait_for_function("() => !document.querySelector('#meBtn .ava img')", timeout=10000)
        # картинку сайт снимает сразу, а запись в базу доходит следом — ждём её, а не первый взгляд (04.11: мигало)
        cleared = lambda: sql("select coalesce(p.photo_url, '-') || '|' || coalesce(a.tg_photo_src, '-') from players p join player_accounts a on a.player_id = p.id where p.nick = 'Шурик' and a.tg_id is not null") == "-|-"
        for _ in range(30):
            if cleared(): break
            s.page.wait_for_timeout(200)
        check("«вернуть из Telegram» — своё фото снято, до входа — инициалы", cleared())
        photo, tgp, src = was.split("|")
        q = lambda v: f"'{v}'" if v else "null"
        sql(f"update player_accounts set tg_photo = {q(tgp)}, tg_photo_src = {q(src)} where player_id = (select id from players where nick = 'Шурик') and tg_id is not null")
        sql(f"update players set photo_url = {q(photo)} where nick = 'Шурик'")
        sql("delete from storage.objects where bucket_id = 'avatars' and name like 'own/%'")
        s.page.click("#myMap"); s.page.wait_for_timeout(500)
        check("…«Мои бани на карте» — карта с моими банями", s.js("() => !document.getElementById('view-map').hidden && document.getElementById('fPlayer').value === 'Шурик' && document.getElementById('loginModal').hidden"))
        s.js("() => { const f = document.getElementById('fPlayer'); f.value = ''; f.dispatchEvent(new Event('change')); }"); s.page.wait_for_timeout(300)
        # своя строка в таблице подсвечена (04.11, вместо карточки «Ты 4-й»)
        s.view("table"); s.page.wait_for_timeout(500)
        check("таблица на телефоне: своя строка подсвечена", s.js("() => document.querySelector('#standings tr.me')?.dataset.player === 'Шурик'"))
        s.view("map"); s.page.wait_for_timeout(300)
        s.page.click("#filtBtn"); s.page.click("#fMe"); s.page.click('#fSeasonSeg [data-v="never"]'); s.page.click("#filtShow"); s.page.wait_for_timeout(500)
        s.no_clip("телефон: «Я» + «Не были в 2026» с очками", "#view-map")
        s.page.click("#filtBtn"); s.page.click("#fWhoAll"); s.page.click('#fSeasonSeg [data-v="2026"]'); s.page.click("#filtShow"); s.page.wait_for_timeout(300)
        s.view("table"); s.js(open_shurik)
        s.no_clip("карточка участника с датами на телефоне", "#playerModal")
        s.js("() => (document.getElementById('playerModal').hidden = true)")
        s.page.click("#addVisitBtn")
        s.page.wait_for_timeout(350)
        check("телефон: по нажатию сначала веник хлещет, форма ещё не закрыла кнопку",
              s.js("() => document.getElementById('visitModal').hidden && document.getElementById('addVisitBtn').classList.contains('pour') && getComputedStyle(document.querySelector('#addVisitBtn .cta-venik')).display !== 'none'"))
        s.page.wait_for_selector("#visitModal:not([hidden])", timeout=3000)
        check("телефон: после анимации открылась форма", True)
        s.page.wait_for_timeout(400)   # шторка формы ещё въезжает снизу — меряем, когда встала
        s.no_clip("форма «Добавить баню» на телефоне", "#visitModal")
        check("телефон: форма помещается на экран без прокрутки (баня выбрана, без новой бани)",
              s.js("() => { const sh = document.querySelector('#visitModal .sheet'); return sh.scrollHeight <= sh.clientHeight + 1 || document.getElementById('newBathBox').hidden === false; }"),
              s.js("() => { const sh = document.querySelector('#visitModal .sheet'); return [sh.scrollHeight, sh.clientHeight]; }"))
        check("телефон: «Отправить» видна сразу, без прокрутки формы (прилипает к низу)",
              s.js("() => { const r = document.getElementById('vSubmit').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }"),
              s.js("() => [document.getElementById('vSubmit').getBoundingClientRect().toJSON(), innerHeight, scrollY]"))
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
        # 25.10: отметка «видел» — в аккаунте: другой браузер (своя память пуста, init ставит «вчера») тоже не показывает
        check("…отметка «видел» записана в аккаунт", bool(sql(f"select 1 from auth.users u join player_accounts pa on pa.auth_user = u.id where pa.player_id = '{player_id('Шурик')}' and (u.raw_user_meta_data->>'seen_decisions')::bigint > 0 limit 1")))
        s.page.evaluate("localStorage.removeItem('ebl.seenDecisions.Шурик')")
        s.page.reload(); s.page.wait_for_function("() => !document.getElementById('boot')", timeout=20000); s.page.wait_for_timeout(1500)
        check("…и в другом браузере того же человека уже не показывается", s.js("() => !/Комиссия (засчитала|решила)/.test(document.querySelector('.toast')?.innerText || '')"))
        s.close(); sql(f"delete from visits where id = {dv}")

        print("Радар для просмотра по секретной ссылке")
        # 01.11: все места Радара по категориям, без входа и без действий; ключ ссылки — только в radar_view_keys
        sql("delete from radar_places where key like 'view-test:%'"); sql("delete from radar_view_keys where key = 'view-test-key'")
        sql("""insert into radar_places (key, name, city, region, address, lat, lng, kind, public_index, status, note, price_example) values
          ('view-test:1', 'Тест-Радар Общественная', 'Москва', 'Москва', 'Люблинская улица, 60, Москва, Москва', 55.70, 37.60, 'public', 93, 'new', 'Муниципальная баня с оплатой за 1,5 часа', '1000 ₽ за 3 часа'),
          ('view-test:2', 'Тест-Радар Возможно', 'Москва', 'Москва', null, 55.71, 37.61, 'unknown', 40, 'new', null, null),
          ('view-test:3', 'Тест-Радар Аренда', 'Москва', 'Москва', null, 55.72, 37.62, 'private', 10, 'new', null, null),
          ('view-test:4', 'Тест-Радар Скрытая', 'Москва', 'Москва', null, 55.73, 37.63, 'public', 90, 'hidden', null, null),
          ('view-test:5', 'Тест-Радар Закрытая', 'Москва', 'Москва', null, 55.74, 37.64, 'closed', 50, 'new', null, null)""")
        pg = browser.new_page(); pg.route(EXTERNAL, lambda r: r.abort()); pg.route("**/config.js*", lambda r: r.fulfill(body=LIVE_CONFIG, content_type="application/javascript"))
        pg.goto(url + "radar.html#wrong-key"); pg.wait_for_function("() => document.getElementById('boot')?.classList.contains('err')", timeout=10000)
        check("с чужим ключом Радар не открывается: «Ссылка не подходит»", "Ссылка не подходит" in pg.inner_text("#boot"))
        check("…и база без ключа ничего не отдаёт", sql("select public.radar_view('wrong-key') is null") == "t")
        pg.close()
        sql("insert into radar_view_keys (key) values ('view-test-key')")
        s = Site(browser, url + "radar.html#view-test-key", mobile=True, name="radar-view")
        s.page.wait_for_selector("#pane .it", timeout=8000)
        names = s.js("() => [...document.querySelectorAll('#pane .it b')].map((b) => b.textContent)")
        check("в списке — общественная и «возможно», аренда спрятана по умолчанию, скрытых и закрытых нет",
              "Тест-Радар Общественная" in names and "Тест-Радар Возможно" in names
              and not any(n in names for n in ("Тест-Радар Аренда", "Тест-Радар Скрытая", "Тест-Радар Закрытая")), names)
        check("на странице нет кнопок действий (завести, в лигу, скрыть)",
              not s.js("() => /Завести|Скрыть|Привязать|В лигу/.test(document.body.innerText)"))
        s.page.click('.chip[data-cat="rent"]'); s.page.wait_for_timeout(300)
        check("чип «Аренда» показывает аренду", "Тест-Радар Аренда" in s.js("() => document.getElementById('pane').innerText"))
        s.page.fill("#q", "общественная тест"); s.page.wait_for_timeout(600)
        check("поиск находит по словам в любом порядке", s.js("() => [...document.querySelectorAll('#pane .it b')].map((b) => b.textContent)") == ["Тест-Радар Общественная"])
        s.page.click("#pane .it")
        card = s.js("() => document.querySelector('#pane .card')?.innerText || ''")
        check("карточка: сводка Радара, цена, адрес без повторов, ссылки на 2ГИС и Яндекс",
              "Муниципальная баня с оплатой за 1,5 часа" in card and "1000 ₽ за 3 часа" in card and "Москва, Москва" not in card
              and "2ГИС" in card and "Яндекс Карты" in card, card)
        s.page.click("#back")
        check("«← К списку» возвращает список", s.js("() => !!document.querySelector('#pane .it')"))
        # 02.11: нажатие на точку открывало карточку и тут же закрывало её — клик доходил до карты
        pt = s.js("() => { const m = window.radarMap; m.setView([55.70, 37.60], 15, { animate: false }); return m.latLngToContainerPoint([55.70, 37.60]); }")
        s.page.wait_for_timeout(300); s.page.mouse.click(pt["x"], pt["y"]); s.page.wait_for_timeout(400)
        check("нажатие на точку на карте открывает карточку бани", "Тест-Радар Общественная" in s.js("() => document.querySelector('#pane .card h2')?.textContent || ''"))
        s.close()
        # 02.11: что уже есть среди посещённых бань лиги с точной точкой — привязано к ней или ближе 150 м — не показываем
        vb = sql("insert into baths (name, status, type, country, lat, lng, precision) values ('Тест-Радар Наша', 'ok', 'public', 'Россия', 55.76, 37.65, 'exact') returning id").splitlines()[0]
        nb = sql("insert into baths (name, status, type, country, lat, lng, precision) values ('Тест-Радар Новая в лиге', 'ok', 'public', 'Россия', 55.78, 37.67, 'exact') returning id").splitlines()[0]
        sql(f"insert into legacy_visits (bath_id, year, nick, n) values ({vb}, 2025, 'Шурик', 1)")
        sql(f"""insert into radar_places (key, name, city, region, lat, lng, kind, public_index, status, bath_id) values
          ('view-test:6', 'Тест-Радар Рядом с нашей', 'Москва', 'Москва', 55.7605, 37.6505, 'public', 80, 'new', null),
          ('view-test:7', 'Тест-Радар Привязана', 'Москва', 'Москва', 55.77, 37.66, 'public', 80, 'matched', {vb}),
          ('view-test:8', 'Тест-Радар Заведена', 'Москва', 'Москва', 55.78, 37.67, 'public', 80, 'added', {nb})""")
        got = sql("select string_agg(e->>1, ',') from json_array_elements(public.radar_view('view-test-key')) e where e->>1 like 'Тест-Радар%'")
        check("Радар для просмотра: место ближе 150 м к посещённой бане и привязанное к ней — не показываем, заведённая без походов — в лиге",
              "Рядом с нашей" not in got and "Привязана" not in got and "Заведена" in got and "Общественная" in got, got)
        sql(f"delete from legacy_visits where bath_id = {vb}"); sql(f"delete from radar_places where key like 'view-test:%'"); sql(f"delete from baths where id in ({vb}, {nb})")
        sql("delete from radar_places where key like 'view-test:%'"); sql("delete from radar_view_keys where key = 'view-test-key'")

        print("Режим витрины (пустой config.js)")
        s = Site(browser, url, config=SHOWCASE_CONFIG, name="showcase")
        all_views(s, "витрина")
        s.close()
    finally:
        sql(f"delete from visits where source = 'site' and created_at > now() - interval '1 hour' and created_by = '{player_id('Шурик')}'")
        sql("delete from reviews where text like '%— проверка сайта'")
        sql(f"delete from bath_prices where bath_id = {bath}")
        sql(f"delete from bath_beer_prices where bath_id = {bath}")
        sql(f"delete from bath_schedule where bath_id = {bath}")
        sql(f"update baths set name = 'Василевские' where id = {bath} and name = 'проверка сайта'")
    browser.close()
    sql(f"update settings set value = '{cutover}' where key = 'cutover_week'")
    print("Готово.")
