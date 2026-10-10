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
VIEWS = ["map", "heat", "table", "feed", "rules"]
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

    def __init__(self, browser, url, *, config=LIVE_CONFIG, sess=None, mobile=False, name="site", route=None, noise=None):
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


def all_views(s, label, mobile=False):
    for v in VIEWS:
        s.view(v)
        if mobile:
            s.no_clip(f"{label}: «{v}» на телефоне", f"#view-{v}")
            s.nav_free(f"{label}: «{v}» на телефоне")
        elif v in ("map", "heat"):
            check(f"{label}: на «{v}» кнопки масштаба не лежат на карточке",
                  not s.js(ZOOM_OVER_JS, ["#map", "#view-map .panel"] if v == "map" else ["#heatmap", "#view-heat .heat-card"]))
    s.view("table")
    s.page.click('#tMode [data-m="week"]')
    s.page.wait_for_selector("#tWeek:not([hidden])", timeout=8000)
    check(f"{label}: недельный зачёт открылся", s.js("() => !document.getElementById('tWeek').hidden && document.querySelectorAll('#weekTable tbody tr').length > 0"))
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
        # и ушёл напрямую — а без VPN там режутся большие ответы, и сайт висел на заставке
        busy = ("**/rest/v1/settings?*", lambda r: r.fulfill(status=503, body='{"message":"upstream"}', headers={"Access-Control-Allow-Origin": "*"}))
        s = Site(browser, url, config=cfg2(API, dead), name="gateway-503", route=busy, noise="/rest/v1/settings")
        check("шлюз ответил 503 (Supabase за ним не ответил) — остаёмся на шлюзе, а не уходим напрямую",
              s.js("() => document.querySelectorAll('#list .item').length > 0"))
        s.close()

        print("Гость")
        s = Site(browser, url, name="guest")
        check("сайт загрузился, кнопка «Войти» на месте", s.js("() => document.getElementById('meBtn').innerText.includes('Войти')"))
        all_views(s, "гость")
        s.page.click("#addVisitBtn")
        check("гость на «Добавить баню» — окно входа", s.js("() => !document.getElementById('loginModal').hidden"))
        check("гостю вкладки «Бани» (справочник Комиссии) нет", s.js("() => document.querySelector('.nav [data-view=\"dir\"]').hidden"))
        s.close()

        print("Участник")
        s = Site(browser, url, sess=shurik, name="member")
        check("вошёл как Шурик — в шапке аватарка, лента открыта", s.js("() => document.getElementById('meBtn').getAttribute('aria-label') === 'Профиль: Шурик'"))
        all_views(s, "участник")
        s.view("feed")
        check("участнику видна лента походов", s.js("() => !!document.querySelector('#feedFilter button')"))
        check("участнику (не Комиссии) вкладки «Бани» нет", s.js("() => document.querySelector('.nav [data-view=\"dir\"]').hidden"))
        # поход через форму: баня из справочника + попутчик
        s.page.click("#addVisitBtn")
        check("участнику «Кто» не выбрать — поход только за себя", s.js("() => document.getElementById('vPlayer').disabled && document.getElementById('vPlayerHint').hidden"))
        s.page.fill("#vBathQ", "Василевские")
        s.page.click(f'#vSuggest button[data-id="{bath}"]')
        s.page.press("#vDate", "Enter")
        check("Enter в поле не отправляет форму", s.js("() => !document.getElementById('visitModal').hidden"))
        s.page.click('#vDurChips button[data-m="180"]')
        s.page.click("#vComp button")
        s.page.fill("#vPrice", "700"); s.page.fill("#vPrBeer", "280")
        s.page.set_input_files("#vPhotos", files=[{"name": "par.png", "mimeType": "image/png", "buffer": TILE}])
        s.page.wait_for_timeout(500)
        check("в талоне есть очки", s.js("() => /Итого\\s*\\+[1-9]/.test(document.getElementById('calc').innerText)"),
              s.js("() => document.getElementById('calc').innerText"))
        s.page.click("#vSubmit")
        s.page.wait_for_selector("#visitModal", state="hidden", timeout=10000)
        new = set(sql("select coalesce(string_agg(id::text, ','), '') from visits").split(",")) - {""} - before
        vid = max(map(int, new)) if new else None
        row = sql(f"select source || ' ' || status || ' ' || (select count(*) from visit_players where visit_id = {vid}) from visits where id = {vid}") if vid else ""
        check("поход сохранился: с сайта, на модерации, с попутчиком", row == "site pending 2", row)
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
        for t in ("Первый отзыв — проверка сайта", "Второй отзыв — проверка сайта"):
            s.page.fill("#rvText", t); s.page.click('#rvForm button[type="submit"]'); s.page.wait_for_timeout(900)
        my_reviews = f"select count(*) from reviews where bath_id = {bath} and player_id = '{player_id('Шурик')}' and text like '%— проверка сайта'"
        check("второй отзыв на ту же баню не затирает первый", sql(my_reviews) == "2", sql(my_reviews))
        s.page.click("#drawer [data-rvdel]"); s.page.wait_for_timeout(900)
        check("свой отзыв можно удалить", sql(my_reviews) == "1", sql(my_reviews))
        # цена: новая запись, повтор той же цены не дублирует, другая цена — новая строка (история, не перезапись)
        price_rows = f"select count(*) from bath_prices where bath_id = {bath}"
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
        s.page.click(f'[data-edit="{vid}"]'); s.page.wait_for_timeout(300)
        s.page.click('#eDur button[data-long="1"]')
        s.page.click('#editForm button[type="submit"]'); s.page.wait_for_timeout(1500)
        check("Комиссия правит засчитанный поход: «🔥 Долгая» — в базе больше 150 минут", int(sql(f"select duration_min from visits where id = {vid}")) > 150)
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
        s.clean("Комиссия")
        s.close()
        # второй поход в ту же баню в те же сутки: Комиссия должна видеть до решения, что очков не будет (п. 5)
        dup = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, source) select {bath}, now(), 120, id, 'site' from players where nick='Шурик' returning id").splitlines()[0]
        sql(f"insert into visit_players (visit_id, player_id) select {dup}, id from players where nick='Шурик'")
        s = Site(browser, url, sess=vitek, name="commission-repeat")
        s.view("feed")
        try: s.page.wait_for_selector(f'[data-ok="{dup}"]', timeout=8000)
        except Exception: pass
        check("Комиссия видит пометку «похоже на повтор бани в те же сутки — проверь дату»",
              s.js(f"() => (document.querySelector('[data-ok=\"{dup}\"]')?.closest('.post')?.innerText || '').includes('повтор бани')"))
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
        all_views(s, "гость на телефоне", mobile=True)
        # «Жар»: пока карта летит к бане из списка (анимация приближения, 0,8 с), меню не перекрыто и нажимается
        s.view("heat")
        s.page.click("#hTop li[data-id]")
        s.page.wait_for_timeout(200)
        s.nav_free("«Жар» на телефоне во время приближения")
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
        s.view("map"); s.page.wait_for_timeout(300)
        s.page.click("#fMe"); s.page.click('#fSeason [data-v="never"]'); s.page.wait_for_timeout(500)
        s.no_clip("телефон: «Я» + «Не были в 2026» с очками", "#view-map")
        s.page.click("#fMe"); s.page.click('#fSeason [data-v="2026"]'); s.page.wait_for_timeout(300)
        if s.js("() => !!document.querySelector('#race .race-toggle')"):
            s.page.click("#race .race-toggle"); s.page.wait_for_timeout(300)
            check("телефон: развёрнутая гонка недели не уходит под шторку (листается внутри)",
                  s.js("() => document.getElementById('race').getBoundingClientRect().bottom <= document.getElementById('map').getBoundingClientRect().bottom - 10"),
                  s.js("() => [document.getElementById('race').getBoundingClientRect().bottom, document.getElementById('map').getBoundingClientRect().bottom]"))
            s.page.click("#race .race-toggle")
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
        s.close()

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
