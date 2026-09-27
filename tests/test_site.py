"""Сквозная проверка сайта в настоящем браузере: гость, участник, Комиссия, режим витрины, телефон.

Сайт (prototype/) открывается против локального стенда Supabase: config.js подменяется на локальный,
сессия участника подкладывается в localStorage — так же, как её хранит supabase-js после входа через Telegram.
Любая ошибка в консоли, упавший сценарий или вылезшая за экран вёрстка — провал.

Перед запуском: supabase start, supabase functions serve (см. AGENTS.md). Нужен Google Chrome.
Запуск: python3 tests/test_site.py        (скриншоты провалов — в tests/artifacts/)
"""
import functools, http.server, json, pathlib, threading, time
from playwright.sync_api import sync_playwright
from local import API, KEY, check, link, player_id, session, sql

ROOT = pathlib.Path(__file__).resolve().parent.parent
ART = ROOT / "tests" / "artifacts"
LIVE_CONFIG = f'window.EBL_CONFIG = {{ supabaseUrl: "{API}", supabaseKey: "{KEY}", telegramBot: "eblsu_bot", telegramBotId: 1 }};'
SHOWCASE_CONFIG = 'window.EBL_CONFIG = { supabaseUrl: "", supabaseKey: "", telegramBot: "" };'
# ключ, под которым supabase-js хранит сессию: sb-<первая часть адреса>-auth-token
AUTH_KEY = "sb-" + API.split("//")[1].split(".")[0].split(":")[0] + "-auth-token"
VIEWS = ["map", "heat", "table", "feed", "rules"]

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


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(ROOT / "prototype"))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/"


class Site:
    """Страница сайта с собранными ошибками консоли; config.js — локальный стенд или витрина."""

    def __init__(self, browser, url, *, config=LIVE_CONFIG, sess=None, mobile=False, name="site"):
        self.name = name
        self.ctx = browser.new_context(viewport={"width": 375, "height": 812} if mobile else {"width": 1280, "height": 860},
                                       is_mobile=mobile, has_touch=mobile)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("console", lambda m: m.type == "error" and not self._noise(m.text) and self.errors.append(m.text))
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.route("**/config.js*", lambda r: r.fulfill(body=config, content_type="application/javascript"))
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

    @staticmethod
    def _noise(text):
        # тайлы карт и шрифты из интернета могут не догрузиться — это не ошибка сайта
        return any(s in text for s in ("tile", "openstreetmap", "arcgisonline", "fonts.g", "ERR_INTERNET", "net::ERR"))

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

    def close(self):
        self.ctx.close()


def all_views(s, label, mobile=False):
    for v in VIEWS:
        s.view(v)
        if mobile:
            s.no_clip(f"{label}: «{v}» на телефоне", f"#view-{v}")
    s.view("table")
    s.page.click('#tMode [data-m="week"]')
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
        print("Гость")
        s = Site(browser, url, name="guest")
        check("сайт загрузился, кнопка «Войти» на месте", s.js("() => document.getElementById('meBtn').innerText.includes('Войти')"))
        all_views(s, "гость")
        s.page.click("#addVisitBtn")
        check("гость на «Добавить баню» — окно входа", s.js("() => !document.getElementById('loginModal').hidden"))
        s.close()

        print("Участник")
        s = Site(browser, url, sess=shurik, name="member")
        check("вошёл как Шурик — в шапке аватарка, лента открыта", s.js("() => document.getElementById('meBtn').getAttribute('aria-label') === 'Профиль: Шурик'"))
        all_views(s, "участник")
        s.view("feed")
        check("участнику видна лента походов", s.js("() => !!document.querySelector('#feedFilter button')"))
        # поход через форму: баня из справочника + попутчик
        s.page.click("#addVisitBtn")
        s.page.fill("#vBathQ", "Василевские")
        s.page.click(f'#vSuggest button[data-id="{bath}"]')
        s.page.press("#vDate", "Enter")
        check("Enter в поле не отправляет форму", s.js("() => !document.getElementById('visitModal').hidden"))
        s.page.click('#vDurChips button[data-m="180"]')
        s.page.click("#vComp button")
        s.page.wait_for_timeout(500)
        check("в талоне есть очки", s.js("() => /Итого\\s*\\+[1-9]/.test(document.getElementById('calc').innerText)"),
              s.js("() => document.getElementById('calc').innerText"))
        s.page.click("#vSubmit")
        s.page.wait_for_selector("#visitModal", state="hidden", timeout=10000)
        new = set(sql("select coalesce(string_agg(id::text, ','), '') from visits").split(",")) - {""} - before
        vid = max(map(int, new)) if new else None
        row = sql(f"select source || ' ' || status || ' ' || (select count(*) from visit_players where visit_id = {vid}) from visits where id = {vid}") if vid else ""
        check("поход сохранился: с сайта, на модерации, с попутчиком", row == "site pending 2", row)
        s.clean("участник после отправки похода")
        s.close()

        print("Комиссия")
        s = Site(browser, url, sess=vitek, name="commission")
        s.view("feed")
        s.page.click("label.switch")
        s.page.wait_for_timeout(400)
        check("Комиссия видит «Стол Комиссии» и кнопки решения", s.js(f"() => !!document.querySelector('[data-ok=\"{vid}\"]')"))
        s.page.click(f'[data-ok="{vid}"]')
        s.page.wait_for_timeout(1500)
        check("«Засчитать» с сайта: поход засчитан", sql(f"select status from visits where id = {vid}") == "ok")
        s.page.wait_for_timeout(4000)   # пересчёт пачкой и обновление без перезагрузки
        check("очки за поход посчитаны", int(sql(f"select count(*) from visit_points where visit_id = {vid}") or 0) >= 1)
        check("повторное решение по уже решённой заявке не проходит",
              s.js(f"async () => {{ try {{ await window.EBLData.moderate({vid}, 'rejected'); return false; }} catch (e) {{ return /уже решили/.test(e.message); }} }}"))
        s.clean("Комиссия")
        s.close()
        # второй поход в ту же баню в те же сутки: Комиссия должна видеть до решения, что очков не будет (п. 5)
        dup = sql(f"insert into visits (bath_id, entered_at, duration_min, created_by, source) select {bath}, now(), 120, id, 'site' from players where nick='Шурик' returning id").splitlines()[0]
        sql(f"insert into visit_players (visit_id, player_id) select {dup}, id from players where nick='Шурик'")
        s = Site(browser, url, sess=vitek, name="commission-repeat")
        s.view("feed"); s.page.click("label.switch"); s.page.wait_for_timeout(400)
        check("Комиссия видит пометку «похоже на повтор бани в те же сутки — проверь дату»",
              s.js(f"() => (document.querySelector('[data-ok=\"{dup}\"]')?.closest('.post')?.innerText || '').includes('повтор бани')"))
        s.clean("Комиссия: повтор")
        s.close()

        print("Даты в карточках")
        open_shurik = "() => [...document.querySelectorAll('#standings tbody tr')].find((tr) => tr.innerText.includes('Шурик')).click()"
        first_row = "() => document.querySelector('#playerBody .blist button')?.innerText || ''"
        s = Site(browser, url, sess=shurik, name="member-dates")
        s.view("table"); s.js(open_shurik)
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

        print("Телефон")
        s = Site(browser, url, mobile=True, name="mobile-guest")
        s.no_clip("гость: шапка на телефоне", ".top")
        all_views(s, "гость на телефоне", mobile=True)
        s.close()
        s = Site(browser, url, sess=shurik, mobile=True, name="mobile-member")
        check("участник на телефоне: аватарка видна (не белая точка)",
              s.js("() => { const a = document.querySelector('#meBtn .ava'); return !!a && a.getBoundingClientRect().width >= 24; }"))
        all_views(s, "участник на телефоне", mobile=True)
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
    browser.close()
    sql(f"update settings set value = '{cutover}' where key = 'cutover_week'")
    print("Готово.")
