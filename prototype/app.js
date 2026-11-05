/* ЕБЛ — портал Евразийской банной лиги. Данные — через db.js: Supabase в боевом режиме,
   выгрузка таблицы Комиссии и localStorage в режиме витрины. */
(async function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => (Math.round(n * 10) / 10).toLocaleString("ru-RU");
  // дробные — всегда «очка»: 809,5 очка
  // склоняем то, что видно на экране: 20,97 показывается как «21» — значит «21 очко»
  const plural = (n, a, b, c) => { n = Math.round(Math.abs(+n) * 10) / 10; if (!Number.isInteger(n)) return b; const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
  const TYPE_LABEL = { public: "Общественная", spa: "Хуитнес", private: "Частная", unknown: "Тип не указан" };
  const PREC_SHORT = { auto: "точка автоматом, не проверена", city: "точка по городу", region: "точка по региону", country: "точка по стране" };   // фильтр Комиссии «Точка примерная»
  const PREC_LABEL = { auto: "нашёл геокодер по названию, не проверена", city: "по городу из названия", region: "по центру региона", country: "по центру страны" };
  const CUR_SIGN = { RUB: "₽", USD: "$", EUR: "€", JPY: "¥", AED: "د.إ" };
  const curSign = (c) => CUR_SIGN[c] || c;
  // цена — с центами, где они бывают (25.10: «12,50 €»): целые как есть, дробные — два знака; ввод — с запятой или точкой.
  // Рубли — только целые (решение Лехи 25.10): валюта не указана или RUB — округляем
  const money = (n) => (+n).toLocaleString("ru-RU", Number.isInteger(+n) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const priceIn = (v, cur) => {
    const n = +String(v ?? "").replace(/\s/g, "").replace(",", ".") || 0;
    return !cur || cur.toUpperCase() === "RUB" ? Math.round(n) : Math.round(n * 100) / 100;
  };
  // будни/выходной и «до HH:MM» у цены — оба поля необязательные, показываем только то, что указано
  const schedLabel = (p) => [p.is_weekend == null ? "" : p.is_weekend ? "вых" : "будни", p.before_time ? `до ${p.before_time.slice(0, 5)}` : ""].filter(Boolean).join(", ");
  const PLACE_PTS = [15, 12, 10, 8, 6, 4, 2, 1];
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- данные ----------
  const D = window.EBLData, store = D.store;
  const boot = (html) => { const el = $("#boot"); if (el) { el.innerHTML = html; el.classList.add("err"); } };
  if (D.broken) { boot("Не загрузилась связь с базой. Проверь интернет и обнови страницу."); return; }
  let data;
  // старая ссылка на оценку (#rate=<поход>, ?rate=<поход>) — на лёгкую страницу оценки, не загружая карту и лигу (01.11)
  const rateId = new URLSearchParams(location.search).get("rate") || location.hash.match(/^#rate=(\d+)$/)?.[1];
  if (rateId) { location.replace(`rate.html?v=${encodeURIComponent(rateId)}`); return; }
  // мини-приложение Telegram (02.11, кнопка «Отметить поход» в закрепе группы): Telegram кладёт в адрес подписанные данные
  // о том, кто нажал (#tgWebAppData=…), — входим без кода, а ?tgWebAppStartParam=visit после загрузки откроет форму похода.
  // Данные из адреса убираем сразу: в адресе им не место, а #… сайт читает как вкладку
  const tgHash = new URLSearchParams(location.hash.slice(1)), tgStart = new URLSearchParams(location.search).get("tgWebAppStartParam");
  if (tgHash.get("tgWebAppData")) {
    history.replaceState(history.state, "", location.pathname + "#map");
    // «готово» и «на весь экран» — события Telegram без его скрипта (в приложении — TelegramWebviewProxy, в вебе — окно-родитель)
    for (const eventType of ["web_app_ready", "web_app_expand"]) {
      try { window.TelegramWebviewProxy ? TelegramWebviewProxy.postEvent(eventType, "{}") : parent.postMessage(JSON.stringify({ eventType, eventData: {} }), "*"); } catch { /* не в Telegram */ }
    }
    try { await D.loginWebApp(tgHash.get("tgWebAppData")); } catch { /* не пустил — войдёт как обычно, форма попросит */ }
  }
  const loading = D.load();
  // ---------- шторка на телефоне (18.10, отзыв из чата: «карте мало места, сделайте как в Яндекс Картах») ----------
  // Карта — на весь экран, панель с поиском и списком — шторка снизу. Три остановки: «поиск» (peek — видно только поле
  // поиска), «половина» (half — при входе) и «весь список» (full — только в ней список листается внутри шторки).
  // Тянуть можно за всю шторку: быстрый взмах — на следующую остановку в его сторону, медленный — к ближайшей.
  // Полоска сверху: из половины — свернуть, из остальных — в половину.
  const phone = matchMedia("(max-width: 760px)");
  const sheet = $("#view-map .panel");
  let sheetState = "half";
  const viewH = () => $("#view-map").clientHeight || innerHeight;
  // свёрнутая — видно строку «N бань» под полоской (поиск с 02.11 — поверх карты, а не в шторке)
  const peekH = () => { const c = $(".countrow", sheet); return c && c.offsetHeight ? c.offsetTop + c.offsetHeight + 4 : 80; };
  function sheetY(state) {   // насколько шторка опущена от верхнего положения (оно — под поиском и типами поверх карты)
    const h = viewH() - sheet.offsetTop;
    return state === "full" ? 0 : state === "half" ? Math.round(h * 0.5) : Math.max(0, h - peekH());
  }
  // сколько карты снизу закрывает шторка — столько отступа, когда карта подбирает рамку
  const sheetCover = () => (phone.matches ? viewH() - sheet.offsetTop - sheetY(sheetState) : 0);
  function setSheet(state) {
    sheetState = state;
    sheet.dataset.state = state;
    if (!phone.matches) return sheet.style.removeProperty("--sheet-y");
    if (state !== "full") sheet.scrollTop = 0;
    sheet.style.setProperty("--sheet-y", `${sheetY(state)}px`);
  }
  setSheet("half");
  phone.addEventListener("change", () => setSheet(sheetState));
  addEventListener("resize", () => phone.matches && setSheet(sheetState));   // повернули телефон, спряталась строка адреса
  $("#sheetGrab").addEventListener("click", () => setSheet(sheetState === "half" ? "peek" : "half"));
  $("#q").addEventListener("focus", () => phone.matches && setSheet("full"));   // ищут — нужен весь список над клавиатурой
  let drag = null;
  sheet.addEventListener("touchstart", (e) => {
    if (!phone.matches || e.touches.length !== 1) return;
    const t = e.touches[0];
    drag = { x: t.clientX, y: t.clientY, base: sheetY(sheetState), dy: 0, on: false, track: [[e.timeStamp, 0]] };
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (!drag) return;
    const t = e.touches[0], dx = t.clientX - drag.x, dy = t.clientY - drag.y;
    if (!drag.on) {
      if (Math.abs(dx) > Math.abs(dy)) { drag = null; return; }   // вбок — листаются чипы, шторку не трогаем
      // во «весь список» список листается сам; шторку тянем только вниз и только от самого верха списка
      if (sheetState === "full" && (dy <= 0 || sheet.scrollTop > 0)) { drag = null; return; }
      drag.on = true;
      sheet.classList.add("dragging");
    }
    e.preventDefault();
    drag.dy = dy;
    drag.track.push([e.timeStamp, dy]); if (drag.track.length > 6) drag.track.shift();
    sheet.style.setProperty("--sheet-y", `${Math.min(sheetY("peek"), Math.max(0, drag.base + dy))}px`);
  }, { passive: false });
  function endDrag() {
    const d = drag; drag = null;
    if (!d?.on) return;
    sheet.classList.remove("dragging");
    const [t0, y0] = d.track[0], [t1, y1] = d.track[d.track.length - 1];
    const v = (y1 - y0) / Math.max(1, t1 - t0);   // px/мс за последние движения пальца
    const order = ["full", "half", "peek"], y = d.base + d.dy;
    let next = order.reduce((a, s) => (Math.abs(sheetY(s) - y) < Math.abs(sheetY(a) - y) ? s : a));
    if (Math.abs(v) > 0.4) next = order[Math.min(2, Math.max(0, order.indexOf(sheetState) + (v > 0 ? 1 : -1)))];
    setSheet(next);
  }
  sheet.addEventListener("touchend", endDrag);
  sheet.addEventListener("touchcancel", endDrag);
  // карта и подложка — сразу, пока идут данные: тайлы качаются параллельно, а не после заставки (16.10)
  const dark = () => document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  // сразу та же рамка, что покажет главная после данных (render «home»): иначе ранние тайлы — другого масштаба, их выбросят
  // при переходе и стартовые начнут качаться только после данных (16.10)
  // при старте — Европа и Россия до Урала, где почти все бани; дальние страны видно, если отдалить
  // рамка подобрана так, чтобы и на телефоне шириной 360 px влезла в зум 3, а не отскочила к целому миру
  const HOME = [[43, 3], [62, 60]];
  // на компьютере слева панель, на телефоне снизу шторка — рамку карты подбираем в видимой части
  // сверху справа на компьютере — гонка недели: рамку опускаем под неё (по ширине не ужимаем — иначе зум на шаг меньше)
  const raceH = () => { const r = $("#race"); return innerWidth > 980 && r && r.offsetHeight > 40 ? r.offsetTop + r.offsetHeight + 8 : 0; };
  const homePad = () => (phone.matches ? { paddingTopLeft: [0, $(".top").offsetHeight], paddingBottomRight: [0, sheetCover()] } : { paddingTopLeft: [380, raceH()] });
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).fitBounds(HOME, { ...homePad(), animate: false });
  map.attributionControl.setPrefix(false);
  const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const tileOpts = { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' };
  L.tileLayer(TILE_URL, tileOpts).addTo(map);
  const syncTheme = () => $$("#map .leaflet-tile-pane, #pickmap .leaflet-tile-pane, #radarmap .leaflet-tile-pane, #catmap .leaflet-tile-pane").forEach((p) => { p.classList.toggle("tiles-dark", dark()); p.classList.toggle("tiles-soft", !dark()); });
  syncTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  try { data = await loading; } catch (e) {
    boot(`Не получилось загрузить данные: ${esc(e.message)}. Обнови страницу.`);
    throw e;
  }
  // заставка уходит плавно; тестам и ошибкам — как раньше: элемента #boot больше нет
  { const b = $("#boot"); if (b) { b.classList.add("done"); setTimeout(() => b.remove(), calm ? 0 : 260); } }
  const me = data.me;                 // null — не вошёл или витрина; me.nick === null — вошёл, но ещё не привязан к участнику
  const member = !D.live || !!me?.nick;
  const canModerate = !D.live || !!me?.isCommission;
  let visits = data.visits;
  const reviews = data.reviews;
  const prices = data.prices;
  const beerPrices = data.beerPrices;
  const standings = data.standings;
  const players = data.players?.length ? data.players : standings.map((s) => s.name);
  const baths = data.baths;
  const updatedAt = D.live && standings[0]?.updatedAt ? new Date(standings[0].updatedAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" }) + " МСК" : null;
  const DATA_NOTE = updatedAt ? `обновлено ${updatedAt}` : "по таблице на 25 сентября";
  const byId = new Map(baths.map((b) => [b.id, b]));
  baths.forEach(hydrate);
  // все, кто хоть раз парился в 2023–2026 (ники из таблиц прошлых сезонов)
  const allPlayers = [...new Set([...players, ...baths.flatMap((b) => Object.values(b.histBy || {}).flatMap((y) => Object.keys(y)))])];
  const YEARS = [2023, 2024, 2025, 2026];
  // походы в баню за год ("all" — за 2023–2026), всей лиги или одного участника
  function countFor(b, year, player) {
    const one = (y) => y === 2026 ? (player ? b.v26?.[player] || 0 : b.n26) : (player ? b.histBy?.[y]?.[player] || 0 : b.hist?.[y] || 0);
    return year === "all" ? YEARS.reduce((a, y) => a + one(y), 0) : one(year);
  }

  // Сколько очков даст участнику первый поход в эту баню в 2026 (п. 9–14): поход, уникальная, общественная, ультра,
  // новый регион и страна. Компания и долгая зависят от похода, а не от бани, — их не считаем. null — уже был в 2026.
  function potentialFor(player) {
    const mine = baths.filter((b) => b.v26?.[player]);
    const regions = new Set(mine.filter((b) => b.region && b.country).map(placeKey));
    const countries = new Set(mine.map((b) => b.country).filter(Boolean));
    return (b) => {
      if (b.v26?.[player]) return null;
      const parts = ["поход", "уникальная"];
      if (b.t === "public") parts.push("общественная");
      if (!b.nAll) parts.push("ультра");
      if (b.region && b.country && !regions.has(placeKey(b))) parts.push("новый регион");
      if (b.country && !countries.has(b.country)) parts.push("новая страна");
      return parts;
    };
  }
  // последний год до 2026, когда участник был в бане («знакомая · 2024»)
  const knownSince = (b, player) => [2025, 2024, 2023].find((y) => b.histBy?.[y]?.[player]);
  // расстояние по дуге, км
  function distKm([la1, lo1], [la2, lo2]) {
    const r = Math.PI / 180, x = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(x));
  }
  const fmtKm = (k) => (k < 1 ? `${Math.round(k * 1000 / 50) * 50} м` : k < 10 ? `${k.toFixed(1).replace(".", ",")} км` : `${Math.round(k).toLocaleString("ru-RU")} км`);

  function hydrate(b) {
    b.t = b.type || "unknown";
    b.n26 = Object.values(b.v26 || {}).reduce((a, x) => a + x, 0);
    b.nHist = Object.values(b.hist || {}).reduce((a, x) => a + x, 0);
    b.nAll = b.n26 + b.nHist;
    b.search = [b.name, b.region, b.country].join(" ").toLowerCase();
    const c = b.lat != null ? [b.lat, b.lng, b.precision || "exact"] : null;
    if (c) {
      const [lat, lng, prec] = c;
      // примерные точки разносим детерминированно, чтобы бани одного города не слипались
      const spread = { exact: 0, auto: 0, city: 0.02, region: 0.25, country: 1.2 }[prec] ?? 0;   // auto — «среднеточно» (19.10): ставим как есть
      const a = (b.id * 2.399963) % (2 * Math.PI), r = spread * Math.sqrt(((b.id * 7919) % 97) / 97);
      b.ll = [lat + r * Math.sin(a), lng + r * Math.cos(a) * 1.6];
      b.prec = prec;
    }
  }

  // ---------- мелкие детали интерфейса ----------
  const hue = (s) => { let h = 7; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360; return h; };
  const initials = (s) => s.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();
  const commission = new Set(data.commission || []);
  const photos = data.photos || {};
  // фото из Telegram поверх инициалов; не загрузилось — остаются инициалы
  const ava = (name, cls = "") => {
    const kom = commission.has(name), photo = photos[name];
    return `<span class="ava ${cls}${kom ? " kom" : ""}" style="--h:${hue(name)}" ${kom ? `title="${esc(name)} — Комиссия ЕБЛ"` : 'aria-hidden="true"'}>${esc(initials(name))}`
      + (photo ? `<img src="${esc(photo)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "")
      + (kom ? '<svg class="seal" aria-hidden="true"><use href="#i-seal"/></svg>' : "") + "</span>";
  };
  const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;
  // значок типа бани — тот же силуэт, что на карте
  const tdot = (t) => `<i class="dot t-${t}">${TYPE_LABEL[t] && t !== "unknown" ? `<svg aria-hidden="true"><use href="#bt-${t}"/></svg>` : ""}</i>`;
  // веник-оценка (02.11): пять листьев веером из одной рукояти; тёмных — сколько полных баллов, следующий — посветлее
  const fanSvg = (v) => `<svg class="fan" viewBox="-15 -19 30 26" aria-hidden="true">${[-62, -31, 0, 31, 62].map((a, i) => ({ a, i }))
    .sort((x, y) => Math.abs(y.a) - Math.abs(x.a)).map(({ a, i }) => `<use href="#oak-leaf" class="${i < Math.floor(v + 0.25) ? "on" : i < Math.ceil(v) ? "half" : ""}" transform="rotate(${a}) scale(${i === 2 ? 1.1 : i % 2 ? 0.98 : 0.84})"/>`).join("")}<rect x="-1.6" y="-.5" width="3.2" height="7" rx="1.6"/></svg>`;
  const leafSvg = (on) => `<svg class="leaf ${on ? "on" : ""}" viewBox="-6 -17 12 18" aria-hidden="true"><use href="#oak-leaf"/></svg>`;
  const leaves = (n, cls = "") => `<span class="leaves ${cls}" title="${fmt(n)} из 5">${[1, 2, 3, 4, 5].map((i) => leafSvg(i <= Math.round(n))).join("")}</span>`;
  const where = (b) => [b.region, b.country].filter(Boolean).join(", ") || "регион не указан";
  const closedWhen = (b) => new Date(b.closed_on + "T12:00:00").toLocaleDateString("ru-RU", { month: "long", year: "numeric" }).replace(" г.", "");
  const markSvg = () => $(".brand .mark").outerHTML;

  // ---------- недели чемпионата (МСК) ----------
  // W1 = 1–4 января, дальше пн–вс; вс после 22:59 МСК уходит в следующую неделю
  function weekOf(localStr) {
    const d = new Date(localStr.slice(0, 10) + "T00:00:00Z");
    const [hh, mm] = localStr.slice(11, 16).split(":").map(Number);
    if (d.getUTCDay() === 0 && (hh > 22 || (hh === 22 && mm > 59))) d.setUTCDate(d.getUTCDate() + 1);
    const start2 = Date.UTC(2026, 0, 5);
    if (d < start2) return 1;
    return Math.floor((d - start2) / 864e5 / 7) + 2;
  }
  const mskDate = () => new Date(Date.now() + 3 * 3600e3); // UTC-поля = московское время
  const mskNow = () => mskDate().toISOString().slice(0, 16);
  const mskIso = (t) => new Date(new Date(t).getTime() + 3 * 3600e3).toISOString().slice(0, 16);   // момент → МСК 'YYYY-MM-DDTHH:MM'
  // день похода коротко: «сегодня», «вчера», «27 сент.» (s — МСК 'YYYY-MM-DDTHH:MM')
  // пары «каждый час / каждые два часа» с from до to включительно («22:00»–«02:00» — через полночь)
  function steamTimes(from, to, step) {
    const m = (t) => /^\d{2}:\d{2}/.test(t || "") ? +t.slice(0, 2) * 60 + +t.slice(3, 5) : null;
    let a = m(from), b = m(to); if (a == null || b == null || !step) return [];
    if (b < a) b += 1440;
    const out = [];
    for (let x = a; x <= b && out.length < 48; x += step) out.push(String(Math.floor(x / 60) % 24).padStart(2, "0") + ":" + String(x % 60).padStart(2, "0"));
    return out;
  }
  function dayLabel(s) {
    const day = s.slice(0, 10), today = mskNow().slice(0, 10);
    if (day === today) return "сегодня";
    if (day === new Date(Date.parse(today + "T00:00:00Z") - 864e5).toISOString().slice(0, 10)) return "вчера";
    return new Date(day + "T00:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" });
  }
  const curWeek = weekOf(mskNow());
  function timeLeft() {
    const now = mskDate(), end = new Date(now);
    end.setUTCDate(now.getUTCDate() + ((7 - now.getUTCDay()) % 7));
    end.setUTCHours(22, 59, 59, 0);
    if (end <= now) end.setUTCDate(end.getUTCDate() + 7);
    const ms = end - now, d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 36e5), m = Math.floor((ms % 36e5) / 6e4);
    return d ? `${d} д ${h} ч` : h ? `${h} ч ${m} мин` : `${m} мин`;
  }
  // очки за места с делёжкой (п. 7)
  function placePoints(rows) {
    const out = {};
    for (let i = 0; i < rows.length;) {
      let j = i; while (j + 1 < rows.length && rows[j + 1][1] === rows[i][1]) j++;
      const pts = rows.slice(i, j + 1).map((_, k) => PLACE_PTS[i + k] ?? 0);
      const avg = Math.round((pts.reduce((a, x) => a + x, 0) / pts.length) * 10) / 10;
      for (let k = i; k <= j; k++) out[rows[k][0]] = avg;
      i = j + 1;
    }
    return out;
  }
  $("#curWeek").textContent = "W" + curWeek;

  // ---------- вкладки ----------
  let radarMode = "dir";   // во вкладке «Бани» у Комиссии: справочник, радар или сверка (ниже, «Радар» и «Сверка»)
  // «Назад» в браузере (04.11, Android): раньше каждый переход только переписывал адрес — «Назад» уводил с сайта.
  // Теперь вкладка, карточка бани и окно — шаг в истории; «Назад» закрывает верхний открытый, а не уходит с ebl.su.
  // Закрыли крестиком — шаг остаётся «пустым», и «Назад» его просто проскакивает.
  const steps = [];   // steps[d] — что открыли на шаге d истории
  let depth = 0;
  const stepLive = (s) => s.type === "view" ? document.body.dataset.view === s.to
    : s.type === "bath" ? !$("#drawer").hidden : !$("#" + s.id).hidden;
  function pushStep(step) {
    steps.length = depth + 1; steps[++depth] = step;
    history.pushState({ ebl: depth }, "", location.hash);
  }
  addEventListener("popstate", (e) => {
    const to = e.state?.ebl ?? 0;
    if (to >= depth) { depth = to; return; }   // «Вперёд» — не открываем заново, только запоминаем шаг
    let closed = false;
    for (let d = depth; d > to; d--) {
      const s = steps[d]; if (!s || !stepLive(s)) continue;
      closed = true;
      if (s.type === "modal") $("#" + s.id).hidden = true;
      else if (s.type === "bath") closeBath();
      else show(s.from, true);
    }
    depth = to;
    if (!closed && to > 0) history.back();   // шаг уже закрыли крестиком — проскакиваем к следующему
  });
  function show(view, fromBack) {
    if (!fromBack && document.body.dataset.view !== view) pushStep({ type: "view", from: document.body.dataset.view, to: view });
    $$(".nav button[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    $("#moreBtn").setAttribute("aria-selected", String(["owners", "rules", "dir"].includes(view)));
    document.body.dataset.view = view;   // на телефоне поиск и типы поверх карты — только на вкладке «Карта»
    // телефон (03.11): на страницах аватарка — в строке заголовка раздела, а не отдельной полосой над ним
    const head = phone.matches && $(`#view-${view} .page-head`);
    if (head) head.append($("#meBtn")); else if ($("#meBtn").parentElement !== $(".top")) $(".top .map-chips").before($("#meBtn"));
    $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
    if (view === "map") setTimeout(() => map.invalidateSize(), 0);
    if (view === "owners") initOwners();
    if (view === "feed") renderFeed();
    if (view === "dir") renderDir();
    history.replaceState(history.state, "", "#" + (view === "dir" && radarMode !== "dir" ? radarMode : view));
  }
  $$(".nav button[data-view]").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
  document.body.dataset.view = "map";
  // «Ещё» (02.11): на телефоне в нижнем меню — Карта, Таблица, веник «+ Баня», Лента; остальное — здесь
  $("#moreBtn").addEventListener("click", () => {
    $('#moreModal [data-go="dir"]').hidden = $('.nav [data-view="dir"]').hidden;
    $("#moreModal").hidden = false;
  });
  $("#moreModal").addEventListener("click", (e) => {
    const b = e.target.closest("[data-go]"); if (!b) return;
    $("#moreModal").hidden = true; show(b.dataset.go);
  });
  // веник в шапке — на стартовый раздел с картой, откуда бы ни нажали
  $(".brand").addEventListener("click", (e) => { e.preventDefault(); show("map"); scrollTo({ top: 0, behavior: "smooth" }); });

  // ---------- карта ---------- (сама карта и подложка — в начале, до данных)
  const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 13, maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
  map.addLayer(cluster);
  const markers = new Map();

  // Выбранная баня — капля, как на обычных картах: кончик ровно в точке бани, внутри — силуэт типа (16.10).
  // Раньше выбранный кружок получал класс «sel» — тот же, что у выпадающих списков: с их отступами он расплющивался в овал
  // и терял силуэт. Капля — и у точки в форме похода: её ставят кончиком.
  const glyphOf = (t) => t && t !== "unknown" ? `<svg aria-hidden="true"><use href="#bt-${t}"/></svg>` : '<i class="pin-dot"></i>';
  const dropIcon = (color, inner) => L.divIcon({
    className: "", iconSize: [40, 52], iconAnchor: [20, 50],
    html: `<div class="pin-drop" style="--c:${color}"><svg class="pin-drop-bg" viewBox="0 0 34 44" aria-hidden="true"><path d="M17 42.5C17 42.5 3 27.6 3 16.5a14 14 0 0 1 28 0C31 27.6 17 42.5 17 42.5Z"/></svg>${inner}</div>`,
  });
  function pinIcon(b) {
    if (b.id === openId) return dropIcon(`var(--t-${b.t})`, glyphOf(b.t));
    // размер — по походам в 2026, силуэт внутри — тип бани
    const size = b.n26 ? Math.round(Math.min(23 + Math.sqrt(b.n26) * 2.2, 34)) : 21;
    const glyph = glyphOf(b.t);
    return L.divIcon({
      className: "", iconSize: [size, size],
      html: `<div class="pin ${b.prec !== "exact" ? "approx" : ""} ${b.n26 >= 15 ? "hot" : ""} ${b.closed_on ? "closed" : ""}" style="width:${size}px;height:${size}px;--c:var(--t-${b.t})">${glyph}${b._pot?.length >= 3 ? `<span class="pot">+${b._pot.length}</span>` : ""}</div>`,
    });
  }
  function markerFor(b) {
    const m = L.marker(b.ll, { icon: pinIcon(b), title: b.name, riseOnHover: true, zIndexOffset: b.id === openId ? 1000 : 0 }).on("click", () => openBath(b.id));
    markers.set(b.id, m);
    return m;
  }

  // ---------- шапка панели ----------
  function renderKpis() {
    const totalVisits = standings.reduce((a, s) => a + s.baths, 0);
    const visited26 = baths.filter((b) => b.n26);
    const countries26 = new Set(visited26.map((b) => b.country).filter(Boolean));
    $("#kpis").innerHTML = [
      [totalVisits, plural(totalVisits, "поход", "похода", "походов")],
      [visited26.length, plural(visited26.length, "баня", "бани", "бань")],
      [countries26.size, plural(countries26.size, "страна", "страны", "стран")],
    ].map(([n, l]) => `<div><b>${n.toLocaleString("ru-RU")}</b><span>${l} в 2026</span></div>`).join("");
  }
  renderKpis();

  // ---------- фильтры ----------
  const countries = [...new Set(baths.map((b) => b.country).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
  $("#fCountry").innerHTML += countries.map((c) => `<option>${esc(c)}</option>`).join("");
  $("#countryList").innerHTML = countries.map((c) => `<option value="${esc(c)}">`).join("");
  $("#regionList").innerHTML = [...new Set(baths.map((b) => b.region).filter(Boolean))].map((c) => `<option value="${esc(c)}">`).join("");
  $("#fPlayer").innerHTML += [...allPlayers].sort((a, b) => a.localeCompare(b, "ru")).map((p) => `<option>${esc(p)}</option>`).join("");
  const single = (group) => group.addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("button", group).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render(true);
  });
  // типы (02.11): без «Все» — нажал выбранный ещё раз, снова все типы
  $("#fType").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]"); if (!b) return;
    const on = b.getAttribute("aria-pressed") !== "true";
    $$("#fType button[data-t]").forEach((x) => x.setAttribute("aria-pressed", String(on && x === b)));
    render("soft");   // 04.11: карта отлетала на весь мир — теперь остаётся, где была, если в кадре такие бани есть
  });
  // разрезы по годам с главного экрана убрали (02.11, Леха: фильтры перегружены) — сезон теперь в «Фильтрах» рядом со страной
  $("#fSeason").addEventListener("change", () => render(true));
  // в шторке на телефоне сезон — тремя кнопками, «Все» — все участники; меняют те же списки
  $("#fSeasonSeg").addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (!b) return; $("#fSeason").value = b.dataset.v; render(true); });
  $("#fWhoAll").addEventListener("click", () => { $("#fPlayer").value = ""; render(true); });
  // телефон: поиск и типы — поверх карты, остальные фильтры — шторкой по кнопке в поиске; компьютер — всё в панели
  const fBox = $(".filters"), sBox = $(".searchbox", fBox), tBox = $("#fType"), mBox = $("#filtMore");
  function placeFilters() {
    if (phone.matches) { $(".map-bar").append(sBox); $(".map-chips").append(tBox); $("#filtModal .sheet").append(mBox); }
    else { fBox.prepend(sBox, tBox); fBox.append(mBox); $("#filtModal").hidden = true; }
    setSheet(sheetState);
  }
  placeFilters();
  phone.addEventListener("change", placeFilters);
  $("#filtBtn").addEventListener("click", (e) => { e.preventDefault(); $("#filtModal").hidden = false; });
  $("#filtReset").addEventListener("click", () => {
    $("#fSeason").value = "all"; $("#fCountry").value = ""; $("#fPlayer").value = ""; $("#fPrec").value = ""; render(true);
  });
  $("#q").addEventListener("input", () => render());
  $("#fCountry").addEventListener("change", () => render(true));
  $("#fPlayer").addEventListener("change", () => render(true));
  // Комиссии (18.10): бани без точки и с примерной — пройтись и поправить. Сразу «Все бани»: проверяем бани всех лет,
  // а не только те, где были в 2026; поправил точку в карточке — баня уходит из списка. Карту не отдаляем: таких бань сотни
  // по всему миру — удобнее остаться в своём городе и идти по списку
  $("#fPrecGrp").hidden = !(canModerate && D.live);
  $("#fPrec").addEventListener("change", () => {
    if ($("#fPrec").value) $("#fSeason").value = "all";
    render();
  });
  // «Я» — выбрать себя одним нажатием (повторное — снова вся лига)
  const myNick = D.live ? me?.nick : null;
  $("#fMe").hidden = !myNick;
  $("#fMe").addEventListener("click", () => { $("#fPlayer").value = $("#fPlayer").value === myNick ? "" : myNick; render(true); });
  // сортировка (03.11): по походам, по рейтингу лиги или рядом — меню у «по походам ▾». «Рядом» — по расстоянию:
  // геопозицию спрашиваем только по нажатию, никуда её не отправляем
  let here = null, hereMarker = null, sortBy = "visits";
  const sortMenu = $("#sortMenu");
  const closeSort = () => { sortMenu.hidden = true; $("#fNear").setAttribute("aria-expanded", "false"); };
  $("#fNear").addEventListener("click", (e) => { e.stopPropagation(); sortMenu.hidden = !sortMenu.hidden; $("#fNear").setAttribute("aria-expanded", String(!sortMenu.hidden)); });
  document.addEventListener("click", (e) => { if (!sortMenu.hidden && !e.target.closest("#sortMenu")) closeSort(); });
  sortMenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-sort]"); if (!b) return;
    closeSort();
    if (b.dataset.sort === "near") return askNear();
    sortBy = b.dataset.sort; here = null; hereMarker?.remove(); hereMarker = null; render();
  });
  function askNear() {
    if (!navigator.geolocation) { toast("Браузер не отдаёт геопозицию"); return; }
    $("#fNear").disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      $("#fNear").disabled = false;
      here = [pos.coords.latitude, pos.coords.longitude];
      hereMarker = L.marker(here, { icon: L.divIcon({ className: "", iconSize: [18, 18], html: '<div class="here" title="Ты здесь"></div>' }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      render(true);
    }, () => { $("#fNear").disabled = false; toast("Нет доступа к геопозиции — разреши его сайту в настройках браузера"); },
    { timeout: 10000, maximumAge: 300000 });
  }

  // Радар на карте всем (05.11, Леха): места, где лига ещё не была, с индексом общественности 70+ — бледными кольцами
  // поверх обычных бань; чип «Никто не был» оставляет только их. Первый поход туда — ультрауникальная (+1). Нажал — карточка
  // места; «Отметить поход» превращает место в баню лиги (radar_to_bath) и открывает обычную форму похода
  const unseenLayer = L.layerGroup().addTo(map), ringR = L.canvas({ padding: 0.3 });
  let radarPub = null, onlyNew = false;
  const idxCat = (v) => (v >= 90 ? "точно общественная" : v >= 70 ? "скорее общественная" : "под вопросом");
  if (D.live) D.radarPublic().then((r) => {
    radarPub = r; if (!r?.places.length) return;
    $("#fRadar").hidden = false; $("#fRadar small").textContent = r.places.length.toLocaleString("ru-RU");
    render(); if (openId) syncIndex(openId);
  }).catch(() => {});   // не загрузилось — карта как раньше, без колец
  $("#fRadar").addEventListener("click", () => {
    onlyNew = !onlyNew; $("#fRadar").setAttribute("aria-pressed", String(onlyNew));
    if (onlyNew) $$("#fType button[data-t]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    render(true);
  });
  // места, которые подходят под фильтры: их нет у участника, в прошлых сезонах и среди «Хуитнесов» и «Частных»
  function radarShown(type, q) {
    if (!radarPub) return [];
    const season = $("#fSeason").value, country = $("#fCountry").value;
    if ((type && type !== "public") || $("#fPlayer").value || $("#fPrec").value || !["all", "never"].includes(season) || (country && country !== "Россия")) return [];
    return radarPub.places.filter((p) => !q || `${p.name} ${p.city || ""} ${p.region || ""}`.toLowerCase().includes(q));
  }
  function drawUnseen(list) {
    unseenLayer.clearLayers();
    const ring = getComputedStyle(document.documentElement).getPropertyValue("--uu").trim() || "#7a5bd6";
    for (const p of list) {
      L.circleMarker([p.lat, p.lng], { renderer: ringR, radius: onlyNew ? 6 : 4.5, weight: 2, color: ring, opacity: onlyNew ? 1 : 0.75, fillColor: "#fff", fillOpacity: 1 })
        .on("click", () => openRadar(p.id)).addTo(unseenLayer);
    }
    return list.length;
  }

  function render(fit) {
    const q = $("#q").value.trim().toLowerCase();
    const type = $("#fType button[data-t][aria-pressed=true]")?.dataset.t || "", season = $("#fSeason").value;
    const country = $("#fCountry").value, player = $("#fPlayer").value, prec = $("#fPrec").value;
    const past = /^20(23|24|25)$/.test(season) ? +season : 0;   // 05.11: бани прошлого сезона — из профиля участника («2025 на карте»)
    const metric = past ? (b) => countFor(b, past, player || undefined) : season === "2026" ? (b) => (player ? b.v26?.[player] || 0 : b.n26) : (b) => (player ? countFor(b, "all", player) : b.nAll);
    // выбран участник — «были / не были в 2026» считаются про него, а не про всю лигу:
    // «Не были в 2026» — все бани, где он в этом сезоне ещё не был, со счётом, сколько очков даст первый поход
    const inSeason = (b) => past ? metric(b) > 0 : season === "all" ? !player || metric(b) > 0
      : season === "2026" ? (player ? metric(b) > 0 : b.n26 > 0 || b.isNew)
      : player ? !(b.v26?.[player] > 0) : b.n26 === 0;
    const pot = player && season === "never" ? potentialFor(player) : null;
    const precOk = (b) => !prec || (prec === "none" ? !b.ll : prec === "auto" ? b.prec === "auto" : !!b.ll && b.prec !== "exact");
    const current = onlyNew ? [] : baths.filter((b) => (!type || b.t === type) && (!country || b.country === country) && (!q || b.search.includes(q)) && inSeason(b) && precOk(b));
    const fresh = radarShown(type, q);
    current.forEach((b) => {
      b._m = metric(b); b._pot = pot ? pot(b) : null;
      b._km = here && b.lat != null && b.prec !== "country" ? distKm(here, [b.lat, b.lng]) : null;   // точка «по центру страны» — не расстояние
    });
    const rateOfB = (b) => +(ratings[b.id]?.overall || 0);
    if (here) current.sort((a, b) => (a._km ?? 1e9) - (b._km ?? 1e9));
    else if (sortBy === "rating") current.sort((a, b) => rateOfB(b) - rateOfB(a) || (ratings[b.id]?.n || 0) - (ratings[a.id]?.n || 0) || b._m - a._m);
    else if (pot) current.sort((a, b) => b._pot.length - a._pot.length || b.n26 - a.n26 || a.name.localeCompare(b.name, "ru"));
    else current.sort((a, b) => b._m - a._m || a.name.localeCompare(b.name, "ru"));
    $("#fMe").setAttribute("aria-pressed", String(!!myNick && player === myNick));
    $("#fWhoAll").setAttribute("aria-pressed", String(!player));
    $$("#fSeasonSeg [data-v]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === season)));
    $("#fPlayer").classList.toggle("on", !!player && player !== myNick);
    $("#fNear").setAttribute("aria-pressed", String(!!here || sortBy !== "visits"));
    $("#fNear span").textContent = here ? "рядом" : sortBy === "rating" ? "по рейтингу" : pot ? "по очкам" : "по походам";
    const sortNow = here ? "near" : sortBy;
    $$("#sortMenu [data-sort]").forEach((x) => x.setAttribute("aria-checked", String(x.dataset.sort === sortNow)));
    // сколько фильтров включено в шторке — числом на кнопке в поиске
    const nf = [season !== "all", country, player, prec].filter(Boolean).length;
    $("#filtN").hidden = !nf; $("#filtN").textContent = nf;
    $("#filtShow").textContent = `Показать ${current.length.toLocaleString("ru-RU")}`;
    cluster.clearLayers(); markers.clear();
    const onMap = current.filter((b) => b.ll);
    cluster.addLayers(onMap.map(markerFor));
    const unseen = fresh.length ? drawUnseen(fresh) : (drawUnseen([]), null);
    const noPin = current.length - onMap.length;
    const rich = pot ? current.filter((b) => b._pot.length >= 3).length : 0;
    // «1 144 бани» крупно, под ним — сколько из них в 2026 и где был ты (02.11, макет)
    const in26 = current.filter((b) => b.n26 > 0).length, mine = myNick && !player ? current.filter((b) => countFor(b, "all", myNick) > 0).length : 0;
    const sub = pot ? `${player}: новые в 2026${rich ? ` · +3 и больше — ${rich}` : ""}`
      : [season === "all" ? `${in26.toLocaleString("ru-RU")} в 2026` : season === "2026" ? "походы в 2026" : past ? `походы в ${past}` : "никто не был в 2026",
        mine && `ты был в ${mine}`, player && `${player} был${season === "2026" || past ? ` в ${past || 2026}` : ""}`,
        unseen != null && !onlyNew && `+ ${unseen.toLocaleString("ru-RU")}, где лига не была`,
        prec === "rough" ? "точка примерная" : prec === "auto" ? "среднеточные" : prec === "none" ? "без точки" : noPin ? `${noPin} без точки` : ""].filter(Boolean).join(" · ");
    $("#count").innerHTML = `<b>${current.length.toLocaleString("ru-RU")} ${plural(current.length, "баня", "бани", "бань")}</b><span>${esc(sub)}</span>`;
    if (onlyNew) {   // «Никто не был»: список и счёт — места Радара, по индексу
      $("#potNote").hidden = true;
      $("#count").innerHTML = `<b>${fresh.length.toLocaleString("ru-RU")} ${plural(fresh.length, "баня", "бани", "бань")}</b><span>никто из лиги не был · первый поход — ультрауникальная</span>`;
      $("#filtShow").textContent = `Показать ${fresh.length.toLocaleString("ru-RU")}`;
      $("#list").innerHTML = fresh.length ? fresh.slice(0, 250).map((p) => `<button class="item" data-radar-id="${p.id}"><i class="dot uu-dot"><span></span></i>
        <span><span class="it-name">${esc(p.name)}</span><span class="it-meta">${esc([p.city || p.region, idxCat(p.index)].filter(Boolean).join(" · "))}</span></span>
        <span class="it-heat"><b class="it-idx">${p.index}</b><small>индекс</small></span></button>`).join("") + (fresh.length > 250 ? `<div class="more">и ещё ${fresh.length - 250} — уточни поиск</div>` : "")
        : `<div class="more">Ничего не нашлось. Попробуй другое слово или сбрось фильтры.</div>`;
      if (fit && fresh.length) map.fitBounds(L.latLngBounds(fresh.map((p) => [p.lat, p.lng])).pad(0.1), { maxZoom: 12, ...homePad() });
      return;
    }
    // подсказка, что значат цифры, — только там, где без неё непонятно
    const note = $("#potNote");
    let seen = false; try { seen = localStorage.getItem("ebl.potNote") === "1"; } catch { /* приватный режим — просто покажем */ }
    note.hidden = season !== "never" || (!!pot && seen);
    note.innerHTML = (pot
      ? "Цифра справа — очки за первый поход: +1 поход, +1 уникальная, ещё по +1 за общественную, ультру, новый регион и страну. Компания и долгая — сверху."
      : `Здесь бани, где в 2026 не был никто из лиги. Выбери участника${myNick ? " или нажми «Я»" : ""} — покажу новые для него бани и сколько очков даст каждая.`)
      + (pot ? '<button type="button" class="x-note" aria-label="Понятно, скрыть">✕</button>' : "");
    const LIMIT = 250;
    // выбран участник — рядом с регионом дата его последнего похода с портала (журнал видят только участники)
    const jrP = player && !(D.live && !member) ? journalOf(player) : null;
    $("#list").innerHTML = current.length ? current.slice(0, LIMIT).map((b) => {
      const n = b._m, last = jrP?.get(b.id)?.last, known = pot ? knownSince(b, player) : null;
      const meta = [where(b), last && dayLabel(last), b._km != null && `${b.prec !== "exact" ? "~" : ""}${fmtKm(b._km)}`, known && `знакомая · ${known}`,
        (prec === "rough" || prec === "auto") && PREC_SHORT[b.prec]].filter(Boolean).join(" · ");
      return `<button class="item ${b.id === openId ? "active" : ""}" data-id="${b.id}">
        ${tdot(b.t)}
        <span><span class="it-name">${esc(b.name)}</span><span class="it-meta">${esc(meta)}</span></span>
        ${b._pot ? `<span class="it-pot" title="${esc(b._pot.join(" · "))}"><b>+${b._pot.length}</b><small>${plural(b._pot.length, "очко", "очка", "очков")}</small></span>`
          : sortBy === "rating" && !here ? `<span class="it-heat">${ratings[b.id] ? `<b class="it-rate">${fmt(+ratings[b.id].overall)}</b><small>${ratings[b.id].n} ${plural(ratings[b.id].n, "оценка", "оценки", "оценок")}</small>` : '<small>нет оценок</small>'}</span>`
          : `<span class="it-heat">${n ? `<b>${n}</b><small>${plural(n, "поход", "похода", "походов")}</small>` : ""}</span>`}
      </button>`;
    }).join("") + (current.length > LIMIT ? `<div class="more">и ещё ${current.length - LIMIT} — уточни поиск</div>` : "")
      : `<div class="more">Ничего не нашлось. Попробуй другое слово или сбрось фильтры.</div>`;
    const pad = homePad();
    if (fit === "soft") { const view = map.getBounds(); if (onMap.some((b) => view.contains(b.ll))) fit = false; }
    if (fit === "home") map.fitBounds(HOME, { ...pad, animate: false });   // рамка HOME — у создания карты
    else if (fit && here) map.fitBounds(L.latLngBounds([here, ...onMap.filter((b) => b._km != null).slice(0, 8).map((b) => b.ll)]).pad(0.2), { maxZoom: 13, ...pad });
    else if (fit && onMap.length) map.fitBounds(L.latLngBounds(onMap.map((b) => b.ll)).pad(0.15), { maxZoom: 12, ...pad });
  }
  $("#list").addEventListener("click", (e) => {
    const it = e.target.closest(".item[data-id]"); if (it) return openBath(+it.dataset.id, true);
    const rp = e.target.closest(".item[data-radar-id]"); if (rp) openRadar(+rp.dataset.radarId, true);
  });
  $("#potNote").addEventListener("click", (e) => {
    if (!e.target.closest(".x-note")) return;
    try { localStorage.setItem("ebl.potNote", "1"); } catch { /* не запомнится — не беда */ }
    $("#potNote").hidden = true;
  });

  // ---------- гонка недели ----------
  function renderRace() {
    let w = curWeek, live = true;
    const rowsFor = (wk) => standings.map((s) => [s.name, s.weekBaths[wk] ?? 0]).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1]);
    let rows = rowsFor(w);
    if (!rows.length) { w = curWeek - 1; live = false; rows = rowsFor(w); }
    const pts = placePoints(rows), max = rows[0]?.[1] || 1;
    const leader = rows[0]?.[0];
    const wasOpen = $("#race").classList.contains("open");
    $("#race").innerHTML = `
      <div class="race-head">
        <div>
          <div class="eyebrow">${live ? "Гонка недели" : "Итоги недели"} · <b>W${w}</b></div>
          <div class="race-title">${leader ? `${esc(leader)} ${live ? "впереди" : "победил"}` : "Пока тишина"}</div>
        </div>
        ${live ? `<span class="race-timer" title="до воскресенья 22:59 МСК">${icon("clock")}${timeLeft()}</span>` : ""}
        <button class="race-toggle" aria-label="Показать гонку">${icon("chev")}</button>
      </div>
      <ol class="race-list">${rows.slice(0, 5).map(([n, c], i) => `
        <li data-player="${esc(n)}">
          <span class="rk">${i + 1}</span>${ava(n, "sm")}
          <span><span class="rn">${esc(n)}</span><span class="rbar" style="--w:${(c / max) * 100}%"></span></span>
          <span class="rv"><b>${c}</b><small>+${fmt(pts[n])}</small></span>
        </li>`).join("")}</ol>
      <div class="race-foot">${rows.length > 5 ? `и ещё ${rows.length - 5} в гонке · ` : ""}${DATA_NOTE}</div>
      <button class="race-more" type="button">Весь недельный зачёт →</button>`;
    $("#race").classList.toggle("open", wasOpen);
    $(".race-toggle", $("#race")).onclick = () => $("#race").classList.toggle("open");
    $$("#race [data-player]").forEach((li) => (li.onclick = () => openPlayer(li.dataset.player)));
    $(".race-more", $("#race")).onclick = () => window.openWeekly();
  }
  renderRace();
  // страница открыта дольше недели (прошло воскресенье 22:59) — перезагружаем: сменилась текущая неделя и места
  setInterval(() => { if (weekOf(mskNow()) !== curWeek) location.reload(); renderRace(); renderTimer(); }, 60e3);

  // ---------- карточка бани ----------
  let openId = null, dropAt = null;   // dropAt — у какой бани сейчас нарисована капля
  // капля — у открытой бани (openId), у прежней — снова кружок
  function selectPin() {
    const prev = dropAt;
    dropAt = openId;
    for (const id of new Set([prev, openId])) {
      const m = markers.get(id), b = byId.get(id);
      if (m && b) m.setIcon(pinIcon(b)).setZIndexOffset(id === openId ? 1000 : 0);
    }
  }
  // центр карты, при котором точка видна над карточкой бани (на телефоне карта под ней, на компьютере — как есть)
  function aboveCard(ll, z) {
    if (!phone.matches) return ll;
    const r = $("#map").getBoundingClientRect(), visible = innerHeight * 0.38 - r.top;
    return map.unproject(map.project(ll, z).add([0, r.height / 2 - Math.max(40, visible / 2)]), z);
  }
  function openBath(id, fly) {
    const b = byId.get(id); if (!b) return;
    openId = id;
    $$(".item.active").forEach((x) => x.classList.remove("active"));
    $(`.item[data-id="${id}"]`)?.classList.add("active");
    // на телефоне карточка бани — шторка на нижние 62% экрана: точку ставим в видимую полосу карты над ней
    if (fly && b.ll) {
      const z = Math.max(map.getZoom(), b.prec === "exact" || b.prec === "auto" ? 15 : 11);
      map.flyTo(aboveCard(b.ll, z), z, { duration: calm ? 0 : 0.7 });
      map.once("moveend", selectPin);
    } else {
      if (phone.matches && b.ll) map.panTo(aboveCard(b.ll, map.getZoom()), { animate: !calm });
      selectPin();
    }
    const pv = prices[id] || [];   // по возрастанию price_date — последняя цена в конце
    const lastP = pv[pv.length - 1], olderP = pv.slice(0, -1).reverse();
    const bv = beerPrices[id] || [];
    const lastBeer = bv[bv.length - 1], olderBeer = bv.slice(0, -1).reverse();
    const rv = reviews[id] || [];
    // отзывов у участника может быть несколько (сходил ещё раз — написал ещё); средней по ним больше нет — рейтинг бани
    // считается по восьми пунктам (bath_ratings, 01.11)
    const pending = visits.filter((v) => v.bathId === id && v.status === "pending").length;
    // последний засчитанный поход с портала — журнал видят только участники, гостю строки нет
    const lastV = visits.filter((v) => v.bathId === id && v.status === "ok").sort((x, y) => y.date.localeCompare(x.date))[0];
    const hist = Object.entries(b.hist || {}).sort();
    const d = $("#drawer");
    // точка: нет / примерная / точная — одна строка под регионом и действие для участника (Комиссия ставит сразу,
    // участник точную только предлагает — bath_point_requests)
    const exact = !!b.ll && b.prec === "exact";
    const geoNote = !b.ll ? "ещё нет на карте" : exact ? "" : b.prec === "auto" ? "точка найдена автоматически по названию — может быть не та баня"
      : `точка примерная — ${PREC_LABEL[b.prec] || "по названию"}`;
    const geoAct = D.live && member ? (!exact ? "знаю, где это" : canModerate ? "перенести точку" : "точка не там?") : "";
    const geoSubmit = !exact ? "Поставить" : canModerate ? "Перенести" : "Предложить Комиссии";
    // флажки — текстом в строке типа, без плашек; «место силы» и «ультрауникальная» — то, ради чего стоит сходить
    const flags = [b.closed_on && `закрыта с ${closedWhen(b)}`, b.isNew && "новая, на модерации", !b.n26 && !b.nHist && !b.isNew && "кандидат в ультрауникальные", b.n26 >= 15 && "🔥 место силы"].filter(Boolean);
    const long = b.name.length > 18;   // длинное название — обычным жирным: широкий шрифт его рвёт на три строки
    if (cardFor !== id) { cardFor = id; cardOpen.clear(); }
    // кто парился — за всё время, с 2023-го (02.11, Леха: не делать упор на 2026); хозяин — по сезону, так и подписан
    const allBy = {};
    for (const y of Object.values(b.histBy || {})) for (const [n, k] of Object.entries(y)) allBy[n] = (allBy[n] || 0) + k;
    for (const [n, k] of Object.entries(b.v26 || {})) allBy[n] = (allBy[n] || 0) + k;
    const whoAll = Object.entries(allBy).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "ru")), own = ownerOf(b);
    const years = [...hist.map(([y, n]) => [y, n]), ["2026", b.n26]].filter(([, n]) => n > 0);
    // карты — сразу поиском по названию; придут факты сверки — подставим их ссылки
    const qMap = encodeURIComponent([b.name, b.region || b.country].filter(Boolean).join(", "));
    const yaUrl = exact ? `https://yandex.ru/maps/?pt=${b.ll[1]},${b.ll[0]}&z=17&text=${encodeURIComponent(b.name)}` : `https://yandex.ru/maps/?text=${qMap}`;
    const gisUrl = exact ? `https://2gis.ru/geo/${b.ll[1]},${b.ll[0]}` : `https://2gis.ru/search/${qMap}`;
    d.innerHTML = `
      <button type="button" class="grab d-grab" aria-label="Развернуть карточку на весь экран"><i></i></button>
      <button class="x" aria-label="Закрыть">${icon("close")}</button>
      ${canModerate && D.live ? `<button type="button" class="x x-edit" id="dEditBtn" aria-haspopup="menu" aria-expanded="false" aria-controls="dEditMenu" aria-label="Правка Комиссии" title="Правка Комиссии"><svg class="ic" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>
      <div class="d-edit" id="dEditMenu" role="menu" hidden>
        <span class="d-edit-h">Правка Комиссии</span>
        <button type="button" role="menuitem" id="dTypeBtn" aria-expanded="false" aria-controls="dTypeAsk">Тип бани<small>${TYPE_LABEL[b.t]}</small></button>
        <button type="button" role="menuitem" id="dRename">Название</button>
        <button type="button" role="menuitem" id="geoFixBtn">Точка на карте<small>${exact ? "точная" : b.ll ? "примерная" : "нет"}</small></button>
        <button type="button" role="menuitem" id="dPlaceBtn" aria-expanded="false" aria-controls="dPlaceAsk">Страна и регион</button>
        <button type="button" role="menuitem" id="dCloseBtn" aria-expanded="false">${b.closed_on ? "Работает снова" : "Закрылась"}</button>
      </div>` : ""}
      <div class="d-body">
        <div class="d-hero t-${b.t}">
          <div class="d-meta">
            <span class="t">${tdot(b.t)}${TYPE_LABEL[b.t]}</span>
            ${flags.map((f) => `<span class="flag">${f}</span>`).join("")}
          </div>
          ${canModerate && D.live ? `<div class="type-ask" id="dTypeAsk" hidden>
            <div class="chips" role="group" aria-label="Новый тип бани">${Object.entries(TYPE_CHOICE).map(([t, l]) => `<button type="button" data-newtype="${t}" aria-pressed="${b.t === t}">${tdot(t)}${l}</button>`).join("")}</div>
            <p class="type-note" id="dTypeNote">Выбери новый тип.</p>
            <div class="type-acts"><button type="button" class="btn sm solid" id="dTypeGo" disabled>Сменить</button><button type="button" class="linkbtn" id="dTypeCancel">Отмена</button></div>
          </div>` : ""}
          <h2 class="${long ? "long" : ""}">${esc(b.name)}</h2>
          <div class="geo-move">
            <p class="where">${icon("pin")}<span><span id="dWhereTxt">${esc(where(b))}</span>${geoNote ? ` · <span class="muted">${geoNote}</span>` : ""}${(() => {
              // участнику — одна тихая ссылка («знаю, где это» / «точка не там?»); Комиссия правит всё из меню под карандашом
              const acts = [!canModerate && geoAct && `<button class="linkbtn" id="geoFixBtn" type="button">${geoAct}</button>`].filter(Boolean);
              return acts.length ? `<span class="w-acts">${acts.join(" · ")}</span>` : "";   // своей строкой под адресом: адреса бывают длинными
            })()}</span></p>
            ${geoAct ? `<form id="geoFixForm" class="geo-form" hidden><input class="inp" id="geoFixInput" placeholder="Ссылка на баню в картах, адрес или координаты" required>
              <button class="btn sm solid" type="submit">${geoSubmit}</button></form>` : ""}
          </div>
          ${canModerate && D.live ? `<form class="type-ask" id="dPlaceAsk" hidden>
            <p class="type-note">Страна и регион бани — по ним бонусы за новый регион и страну, очки пересчитаются.</p>
            <div class="place-row"><input class="inp sm" id="dPlaceCountry" list="countryList" value="${esc(b.country || "")}" placeholder="Страна" aria-label="Страна" required>
              <input class="inp sm" id="dPlaceRegion" list="regionList" value="${esc(b.region || "")}" placeholder="Регион" aria-label="Регион"></div>
            <div class="type-acts"><button type="submit" class="btn sm solid" id="dPlaceGo">Сохранить</button><button type="button" class="linkbtn" id="dPlaceCancel">Отмена</button></div>
          </form>` : ""}
          ${canModerate && D.live ? `<div class="type-ask" id="dCloseAsk" hidden>
            <p class="type-note">${b.closed_on
              ? `«${esc(b.name)}» снова работает? Вернётся на карту обычной и в форму похода.`
              : `Отметить «${esc(b.name)}» закрытой? Походы и очки останутся в истории, на карте она станет бледной, в форме похода её не предложим.`}</p>
            ${b.closed_on ? "" : `<label class="lab">Закрылась в <input class="inp sm" type="month" id="dCloseMonth" value="${new Date().toISOString().slice(0, 7)}" max="${new Date().toISOString().slice(0, 7)}"></label>`}
            <div class="type-acts"><button type="button" class="btn sm solid" id="dCloseGo">${b.closed_on ? "Работает" : "Закрыта"}</button><button type="button" class="linkbtn" id="dCloseCancel">Отмена</button></div>
          </div>` : ""}
        </div>
        <section class="d-main" id="dMain">
          <div class="d-key">
            <button type="button" class="d-k" id="dToday" aria-expanded="false" aria-controls="dWeek"><span class="k-l">Сегодня${icon("chev")}</span><b id="dTodayV">—</b><small id="dTodaySub">часы не указали</small></button>
            <div class="d-k"><span class="k-l">Вход</span><b id="dPriceV">${lastP ? `${money(lastP.price)} ${curSign(lastP.currency)}` : "—"}</b><small id="dPriceSub">${lastBeer ? `пиво ${money(lastBeer.price)} ${curSign(lastBeer.currency)}` : lastP ? dayLabel(lastP.price_date) : "не указали"}</small></div>
            <div class="d-k" id="dRateTile">${rateTile(id)}</div>
          </div>
          <div class="d-week" id="dWeek" hidden></div>
          <div class="rate-rows" id="dRating" ${ratings[id] ? "" : "hidden"}>${rateRows(id)}</div>
        </section>
        <div class="d-photos" id="dPhotos" hidden></div>
        <div id="dRateInvite">${rateInvite(id)}</div>
        <section class="d-about" id="dAbout" hidden><div class="d-idx" id="dIdx" hidden></div><div class="d-info" id="dInfo"></div></section>
        <div class="d-acts">
          <a id="dYa" target="_blank" rel="noopener" href="${yaUrl}">${icon("pin")}<span>Яндекс</span></a>
          <a id="dGis" target="_blank" rel="noopener" href="${gisUrl}">${icon("map")}<span>2ГИС</span></a>
          <a id="dSite" target="_blank" rel="noopener" hidden>${icon("globe")}<span>Сайт</span></a>
          <a id="dCall" hidden>${icon("phone")}<span>Позвонить</span></a>
          <button type="button" id="dShare">${icon("share")}<span>Поделиться</span></button>
        </div>
        <p class="d-phone" id="dPhone" hidden></p>
        <section class="d-who">
          <div class="d-sh"><h3>Кто парился</h3>${whoAll.length > 6 ? `<button type="button" class="linkbtn" id="dWhoAll">все ${whoAll.length}</button>` : ""}</div>
          ${own && own.kind !== "free" ? `<div class="d-owner"><span class="d-owner-ava">${ava(own.who[0])}<i class="hat-on" aria-hidden="true"></i></span><span>
            <b>${own.kind === "owner" ? `${esc(own.who[0])} — хозяин бани в 2026` : `${esc(own.who.join(" и "))} делят шапку в 2026`}</b>
            <small>${own.n} ${plural(own.n, "поход", "похода", "походов")} из ${b.n26} в сезоне</small></span></div>` : ""}
          ${whoAll.length ? `<div class="who" id="dWho">${whoAll.map(([p, n], i) => `<button data-player="${esc(p)}" ${i >= 6 ? "hidden" : ""}>${ava(p, "sm")}${esc(p)}${n > 1 ? `<b>×${n}</b>` : ""}</button>`).join("")}</div>`
            : `<p class="hint" style="margin:0">С 2023 года здесь никого из лиги не было — первые, кто сходит, возьмут +1 за ультрауникальную и +1 за уникальную.</p>`}
          ${years.length ? `<button type="button" class="d-years-btn" id="dYearsBtn" aria-expanded="false" aria-controls="dYears">Походы лиги по годам: <b>${years.map(([, n]) => n).join(" → ")}</b>${icon("chev")}</button>
          <div class="d-years" id="dYears" hidden>${years.slice().reverse().map(([y]) => {
            // кто был в этот год (03.11, Витёк: при сверке — у кого спросить); свежие годы сверху, по пять ников
            const by = Object.entries(y === "2026" ? b.v26 || {} : b.histBy?.[y] || {}).sort((a, c) => c[1] - a[1] || a[0].localeCompare(c[0], "ru"));
            const n = by.reduce((a, [, k]) => a + k, 0);
            return `<p><b>${y}</b><span class="dy-n">${n}</span><span>${by.slice(0, 5).map(([nick, k]) => `<button type="button" class="linkbtn" data-player="${esc(nick)}">${esc(nick)}</button>${k > 1 ? ` ×${k}` : ""}`).join(", ")}${by.length > 5 ? ` и ещё ${by.length - 5}` : ""}</span></p>`;
          }).join("")}</div>` : ""}
          ${lastV ? `<p class="hint last-visit" style="margin:6px 0 0">Последний раз — <b>${dayLabel(lastV.date)}</b>: ${esc([lastV.player, ...(lastV.companions || [])].join(", "))}</p>` : ""}
          ${pending ? `<p class="hint" style="margin:6px 0 0">Ещё ${pending} на модерации</p>` : ""}
        </section>
        <section class="d-fb" id="dFeedback">${feedbackHtml(id)}</section>
        <section>
          <h3>Цена</h3>
          <div class="price-now">
            ${lastP ? `<p><span><b>${money(lastP.price)} ${curSign(lastP.currency)}</b>${lastP.duration_min ? ` · ${lastP.duration_min} мин` : ""}${schedLabel(lastP) ? ` · ${schedLabel(lastP)}` : ""}</span><small>${dayLabel(lastP.price_date)}</small></p>` : ""}
            ${lastBeer ? `<p><span>🍺 <b>${money(lastBeer.price)} ${curSign(lastBeer.currency)}</b> пиво</span><small>${dayLabel(lastBeer.price_date)}</small></p>` : ""}
            ${!lastP && !lastBeer ? `<p class="hint" id="dPriceNone">Цену пока никто не указал${member ? "" : "."}</p>` : ""}
            <div class="price-site" id="dPriceSite" hidden></div>
          </div>
          ${olderP.length || olderBeer.length ? `<details class="price-old"><summary>Раньше · ${olderP.length + olderBeer.length}</summary>
            ${olderP.map((p) => `<p><span>${money(p.price)} ${curSign(p.currency)}${p.duration_min ? ` · ${p.duration_min} мин` : ""}${schedLabel(p) ? ` · ${schedLabel(p)}` : ""}</span><small>${dayLabel(p.price_date)}</small></p>`).join("")}
            ${olderBeer.map((p) => `<p><span>🍺 ${money(p.price)} ${curSign(p.currency)}</span><small>${dayLabel(p.price_date)}</small></p>`).join("")}</details>` : ""}
          ${member ? `<button type="button" class="addbtn" id="prOpen" ${cardOpen.has("pr") ? "hidden" : ""}>+ Указать цену</button>
          <form class="prform" id="prForm" ${cardOpen.has("pr") ? "" : "hidden"}>
            <div class="row">
              <input class="inp" id="prPrice" inputmode="decimal" autocomplete="off" placeholder="♨️ Цена входа, ₽" required>
              <input class="inp" id="prBeer" inputmode="decimal" autocomplete="off" placeholder="🍺 Цена пива, ₽">
            </div>
            <button type="button" class="linkbtn" id="prMore">ещё: сеанс · будни/выходной · валюта</button>
            <div class="row" id="prExtra" hidden>
              <input class="inp" id="prDur" type="number" min="1" placeholder="Продолжительность сеанса, мин">
              <div class="seg" id="prWeekend" role="radiogroup" aria-label="Будни или выходной">
                <button type="button" data-w="" aria-pressed="true">Любой день</button>
                <button type="button" data-w="0" aria-pressed="false">Будни</button>
                <button type="button" data-w="1" aria-pressed="false">Выходной</button>
              </div>
              <label class="hint" style="display:flex;align-items:center;gap:6px">Скидка до <input class="inp" id="prBefore" type="time" style="flex:0 0 auto"></label>
              <input class="inp" id="prCurrency" placeholder="Валюта — код (USD, EUR…)">
            </div>
            <button class="btn solid" type="submit" style="justify-self:start">Добавить</button>
          </form>` : ""}
        </section>
        <section>
          <h3>Пары и часы работы</h3>
          <div class="price-now" id="dSched"><p class="hint">Пока никто не указал${member ? "" : "."}</p></div>
          ${member ? `<button type="button" class="addbtn" id="shOpen" ${cardOpen.has("sh") ? "hidden" : ""}>+ Указать пары${hoursKnown(id) ? "" : " и часы"}</button>
          <form class="prform" id="shForm" ${cardOpen.has("sh") ? "" : "hidden"}>
            <span class="hint">Как часто пары?</span>
            <div class="seg" id="shEvery" role="radiogroup" aria-label="Как часто пары">
              <button type="button" data-e="60" aria-pressed="false">Каждый час</button>
              <button type="button" data-e="120" aria-pressed="false">Каждые два часа</button>
              <button type="button" data-e="other" aria-pressed="false">Другое</button>
            </div>
            <div class="row sh-row" id="shRange" hidden>
              <span class="hint sh-q">Со скольки до скольки?</span>
              <label class="hint sh-t">с <select class="inp" id="shFrom">${timeOpts}</select></label>
              <label class="hint sh-t">до <select class="inp" id="shTo">${timeOpts}</select></label>
            </div>
            <div class="chips sh-pick" id="shPick" role="group" aria-label="Часы паров" hidden>${Array.from({ length: 24 }, (_, h) => {
              const t = String(h).padStart(2, "0") + ":00"; return `<button type="button" data-t="${t}" aria-pressed="false">${t}</button>`;
            }).join("")}</div>
            <p class="hint" id="shPreview" hidden></p>
            <button type="button" class="linkbtn" id="shHoursEdit" style="justify-self:start" hidden>изменить часы работы</button>
            <div class="sh-hours" id="shHours">
              <span class="hint">Часы работы</span>
              <div class="row sh-row">
                <label class="hint sh-t">с <select class="inp" id="shOpenT">${timeOpts}</select></label>
                <label class="hint sh-t">до <select class="inp" id="shCloseT">${timeOpts}</select></label>
              </div>
            </div>
            <button class="btn solid" type="submit" style="justify-self:start">Сохранить</button>
          </form>` : ""}
        </section>
      </div>`;
    if (d.hidden) pushStep({ type: "bath" });
    d.hidden = false;
    history.replaceState(history.state, "", "#bath=" + id);   // ссылку на открытую баню можно скопировать из адресной строки
    if (D.live && member) {
      if (!photoCache.has(id)) photoCache.set(id, D.bathPhotos(id).catch(() => { photoCache.delete(id); return []; }));
      photoCache.get(id).then((ps) => renderPhotos(id, ps));
    }
    if (!schedCache.has(id)) schedCache.set(id, D.bathSchedule(id).catch(() => { schedCache.delete(id); return null; }));
    schedCache.get(id).then((sc) => { schedNow.set(id, sc); renderSchedule(id); syncToday(id); });
    if (D.live) {
      if (!factCache.has(id)) factCache.set(id, D.bathFacts(id).catch(() => { factCache.delete(id); return null; }));
      factCache.get(id).then((f) => { factNow.set(id, f); renderFacts(id, f); renderSchedule(id); syncToday(id); });
    }
    $(".x:not(.x-edit)", d).onclick = closeBath;
    const editBtn = $("#dEditBtn", d), editMenu = $("#dEditMenu", d);
    if (editBtn) {
      editBtn.onclick = () => { editMenu.hidden = !editMenu.hidden; editBtn.setAttribute("aria-expanded", String(!editMenu.hidden)); };
      $$("[role=menuitem]", editMenu).forEach((x) => x.addEventListener("click", () => { editMenu.hidden = true; editBtn.setAttribute("aria-expanded", "false"); }));
    }
    $("#dShare", d).onclick = () => shareBath(id);
    syncIndex(id);
    // тип бани — Комиссия меняет прямо в карточке, но только после подтверждения: от типа зависят очки за все походы сюда (18.10)
    const typeAsk = $("#dTypeAsk", d);
    if (typeAsk) {
      let pick = null;
      const btn = $("#dTypeBtn", d), go = $("#dTypeGo", d), note = $("#dTypeNote", d);
      const close = () => { typeAsk.hidden = true; btn.setAttribute("aria-expanded", "false"); };
      btn.onclick = () => { typeAsk.hidden = !typeAsk.hidden; btn.setAttribute("aria-expanded", String(!typeAsk.hidden)); };
      $$("[data-newtype]", typeAsk).forEach((x) => (x.onclick = () => {
        pick = x.dataset.newtype;
        $$("[data-newtype]", typeAsk).forEach((y) => y.setAttribute("aria-pressed", String(y === x)));
        go.disabled = pick === b.t;
        const n = b.n26 || 0;
        note.textContent = pick === b.t ? "Это и есть текущий тип."
          : `«${b.name}»: ${TYPE_LABEL[b.t]} → ${TYPE_LABEL[pick]}. ${n ? `Очки за ${n} ${plural(n, "поход", "похода", "походов")} сюда в 2026 пересчитаются.` : "Очки за походы сюда пересчитаются."}`;
      }));
      $("#dTypeCancel", d).onclick = close;
      go.onclick = async () => {
        go.disabled = true;
        try {
          await D.moderateBath(b.id, { type: pick });
          b.type = pick; b.t = pick; render(); openBath(b.id);
          toast(`«${b.name}»: ${TYPE_LABEL[b.t]} — таблица пересчитывается`); recomputeSoon();
        } catch (err) { go.disabled = false; toast("Не получилось: " + err.message); }
      };
    }
    // страна и регион (21.10): у точной точки их ставит геокодер, у примерной — из таблицы; ошибся тот или другой
    // («Хельсинки» в Хабаровском крае) — правит Комиссия здесь. Написание — как уже встречалось у лиги, иначе бонус за «новый»
    // регион; у точной точки запоминаем, что регион к ней решён (place_lat), — геокодер его больше не перепишет
    const placeAsk = $("#dPlaceAsk", d);
    if (placeAsk) {
      const btn = $("#dPlaceBtn", d);
      btn.onclick = () => { placeAsk.hidden = !placeAsk.hidden; btn.setAttribute("aria-expanded", String(!placeAsk.hidden)); if (!placeAsk.hidden) $("#dPlaceCountry", d).focus(); };
      $("#dPlaceCancel", d).onclick = () => { placeAsk.hidden = true; btn.setAttribute("aria-expanded", "false"); };
      placeAsk.onsubmit = async (e) => {
        e.preventDefault();
        const p = matchPlace($("#dPlaceCountry", d).value.trim(), $("#dPlaceRegion", d).value.trim());
        const patch = { country: p.country || null, region: p.region || null };
        if (patch.country === (b.country || null) && patch.region === (b.region || null)) { $("#dPlaceCancel", d).click(); return; }
        if (b.precision === "exact" && b.lat != null) Object.assign(patch, { place_lat: b.lat, place_lng: b.lng });
        $("#dPlaceGo", d).disabled = true;
        try {
          await D.moderateBath(b.id, patch);
          Object.assign(b, patch); hydrate(b); render(); openBath(b.id);
          toast(`«${b.name}»: ${where(b)} — таблица пересчитывается`); recomputeSoon();
        } catch (err) { $("#dPlaceGo", d).disabled = false; toast("Не получилось: " + err.message); }
      };
    }
    // баня закрылась (19.10) — Комиссия отмечает месяцем с подтверждением; походы и очки остаются, это история
    const closeAsk = $("#dCloseAsk", d);
    if (closeAsk) {
      const btn = $("#dCloseBtn", d);
      btn.onclick = () => { closeAsk.hidden = !closeAsk.hidden; btn.setAttribute("aria-expanded", String(!closeAsk.hidden)); };
      $("#dCloseCancel", d).onclick = () => { closeAsk.hidden = true; btn.setAttribute("aria-expanded", "false"); };
      $("#dCloseGo", d).onclick = async (e) => {
        e.target.disabled = true;
        const closed_on = b.closed_on ? null : ($("#dCloseMonth", d).value || new Date().toISOString().slice(0, 7)) + "-01";
        try {
          await D.moderateBath(b.id, { closed_on });
          b.closed_on = closed_on; render(); openBath(b.id);
          toast(closed_on ? `«${b.name}»: закрыта с ${closedWhen(b)}` : `«${b.name}» снова работает`);
        } catch (err) { e.target.disabled = false; toast("Не получилось: " + err.message); }
      };
    }
    $("#dYearsBtn", d)?.addEventListener("click", (e) => { const y = $("#dYears", d); y.hidden = !y.hidden; e.currentTarget.setAttribute("aria-expanded", String(!y.hidden)); });
    $("#dWhoAll", d)?.addEventListener("click", (e) => { $$("#dWho [hidden]", d).forEach((x) => (x.hidden = false)); e.currentTarget.remove(); });
    $("#dToday", d).onclick = () => { const w = $("#dWeek", d); if (!w.innerHTML) return; w.hidden = !w.hidden; $("#dToday", d).setAttribute("aria-expanded", String(!w.hidden)); };
    syncToday(id);
    $(".d-grab", d).onclick = () => d.classList.toggle("full");
    $("#prMore", d)?.addEventListener("click", () => { $("#prMore", d).hidden = true; $("#prExtra", d).hidden = false; });
    $$("#prWeekend button", d).forEach((b) => b.addEventListener("click", () => $$("#prWeekend button", d).forEach((x) => x.setAttribute("aria-pressed", String(x === b)))));
    $("#prForm", d)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const currency = $("#prCurrency", d).value.trim() || null;
      const price = priceIn($("#prPrice", d).value, currency); if (!price || price <= 0) return;
      const durationMin = +$("#prDur", d).value || null;
      const wVal = $("#prWeekend [aria-pressed=true]", d)?.dataset.w;
      const isWeekend = wVal === "" || wVal == null ? null : wVal === "1";
      const beforeTime = $("#prBefore", d).value || null;
      const beerPrice = priceIn($("#prBeer", d).value, currency) || null;
      try {
        const pid = await D.submitBathPrice(id, price, currency, durationMin, isWeekend, beforeTime);
        if (pid) (prices[id] ||= []).push({ id: pid, price, currency: (currency || "RUB").toUpperCase(), duration_min: durationMin,
          is_weekend: isWeekend, before_time: beforeTime, price_date: new Date().toISOString().slice(0, 10) });
        if (beerPrice > 0) {
          const bid = await D.submitBeerPrice(id, beerPrice, currency);
          if (bid) (beerPrices[id] ||= []).push({ id: bid, price: beerPrice, currency: (currency || "RUB").toUpperCase(), price_date: new Date().toISOString().slice(0, 10) });
        }
        if (pid || beerPrice > 0) { toast("Цена добавлена — спасибо"); openBath(id); }
        else toast("Такая же цена уже есть — не дублирую");
      } catch (err) { toast("Не сохранилось: " + err.message); }
    });
    $$("[data-player]", d).forEach((x) => (x.onclick = () => openPlayer(x.dataset.player)));
    $("#geoFixBtn", d)?.addEventListener("click", () => { const f = $("#geoFixForm", d); f.hidden = !f.hidden; if (!f.hidden) $("#geoFixInput", d).focus(); });
    // формы цены и пар — по кнопке: сначала то, что уже знаем о бане; открытая остаётся открытой, пока карточка та же
    const openForm = (key, btn, form, focus) => $(btn, d)?.addEventListener("click", () => {
      cardOpen.add(key); $(btn, d).hidden = true; $(form, d).hidden = false; $(focus, d)?.focus();
    });
    openForm("pr", "#prOpen", "#prForm", "#prPrice");
    openForm("sh", "#shOpen", "#shForm", "#shEvery button");
    const shForm = $("#shForm", d);
    if (shForm) {
      let every = null;
      const picked = () => $$("#shPick [aria-pressed=true]", d).map((x) => x.dataset.t);
      const times = () => every === "other" ? picked() : steamTimes($("#shFrom", d).value, $("#shTo", d).value, +every);
      const preview = () => {
        const p = $("#shPreview", d), ts = every ? times() : [];
        p.hidden = every === "other" || !ts.length;
        p.textContent = ts.length ? "Пары: " + ts.join(" · ") : "";
      };
      $$("#shEvery button", d).forEach((x) => x.addEventListener("click", () => {
        every = x.dataset.e;
        $$("#shEvery button", d).forEach((y) => y.setAttribute("aria-pressed", String(y === x)));
        $("#shRange", d).hidden = every === "other"; $("#shPick", d).hidden = every !== "other";
        preview();
      }));
      $$("#shPick button", d).forEach((x) => x.addEventListener("click", () => x.setAttribute("aria-pressed", String(x.getAttribute("aria-pressed") !== "true"))));
      ["#shFrom", "#shTo"].forEach((q) => $(q, d).addEventListener("change", preview));
      $("#shHoursEdit", d).addEventListener("click", () => editHours(id));
      syncHours(id);
      shForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const withHours = !$("#shHours", d).hidden;
        const ts = every ? times() : [], open = withHours ? $("#shOpenT", d).value : "", close = withHours ? $("#shCloseT", d).value : "";
        if (every && !ts.length) { toast(every === "other" ? "Отметь часы паров" : "Укажи, со скольки до скольки пары"); return; }
        if (!!open !== !!close) { toast("Часы работы — и открытие, и закрытие"); return; }
        if (!ts.length && !open) { toast("Укажи пары или часы работы"); return; }
        try {
          const a = ts.length ? await D.submitBathSteam(id, ts, every === "other" ? null : +every) : null;
          const b = open ? await D.submitBathHours(id, open, close) : null;
          schedCache.delete(id); schedNow.delete(id);
          if (a || b) { toast("Сохранил — спасибо"); cardOpen.delete("sh"); cardOpen.delete("shh"); openBath(id); }
          else toast("Так уже записано — не дублирую");
        } catch (err) { toast("Не сохранилось: " + err.message); }
      });
    }
    $("#geoFixForm", d)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const p = await D.setBathLocation(id, $("#geoFixInput", d).value.trim());
        // точная точка уже стояла — участник её не меняет, а предлагает: решит Комиссия (кнопки в личке у бота)
        if (p.same) { toast("Точка бани и так здесь 👌"); $("#geoFixForm", d).hidden = true; return; }
        if (p.requested) {
          $("#geoFixForm", d).outerHTML = `<span class="hint">Передал Комиссии новую точку${p.km != null ? ` — в ${p.km < 1 ? Math.round(p.km * 1000) + " м" : Math.round(p.km) + " км"} от нынешней` : ""}. Перенесут, если всё так.</span>`;
          return toast("📍 Передал Комиссии — спасибо!");
        }
        b.lat = p.lat; b.lng = p.lng; b.precision = "exact"; hydrate(b);
        render(); openBath(id, true); toast("📍 Точка поставлена — спасибо!");
        refreshData().then(() => openId === id && openBath(id)).catch(() => {});   // страну и регион по точке сервер мог заполнить
      } catch (err) { toast(err.message); }
    });
    bindFeedback(id);
    if (D.live && !ratingsBy.has(id)) D.bathRatingsBy(id).then((rows) => { ratingsBy.set(id, rows); if (openId === id && $("#dFeedback")) { $("#dFeedback").innerHTML = feedbackHtml(id); bindFeedback(id); } }).catch(() => {});
    // Комиссия правит название бани прямо в карточке («Северные Киров» → «Киров, Северные»)
    $("#dRename", d)?.addEventListener("click", async () => {
      const name = prompt("Название бани — как в справочнике Комиссии", b.name)?.trim();
      if (!name || name === b.name) return;
      try { await D.moderateBath(id, { name }); b.name = name; hydrate(b); render(); openBath(id); toast("Название поправлено"); }
      catch (err) { toast("Не получилось: " + err.message); }
    });
  }
  // «Отзывы и оценки» (02.11, Леха): отзывы и оценки без текста — одной лентой, свежие сверху. У человека — его последняя
  // оценка бани по восьми пунктам (bath_ratings), у старых отзывов без неё — их «звезда». Поправить своё — кнопкой под лентой: страница оценки,
  // там прежние баллы и прежний отзыв. Оценивают и пишут те, кто был в бане (bath_counts), — кнопка только им
  const ratingsBy = new Map();   // баня → последние оценки по людям; грузим при открытии карточки
  const nickById = Object.fromEntries(Object.entries(data.playerIds || {}).map(([n, i]) => [i, n]));
  const timesIn = (b, nick) => (b?.v26?.[nick] || 0) + Object.values(b?.histBy || {}).reduce((a, y) => a + (y[nick] || 0), 0);
  const FB_SHOW = 3;   // сколько записей видно сразу; остальные — «Показать все N»
  function feedbackHtml(id) {
    const rateOf = new Map((ratingsBy.get(id) || []).map((r) => [nickById[r.player_id], r]).filter(([n]) => n));
    const items = (reviews[id] || []).map((r) => ({ ...r, score: null })), used = new Set();
    for (const it of items) { const r = rateOf.get(it.author); if (r && !used.has(it.author)) { it.score = +r.overall; used.add(it.author); } }
    for (const [nick, r] of rateOf) if (!used.has(nick)) items.push({ author: nick, score: +r.overall, at: r.updated_at, mine: nick === myNick });
    // своё — первым (правят из «⋯»), дальше свежие сверху
    items.sort((a, b) => (b.mine === true) - (a.mine === true) || String(b.at || "").localeCompare(String(a.at || "")));
    const been = !!myNick && timesIn(byId.get(id), myNick) > 0, rated = !!myRated?.has(id) || rateOf.has(myNick);
    const score = (v) => `<span class="rv-rate"><b>${fmt(v)}</b>${fanSvg(v)}</span>`;
    const menu = (it) => {
      const acts = [it.mine && D.live && `<a role="menuitem" class="rv-edit" href="rate.html?b=${id}">Изменить оценку и отзыв</a>`,
        it.id && (it.mine || canModerate) && `<button type="button" role="menuitem" data-rvdel="${it.id}">Удалить отзыв</button>`].filter(Boolean);
      return acts.length ? `<button type="button" class="rv-more" data-rvmenu aria-haspopup="menu" aria-expanded="false" aria-label="Действия с ${it.mine ? "моей оценкой" : "отзывом"}">${icon("dots")}</button>
        <div class="rv-menu" role="menu" hidden>${acts.join("")}</div>` : '<span class="rv-more" aria-hidden="true"></span>';   // пустое место под «⋯» — даты в ленте встают в одну колонку
    };
    return `<h3 class="d-big">Отзывы и оценки${items.length ? ` · ${items.length}` : ""}</h3>
      <div class="reviews">${items.length ? items.map((it, i) => `<div class="review${it.mine ? " mine" : ""}" ${i >= FB_SHOW ? "hidden" : ""}>${ava(it.author)}<div>
        <div class="rh"><b>${esc(it.author)}${it.mine ? '<span class="rv-me">ты</span>' : ""}${it.sample ? '<span class="sample">пример</span>' : ""}</b>${it.score != null ? score(it.score) : it.rate ? score(it.rate) : ""}${it.at ? `<small class="hint">${dayLabel(mskIso(it.at))}</small>` : ""}${menu(it)}</div>
        ${it.text ? `<p>${esc(it.text)}</p>` : '<p class="hint rv-none">оценка без отзыва</p>'}
      </div></div>`).join("") : `<p class="hint" style="margin:0">Пока никто не оценил${been ? " — оцени первым" : ""}.</p>`}</div>
      ${items.length > FB_SHOW ? `<button type="button" class="rv-all" id="rvAll">Показать все ${items.length}</button>` : ""}
      ${!member ? `<div class="rvform"><p class="hint" style="margin:0">Оценки и отзывы — от участников лиги, которые были в бане.</p><button class="btn solid" type="button" id="rvLogin" style="justify-self:start">${D.live && me ? "Кто ты в таблице?" : "Войти через Telegram"}</button></div>`
        : been && D.live && !rated ? `<a class="btn solid rv-go" id="rvGo" href="rate.html?b=${id}">Оценить и написать отзыв</a>`
        : !been ? '<p class="hint rv-who">Оценивают и пишут отзывы те, кто был в бане.</p>' : ""}`;
  }
  function bindFeedback(id) {
    const box = $("#dFeedback"); if (!box) return;
    $("#rvLogin", box)?.addEventListener("click", () => (me ? openClaim() : openLogin()));
    $("#rvAll", box)?.addEventListener("click", (e) => { $$(".review[hidden]", box).forEach((x) => (x.hidden = false)); e.currentTarget.remove(); });
    // «⋯» у записи — маленькое меню; открыто одно, нажатие мимо закрывает
    const closeAll = () => $$(".rv-menu", box).forEach((m) => { m.hidden = true; m.previousElementSibling?.setAttribute("aria-expanded", "false"); });
    $$("[data-rvmenu]", box).forEach((b) => (b.onclick = (e) => {
      e.stopPropagation(); const m = b.nextElementSibling, open = m.hidden; closeAll(); m.hidden = !open; b.setAttribute("aria-expanded", String(open));
    }));
    box.addEventListener("click", (e) => { if (!e.target.closest(".rv-menu")) closeAll(); });
    $$("[data-rvdel]", box).forEach((x) => (x.onclick = async () => {
      if (!confirm("Удалить отзыв? Оценка останется.")) return;
      try { await D.deleteReview(id, +x.dataset.rvdel); reviews[id] = (reviews[id] || []).filter((r) => r.id !== +x.dataset.rvdel); toast("Отзыв удалён"); openBath(id); }
      catch (err) { toast("Не удалилось: " + err.message); }
    }));
  }
  // фото походов в карточке бани (docs/photos.md): лента, свежие походы первыми; дата — на первом фото похода, между походами
  // промежуток шире; имён нет. Грузим, когда карточку открыли, и держим до перезагрузки — карточка перерисовывается часто
  const photoCache = new Map();
  // «О бане» (19.10): что агенты собрали в сверке и приняла Комиссия — простым списком, со ссылками и откуда это.
  // Держим только до перезагрузки страницы (как фото): решения Комиссии подтянутся при следующем заходе
  const factCache = new Map();
  // часы из сверки — по дням недели (0 — пн): «ср–чт 14:00–23:00, пт 14:00–24:00; пн–вт закрыто», «ежедневно 8–22».
  // Не разобрали — null, тогда показываем текст как есть
  const WD = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  function hoursByDay(text) {
    const t = String(text || "").toLowerCase().replace(/\s*\([^)]*\)/g, "");
    const D = "(?:пн|вт|ср|чт|пт|сб|вс)", T = "\\d{1,2}(?::\\d{2})?\\s*[–—-]\\s*\\d{1,2}(?::\\d{2})?";
    const rx = new RegExp(`((?:${D}(?:\\s*[–—-]\\s*${D})?(?:\\s*,\\s*(?=${D}))?)+|ежедневно|без выходных|каждый день|будни|выходные)\\s*:?\\s*(${T}|закрыт[а-я]*|выходн[а-я]*|круглосуточно)`, "g");
    const out = Array(7).fill(null); let hit = false;
    for (const m of t.matchAll(rx)) {
      const val = /^(закрыт|выходн)/.test(m[2]) ? "закрыто" : m[2].replace(/\s*[–—-]\s*/, "–");
      const idx = [];
      if (/ежедневно|без выходных|каждый день/.test(m[1])) idx.push(0, 1, 2, 3, 4, 5, 6);
      else if (m[1] === "будни") idx.push(0, 1, 2, 3, 4);
      else if (m[1] === "выходные") idx.push(5, 6);
      else for (const part of m[1].split(/\s*,\s*/)) {
        const r = part.match(new RegExp(`(${D})(?:\\s*[–—-]\\s*(${D}))?`)); if (!r) continue;
        const from = WD.indexOf(r[1]), to = r[2] ? WD.indexOf(r[2]) : from;
        for (let i = from, n = 0; n < 7; i = (i + 1) % 7, n++) { idx.push(i); if (i === to) break; }
      }
      for (const i of idx) if (out[i] == null) out[i] = val;
      hit = true;
    }
    if (!hit && /круглосуточно/.test(t)) return Array(7).fill("круглосуточно");
    return hit ? out : null;
  }
  // подряд идущие дни с одинаковыми часами — одной строкой: «ср–чт 14:00–23:00»
  const hoursRows = (byDay) => byDay.reduce((acc, v, i) => {
    const last = acc[acc.length - 1];
    if (last && last.v === v && last.to === i - 1) last.to = i; else acc.push({ from: i, to: i, v });
    return acc;
  }, []).filter((r) => r.v).map((r) => `${WD[r.from]}${r.to > r.from ? `–${WD[r.to]}` : ""} ${r.v}`);
  function renderFacts(id, f) {
    if (openId !== id || !f) return;
    // на справочники (Zoon, Yell) ссылок не даём — только сайт самой бани и карты
    const own = (u) => (u && !/(^|\.)(zoon|yell)\.ru$/i.test(u.replace(/^https?:\/\//, "").split("/")[0]) ? u : null);
    const site = own(f.website), src = own(f.price_src);
    const when = /^\d{4}-\d{2}-\d{2}$/.test(f.run || "") ? new Date(f.run + "T12:00:00").toLocaleDateString("ru-RU", { month: "long", year: "numeric" }).replace(" г.", "") : "";
    const tidy = (t) => String(t || "").replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();   // пояснения агента в скобках — не людям
    if (f.address && $("#dWhereTxt")) $("#dWhereTxt").textContent = f.address;   // адрес вместо «Москва, Россия»
    const box = $("#dInfo");
    if (box) {
      const gender = tidy(f.gender_days);
      const tags = [...new Set([...(f.sections || []), ...(f.amenities || [])].map((x) => String(x).trim()).filter(Boolean))].slice(0, 10);
      box.innerHTML = (gender ? `<p>${icon("users")}<span class="d-clamp">${esc(gender)}</span></p>` : "")
        + (tags.length ? `<div class="d-tags">${tags.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : "");
      box.title = `По картам и сайту бани, проверила Комиссия${when ? ` · ${when}` : ""}`;
      $("#dAbout").hidden = !box.innerHTML && $("#dIdx").hidden;
      // карты и сайт — кнопками под «О бане»; на справочники (Zoon, Yell) не ведём
      if (own(f.yandex_url)) $("#dYa").href = own(f.yandex_url);
      if (own(f.twogis_url)) $("#dGis").href = own(f.twogis_url);
      if (site) { $("#dSite").href = site; $("#dSite").hidden = false; }
      // телефон из сверки (05.11): «Позвонить» — первый номер, под кнопками — все как есть
      const tel = String(f.phone || "").split(/[,;]/)[0].replace(/[^\d+]/g, "");
      if (tel.length >= 6) { $("#dCall").href = "tel:" + tel; $("#dCall").hidden = false; $("#dPhone").textContent = String(f.phone).replace(/\s+/g, " ").trim(); $("#dPhone").hidden = false; }
    }
    syncHours(id);
    // цена с сайта: первая — крупно, остальные варианты — под «ещё», откуда — подписью
    const ps = $("#dPriceSite");
    if (f.price && ps) {
      // в портал — только вход: кабины, аренду, номера, VIP, срубы «на 6 мест» агенты тоже записывали (22400 ₽ за кабину, 19.10)
      const notEntry = /кабин|аренд|номер|\bvip\b|\bвип\b|на \d+(?:\s*[–—-]\s*\d+)?\s*(?:мест|чел|гост|персон)|до \d+\s*(?:чел|гост)|за компани|сруб|беседк/i;
      const [main, ...rest] = tidy(f.price).split(/\s*;\s*/).filter((x) => x && !notEntry.test(x));
      const bold = (t) => esc(t).replace(/^([\d\s]+(?:[.,]\d+)?\s*(?:₽|руб\.?|€|\$|¥|BYN|₸))/, "<b>$1</b>");
      if (!main) return;   // осталась только аренда — цены входа с сайта нет, блок не показываем
      ps.innerHTML = `<p class="ps-main">${bold(main)}</p>
        ${rest.length ? `<details class="ps-more"><summary>ещё ${rest.length} ${plural(rest.length, "вариант", "варианта", "вариантов")}</summary>${rest.map((r) => `<p>${bold(r)}</p>`).join("")}</details>` : ""}
        <small>по сайту бани${when ? `, ${when}` : ""}${src ? ` · <a href="${esc(src)}" target="_blank" rel="noopener">откуда</a>` : ""}</small>`;
      ps.hidden = false;
      if ($("#dPriceNone")) $("#dPriceNone").hidden = true;
      if ($("#dPriceV")?.textContent === "—") {
        const m = main.match(/^[\d\s]+(?:[.,]\d+)?\s*(?:₽|руб\.?|€|\$|¥|BYN|₸)/);
        if (m) { $("#dPriceV").textContent = m[0].replace(/руб\.?/, "₽").trim(); $("#dPriceSub").textContent = "по сайту бани"; }
      }
    }
  }
  // «Сегодня» в главном блоке: часы работы (участники новее сверки) и ближайший пар; по нажатию — вся неделя
  function syncToday(id) {
    if (openId !== id || !$("#dToday")) return;
    const sc = schedNow.get(id), f = factNow.get(id), byDay = hoursByDay(f?.hours), wd = (new Date().getDay() + 6) % 7;
    const h = sc?.hours, today = h ? (h.open === h.close ? "круглосуточно" : `${h.open}–${h.close}`) : byDay ? byDay[wd] || "не работает" : null;
    const ts = sc?.steam?.times || [], now = mskNow().slice(11, 16), next = ts.find((t) => t > now);
    $("#dTodayV").textContent = today ? today.replace(/(^|[–\s])0(\d:)/g, "$1$2") : "—";
    $("#dTodaySub").textContent = next ? `пар в ${next}` : ts.length ? "пары кончились" : today ? "пары не указали" : "часы не указали";   // мужские и женские дни — в «О бане»
    $("#dTodaySub").classList.toggle("steam", !!next);
    const week = [h ? `${h.open === h.close ? "круглосуточно" : `ежедневно ${h.open}–${h.close}`}` : byDay ? hoursRows(byDay).map(esc).join("<br>") : f?.hours ? esc(f.hours) : "",
      ts.length ? `пары: ${ts.join(" · ")}` : "", f?.gender_days ? esc(String(f.gender_days).replace(/\s*\([^)]*\)/g, "")) : ""].filter(Boolean);
    $("#dWeek").innerHTML = week.map((x) => `<p>${x}</p>`).join("");
    $("#dToday").classList.toggle("has-more", week.length > 0);
  }
  // «Пары и часы работы» (05.11): что внесли участники, а часов нет — часы с сайта бани по дням; «Пока никто не указал» —
  // только если не знаем ни того, ни другого (сверху в «Сегодня» стояли часы, а внизу — «никто не указал»)
  function renderSchedule(id) {
    const box = $("#dSched");
    if (openId !== id || !box) return;
    const sc = schedNow.get(id), f = factNow.get(id), st = sc?.steam, h = sc?.hours, ts = st?.times || [];
    // «каждый час с 14:00 до 22:00», если ровно так и вносили; иначе — все пары списком
    const even = st?.every_min && ts.length > 1 && steamTimes(ts[0], ts[ts.length - 1], st.every_min).join() === ts.join();
    const steam = !st ? "" : even
      ? `${st.every_min === 60 ? "каждый час" : "каждые два часа"} с ${ts[0]} до ${ts[ts.length - 1]}`
      : ts.join(" · ");
    const at = (x) => `<small>${dayLabel(mskIso(x.at))}</small>`;
    const byDay = !h && hoursByDay(f?.hours);
    // с сайта: дни — строками, остальное без часов («третий понедельник — санитарный день») — подписью
    const notes = !h && f?.hours ? String(f.hours).replace(/\s*\([^)]*\)/g, "").split(/\s*;\s*/).filter((x) => x && !/\d{1,2}:\d{2}|круглосуточно/i.test(x)) : [];
    const when = /^\d{4}-\d{2}-\d{2}$/.test(f?.run || "") ? new Date(f.run + "T12:00:00").toLocaleDateString("ru-RU", { month: "long", year: "numeric" }).replace(" г.", "") : "";
    const site = byDay ? `<div class="sh-days">${hoursRows(byDay).map((r) => { const [d, ...t] = r.split(" "); return `<span>${esc(d)}</span><b>${esc(t.join(" ").replace(/(^|[–\s])0(\d:)/g, "$1$2"))}</b>`; }).join("")}</div>`
      : !h && f?.hours ? `<p class="sh-txt">${esc(String(f.hours).replace(/\s*\([^)]*\)/g, ""))}</p>` : "";
    if (!st && !h && !site) return;   // ничего не знаем — остаётся «Пока никто не указал»
    box.innerHTML = (st ? `<p><span>♨️ <b>Пары</b> ${esc(steam)}</span>${at(st)}</p>` : "")
      + (h ? `<p><span>${icon("clock")} <b>Работает</b> ${h.open === h.close ? "круглосуточно" : `${esc(h.open)}–${esc(h.close)}`}${member ? ` <button type="button" class="linkbtn" data-hedit>изменить</button>` : ""}</span>${at(h)}</p>` : "")
      + site
      + (site ? `<p class="sh-src">${notes.map((x) => esc(x) + "<br>").join("")}по сайту бани${when ? `, ${when}` : ""}${st ? "" : " · пары пока никто не указал"}</p>` : "");
    $("[data-hedit]", box)?.addEventListener("click", () => editHours(id));
    syncHours(id);
  }
  // часы работы уже известны — из сверки (Яндекс, сайт бани) или от участника: в форме их не спрашиваем, только «изменить» (28.10)
  const schedNow = new Map(), factNow = new Map();   // что уже пришло: промисы из кэшей синхронно не прочитать
  const known = (m, id, k) => !!m.get(id)?.[k];
  const hoursKnown = (id) => known(schedNow, id, "hours") || known(factNow, id, "hours");
  function syncHours(id) {
    if (openId !== id) return;
    const has = hoursKnown(id), editing = cardOpen.has("shh");
    const box = $("#shHours"), btn = $("#shHoursEdit"), add = $("#shOpen");
    if (box) box.hidden = has && !editing;
    if (btn) btn.hidden = !has || editing;
    if (add) add.textContent = "+ Указать пары" + (has ? "" : " и часы");
    // свои часы участников новее сверки — часы из сверки не показываем, чтобы не было двух разных
    const row = $("#dHoursRow"); if (row) row.hidden = known(schedNow, id, "hours");
  }
  function editHours(id) {
    cardOpen.add("sh"); cardOpen.add("shh");
    const f = $("#shForm"); if (!f) return;
    f.hidden = false; if ($("#shOpen")) $("#shOpen").hidden = true;
    const h = schedNow.get(id)?.hours;
    if (h && !$("#shOpenT").value) { $("#shOpenT").value = h.open; $("#shCloseT").value = h.close; }
    syncHours(id); $("#shOpenT").focus();
  }
  let cardFor = null;
  const cardOpen = new Set();   // раскрытые формы карточки («pr», «rv», «sh», «shh» — поля часов работы) — до перехода к другой бане
  // время пар и часов работы — только :00 и :30 (28.10): других минут на деле не бывает, а выбрать из списка быстрее
  const timeOpts = `<option value="">—</option>` + Array.from({ length: 48 }, (_, i) => {
    const t = String(i >> 1).padStart(2, "0") + (i % 2 ? ":30" : ":00"); return `<option value="${t}">${t}</option>`;
  }).join("");
  const schedCache = new Map();   // пары и часы бани — просим при открытии карточки
  function renderPhotos(id, ps) {
    const box = $("#dPhotos"); if (!box || openId !== id || !ps.length) return;
    box.innerHTML = `<div class="ph-strip">${ps.map((p, i) => {
      const first = i === 0 || ps[i - 1].visitId !== p.visitId;
      return `<button type="button" class="ph${first && i ? " gap" : ""}" data-ph="${i}" style="aspect-ratio: ${p.w || 4} / ${p.h || 3}" aria-label="Фото ${i + 1} из ${ps.length}"><img src="${esc(p.thumb)}" alt="" loading="lazy">${first ? `<span>${dayLabel(p.date)}</span>` : ""}</button>`;
    }).join("")}</div>`;
    box.hidden = false;
    $$("[data-ph]", box).forEach((x) => (x.onclick = () => openPhotos(ps, +x.dataset.ph)));
  }
  // просмотр во весь экран: стрелки и свайп; Esc и тап мимо закрывают, как любое окно
  let pv = { list: [], i: 0 };
  function openPhotos(list, i) { pv = { list, i }; showPhoto(); $("#photoModal").hidden = false; }
  function showPhoto() {
    const p = pv.list[pv.i]; if (!p) return;
    $("#pvImg").src = p.src;
    $("#pvCap").textContent = `${pv.i + 1} / ${pv.list.length} · ${dayLabel(p.date)}`;
    $("#pvPrev").hidden = pv.i === 0; $("#pvNext").hidden = pv.i === pv.list.length - 1;
  }
  const stepPhoto = (step) => { const n = pv.i + step; if (n >= 0 && n < pv.list.length) { pv.i = n; showPhoto(); } };
  $("#pvPrev").onclick = () => stepPhoto(-1);
  $("#pvNext").onclick = () => stepPhoto(1);
  $("#photoModal .pv").addEventListener("click", (e) => { if (e.target === e.currentTarget) $("#photoModal").hidden = true; });
  document.addEventListener("keydown", (e) => {
    if ($("#photoModal").hidden) return;
    if (e.key === "ArrowLeft") stepPhoto(-1); else if (e.key === "ArrowRight") stepPhoto(1);
  });
  let touchX = null;
  $("#photoModal").addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
  $("#photoModal").addEventListener("touchend", (e) => {
    if (touchX == null) return;
    const dx = e.changedTouches[0].clientX - touchX; touchX = null;
    if (Math.abs(dx) > 40) stepPhoto(dx < 0 ? 1 : -1);
  });

  // фото к походу с сайта: браузер уменьшает снимок — до 1600 px и превью 400 px — и кладёт прямо в хранилище Яндекса;
  // canvas заодно стирает метаданные снимка, в том числе GPS. Не открылось (HEIC на компьютере, не картинка) — пропускаем
  async function shrink(file, max) {
    const img = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    img.close?.();
    const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.85));
    if (!blob) throw new Error("не сжалось");
    return { blob, w: c.width, h: c.height };
  }
  // ---------- рейтинг бани (01.11): восемь пунктов по 1–5 веников, общая — среднее; оценивает тот, кто был в походе ----------
  // Ссылку на оценку похода (#rate=<поход>) присылает бот после «засчитано». В карточке — общая, число оценок и по пунктам;
  // средняя по старым отзывам больше не показывается (рейтинг начали с нуля, отзывы остались)
  const CRIT = [["stove", "Печь"], ["steam", "Пар"], ["aqua", "Аквазона"], ["outdoor", "Выход на улицу"], ["kitchen", "Кухня"],
    ["atmosphere", "Атмосфера"], ["service", "Сервис"], ["prices", "Цены"]];
  let ratings = {};
  // главная цифра бани — крупно, за ней веник-оценка (02.11, макет карточки); под ней — восемь пунктов
  const rateTile = (id) => { const r = ratings[id];
    return `<span class="k-l">Оценка</span>` + (r ? `<b class="k-rate" aria-label="Оценка лиги ${fmt(+r.overall)} из 5">${fmt(+r.overall)}${fanSvg(+r.overall)}</b><small>${r.n} ${plural(r.n, "оценка", "оценки", "оценок")}</small>`
      : "<b>—</b><small>нет оценок</small>"); };
  const rateRows = (id) => { const r = ratings[id]; if (!r) return "";
    return CRIT.map(([k, t]) => `<div><span>${t}</span><b>${fmt(+r[k])}</b><i style="--w:${(+r[k] / 5) * 100}%;--c:${+r[k] >= 4.5 ? "var(--oak)" : +r[k] >= 4 ? "color-mix(in srgb, var(--oak) 70%, var(--panel))" : "color-mix(in srgb, var(--oak) 40%, var(--panel))"}"></i></div>`).join(""); };
  // «Ты тут был … · Оцени баню — 1 минута» (01.11, вариант Б): участнику, который был в бане (любой поход — с портала или
  // из таблицы) и ещё её не оценивал; ведёт на лёгкую страницу оценки по бане. Дата — последнего похода с портала, иначе год
  let myRated = null;   // null — ещё не знаем, кто что оценил: приглашение не показываем
  function rateInvite(id) {
    if (!D.live || !myNick || !myRated || myRated.has(id)) return "";
    const b = byId.get(id);
    const mine = visits.filter((v) => v.bathId === id && v.status === "ok" && (v.player === myNick || v.companions.includes(myNick)))
      .map((v) => v.date).sort().pop();
    // походы 2026 из таблицы лежат в v26, прошлых лет — в histBy
    const year = b?.v26?.[myNick] > 0 ? "2026" : Object.keys(b?.histBy || {}).filter((y) => b.histBy[y]?.[myNick] > 0).sort().pop();
    if (!mine && !year) return "";
    const when = mine ? (["сегодня", "вчера"].includes(dayLabel(mine)) ? dayLabel(mine)
      : new Date(mine.slice(0, 10) + "T00:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })) : `в ${year}`;
    return `<a class="rate-invite" href="rate.html?b=${id}"><span><b>Ты тут был ${esc(when)}</b><small>Оцени баню — 1 минута</small></span><span class="go">Оценить</span></a>`;
  }
  if (D.live && myNick) D.myRatedBaths().then((ids) => {
    myRated = new Set(ids.map(Number));
    if (openId && $("#dRateInvite")) $("#dRateInvite").innerHTML = rateInvite(openId);
  }).catch(() => {});
  function loadRatings() {
    return D.bathRatings().then((r) => {
      ratings = r || {};
      if (sortBy === "rating") render();   // оценки пришли позже списка
      if (openId && $("#dRateTile")) { $("#dRateTile").innerHTML = rateTile(openId); const box = $("#dRating"); box.innerHTML = rateRows(openId); box.hidden = !ratings[openId]; }
    }).catch(() => {});
  }
  async function uploadPhotos(visitId, bathId, files) {
    files = files.slice(0, 10);
    const items = [];
    for (const f of files) {
      try { items.push({ big: await shrink(f, 1600), small: await shrink(f, 400) }); } catch { /* не открылось — пропускаем */ }
    }
    if (!items.length) return toast("Фото не открылись — нужен JPEG или PNG (HEIC браузер на компьютере не читает)");
    toast(`📷 Загружаю фото: 0 из ${items.length}…`);
    try {
      const n = await D.uploadPhotos(visitId, items, (i) => toast(`📷 Загружаю фото: ${i} из ${items.length}…`));
      photoCache.delete(bathId);
      if (openId === bathId) openBath(bathId);
      const skipped = files.length - items.length;
      toast(n === files.length ? `📷 Фото добавлены: ${n}` : `📷 Добавлено ${n} из ${files.length}${skipped ? " — часть не открылась" : " — остальные не загрузились"}`);
    } catch (err) { toast("Фото не загрузились: " + err.message); }
  }
  // «📷 Фото» у своего похода в ленте — выбор файлов и загрузка
  const inVisit = (v) => !!myNick && (v.player === myNick || v.companions.includes(myNick) || v.enteredBy === myNick);
  function pickPhotos(v) {
    if (!v) return;
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.multiple = true;
    inp.onchange = () => inp.files.length && uploadPhotos(v.id, v.bathId, [...inp.files]);
    inp.click();
  }

  // ссылка на баню (30.10, Леха): ebl.su/#bath=<номер> открывает карту с её карточкой. На телефоне — меню «Поделиться»
  // системы, на компьютере — в буфер обмена
  const bathUrl = (id) => `${location.origin}${location.pathname}#bath=${id}`;
  async function shareBath(id) {
    const b = byId.get(id), url = bathUrl(id);
    if (navigator.share && phone.matches) {
      try { await navigator.share({ title: b?.name, text: `${b?.name} — на карте ЕБЛ`, url }); return; }
      catch (e) { if (e?.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); toast("Ссылка на баню скопирована"); }
    catch { toast(url); }
  }

  // индекс общественности (05.11): полоска 0–100 и что он значит; у бани лиги — строкой в «О бане», если его посчитали
  const idxMeter = (v, big) => `<div class="idx${big ? " big" : ""}"><div class="idx-top"><span>Индекс общественности</span><b>${v}</b></div>
    <div class="idx-bar"><i style="width:${v}%"></i></div><small>${idxCat(v)} — по картам, сайтам и отзывам</small></div>`;
  function syncIndex(id) {
    const v = radarPub?.index?.[id], box = $("#dIdx");
    if (openId !== id || !box || v == null) return;
    box.innerHTML = idxMeter(v); box.hidden = false; $("#dAbout").hidden = false;
  }
  // карточка места с карты, где лига не была: индекс, цена, что даст первый поход, ссылки и «Отметить поход»
  function openRadar(pid, fly) {
    const p = radarPub?.places.find((x) => x.id === pid); if (!p) return;
    const d = $("#drawer");
    if (d.hidden) pushStep({ type: "bath" });
    openId = null; selectPin(); $$(".item.active").forEach((x) => x.classList.remove("active"));
    $(`.item[data-radar-id="${pid}"]`)?.classList.add("active");
    if (fly) { const z = Math.max(map.getZoom(), 14); map.flyTo(aboveCard([p.lat, p.lng], z), z, { duration: calm ? 0 : 0.7 }); }
    else if (phone.matches) map.panTo(aboveCard([p.lat, p.lng], map.getZoom()), { animate: !calm });
    const q = encodeURIComponent(`${p.name} ${p.city || ""}`.trim());
    const facts = [p.gender && "мужское и женское отделения", p.ticket && "билет на человека"].filter(Boolean);
    // вход — только число с валютой из примера цены («от 293 ₽»), а не текст агента; город — к адресу, если его там нет
    const price = String(p.price || "").match(/(?:от\s*)?\d[\d\s]*(?:[.,]\d+)?\s*(?:₽|руб\.?|р\.)/i)?.[0].replace(/руб\.?|р\./i, "₽").replace(/\s+/g, " ").trim();
    const addr = p.address && p.city && !p.address.includes(p.city) ? `${p.city}, ${p.address}` : p.address || [p.city, p.region].filter(Boolean).join(", ");
    d.innerHTML = `
      <button type="button" class="grab d-grab" aria-label="Развернуть карточку на весь экран"><i></i></button>
      <button class="x" aria-label="Закрыть">${icon("close")}</button>
      <div class="d-body">
        <div class="d-hero t-public">
          <div class="d-meta"><span class="t">${tdot("public")}${TYPE_LABEL.public}</span><span class="flag uu-flag">✦ никто из лиги не был</span></div>
          <h2>${esc(p.name)}</h2>
          <p class="where">${icon("pin")}<span>${esc(addr)}</span></p>
        </div>
        <section class="d-main">
          ${idxMeter(p.index, true)}
          ${facts.length ? `<p class="hint" style="margin:8px 2px 0">${facts.join(" · ")}</p>` : ""}
          <div class="d-key two">
            <div class="d-k"><span class="k-l">Вход</span><b>${price ? esc(price) : "—"}</b><small>${price ? "по картам и отзывам" : "пока не знаем"}</small></div>
            <div class="d-k uu-pts"><span class="k-l">Первый поход</span><b>+4 очка</b><small>поход, уникальная, ультра, общественная</small></div>
          </div>
        </section>
        ${p.note ? `<p class="d-note">${esc(p.note)}</p>` : ""}
        <button type="button" class="cta d-go" id="dRadarGo">${icon("plus")}<span>Отметить поход</span></button>
        <div class="d-acts">
          <a target="_blank" rel="noopener" href="https://yandex.ru/maps/?pt=${p.lng},${p.lat}&z=17&text=${q}">${icon("pin")}<span>Яндекс</span></a>
          <a target="_blank" rel="noopener" href="${/2gis\./.test(p.mapUrl || "") ? esc(p.mapUrl) : `https://2gis.ru/geo/${p.lng},${p.lat}`}">${icon("map")}<span>2ГИС</span></a>
          ${p.website ? `<a target="_blank" rel="noopener" href="${esc(p.website)}">${icon("globe")}<span>Сайт</span></a>` : ""}
        </div>
      </div>`;
    d.hidden = false;
    $(".x", d).onclick = closeBath;
    $("#dRadarGo", d).onclick = async () => {
      if (D.live && !me) return openLogin();
      if (D.live && !me.nick) return openClaim();
      const go = $("#dRadarGo"); go.disabled = true;
      try {
        const bid = await D.radarToBath(pid);
        radarPub.places = radarPub.places.filter((x) => x.id !== pid); radarPub.index[bid] = p.index;
        await refreshData(); closeBath(); render(); openVisit({ bathId: bid });
      } catch (err) { go.disabled = false; toast("Не получилось: " + err.message); }
    };
  }
  function closeBath() {
    const d = $("#drawer");
    if (location.hash.startsWith("#bath=")) history.replaceState(history.state, "", "#map");
    d.hidden = true; d.classList.remove("full", "dragging"); d.style.removeProperty("transform");
    openId = null; selectPin(); $$(".item.active").forEach((x) => x.classList.remove("active"));
  }
  map.on("click", () => { if (!$("#drawer").hidden) closeBath(); });   // тап по пустому месту карты закрывает карточку (18.10)
  // карточка бани на телефоне (18.10) — как шторка на карте: смахнул вниз — закрыл (из «на весь экран» — сначала обратно),
  // потянул вверх — на весь экран. Вниз тянется, только когда карточка пролистана к началу, иначе листается сама
  (() => {
    const d = $("#drawer");
    let t = null;
    d.addEventListener("touchstart", (e) => {
      if (!phone.matches || e.touches.length !== 1) return;
      const body = $(".d-body", d);
      if (body && body.scrollTop > 0 && !e.target.closest(".d-grab")) return;
      t = { x: e.touches[0].clientX, y: e.touches[0].clientY, dy: 0, mode: null, t0: e.timeStamp };
    }, { passive: true });
    d.addEventListener("touchmove", (e) => {
      if (!t) return;
      const dx = e.touches[0].clientX - t.x, dy = e.touches[0].clientY - t.y;
      if (!t.mode) {
        if (Math.abs(dx) > Math.abs(dy)) { t = null; return; }
        if (dy > 0) t.mode = "down";
        else if (!d.classList.contains("full")) t.mode = "up";
        else { t = null; return; }   // на весь экран и вверх — листаем содержимое
        d.classList.add("dragging");
      }
      e.preventDefault();
      t.dy = dy;
      d.style.transform = `translateY(${t.mode === "down" ? dy : Math.max(dy, -40) / 3}px)`;
    }, { passive: false });
    const end = (e) => {
      const g = t; t = null;
      if (!g?.mode) return;
      d.classList.remove("dragging"); d.style.removeProperty("transform");
      const fast = g.dy / Math.max(1, e.timeStamp - g.t0) > 0.6;
      if (g.mode === "up") { if (g.dy < -30) d.classList.add("full"); return; }
      if (d.classList.contains("full") && g.dy < 260) { if (g.dy > 60 || fast) d.classList.remove("full"); return; }
      if (g.dy > 110 || fast) closeBath();
    };
    d.addEventListener("touchend", end);
    d.addEventListener("touchcancel", end);
  })();

  // ---------- таблица ----------
  let sortKey = "total", sortDir = -1;
  // столбцы словами, расшифровка — подсказкой у заголовка (04.11: «У», «УУ», «Дл» никто не понимал, а легенду внизу не читали)
  const COLS = [["baths", "Бань", "Засчитанные походы за сезон"], ["u", "Уник.", "Уникальные: баня первая в этом году для тебя, +1"],
    ["uu", "Ультра", "Ультрауникальные: в бане никто из лиги не был с 2023 года, +1"], ["long", "Долгие", "Долгие походы, больше 150 минут, +1"],
    ["k", "Компания", "За компанию: от 3 участников в одни сутки, +1…+3"], ["pub", "Общ.", "Общественные бани, +1 за каждую"],
    ["reg", "Регионы", "Новые регионы и страны, +1 за каждый"]];
  function spark(s) {
    const weeks = Array.from({ length: 12 }, (_, i) => curWeek - 12 + i).filter((w) => w >= 1);
    const vals = weeks.map((w) => s.weekPts[w] ?? 0);
    const W = 96, H = 24, step = W / (vals.length - 1 || 1);
    const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - 3 - (v / 15) * (H - 6)).toFixed(1)}`);
    const [lx, ly] = pts[pts.length - 1].split(",");
    return `<svg class="spark" width="${W}" height="${H}" viewBox="-3 0 ${W + 6} ${H}" aria-label="очки за места, последние 12 недель"><polygon points="0,${H} ${pts.join(" ")} ${W},${H}" fill="var(--oak-soft)"/><polyline points="${pts.join(" ")}" fill="none" stroke="var(--oak)" stroke-width="1.6" stroke-linejoin="round"/><circle cx="${lx}" cy="${ly}" r="3" fill="var(--ember)"/></svg>`;
  }
  const ranked = [];
  // места, короны (победы в закрытых неделях; ничья за первое — корона каждому), шапка и пьедестал — из standings
  function rankTable() {
    ranked.splice(0, ranked.length, ...[...standings].sort((a, b) => b.total - a.total || b.baths - a.baths).map((s, i) => ({ ...s, place: i + 1 })));
    const crowns = {};
    for (let w = 1; w < curWeek; w++) for (const r of weekRows(w)) if (r.place === 1) crowns[r.name] = (crowns[r.name] || 0) + 1;
    ranked.forEach((s) => (s.crowns = crowns[s.name] || 0));
    // движение ▲▼ (04.11): место сейчас против места с прошлого воскресенья — по очкам без набранных за неделю (week_gain)
    const was = [...ranked].sort((a, b) => b.total - (b.weekGain || 0) - (a.total - (a.weekGain || 0)) || a.place - b.place);
    const moved = ranked.some((s) => s.weekGain);
    was.forEach((s, i) => (s.move = moved ? i + 1 - s.place : 0));
    const playedWeeks = Math.max(0, ...standings.flatMap((s) => Object.keys(s.weekPts || {}).map(Number)));
    // на телефоне вместо «разыграно…» — сколько до конца недели: отдельной плашки таймера там нет
    $("#tableEyebrow").innerHTML = `<span>Сезон 2026<span class="eb-played"> · разыграно <b>${playedWeeks}</b> ${plural(playedWeeks, "неделя", "недели", "недель")}</span>`
      + `<span class="eb-left"> · W${curWeek} · ещё <b>${timeLeft()}</b></span></span>`;
    // в начале сезона (или на пустой базе) участников может быть меньше трёх — пьедестал без пустых ступеней
    $("#podium").innerHTML = [ranked[1], ranked[0], ranked[2]].filter(Boolean).map((s) => `
      <button class="pod p${s.place}" data-player="${esc(s.name)}">
        ${ava(s.name, "xl")}
        <span class="pod-name">${esc(s.name)}</span>
        <span class="pod-pts"><b>${fmt(s.total)}</b> <small>${plural(s.total, "очко", "очка", "очков")}</small></span>
        <span class="pod-step">${s.place}</span>
      </button>`).join("");
  }
  rankTable();
  const renderTimer = () => {
    $("#tableTimer").innerHTML = `${icon("clock")}до конца W${curWeek} <b>${timeLeft()}</b>`;
    const left = $("#tableEyebrow .eb-left b"); if (left) left.textContent = timeLeft();
  };
  renderTimer();
  // движение за неделю — под местом (04.11, отзыв: отдельный столбец почти пустой); без движения — ничего
  const moveMark = (m) => (m > 0 ? `<small class="up" title="За неделю поднялся на ${m}">▲${m}</small>` : m < 0 ? `<small class="down" title="За неделю опустился на ${-m}">▼${-m}</small>` : "");
  const NCOLS = COLS.length + 5;
  function renderTable() {
    const rows = [...ranked].sort((a, b) => sortDir * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) || a.place - b.place);
    const byTotal = sortKey === "total" && sortDir < 0, mine = D.live ? me?.nick : null;
    const th = (k, l, cls = "", tip = "") => `<th data-k="${k}" class="${cls} ${k === sortKey ? "on" : ""}"${tip ? ` data-tip="${esc(tip)}"` : ""}><span>${l}${k === sortKey ? (sortDir < 0 ? " ↓" : " ↑") : ""}</span></th>`;
    $("#standings").innerHTML = `
      <thead><tr>${th("place", "#")}<th class="l">Участник</th>${th("crowns", `<svg class="hat-ic" aria-hidden="true"><use href="#i-banhat"/></svg>`, "crown-col", "Победы в неделях")}${th("total", "Очки")}${COLS.map(([k, l, t]) => th(k, l, "st", t)).join("")}<th class="l st">12 недель</th></tr></thead>
      <tbody>${rows.map((s, i) => `<tr data-player="${esc(s.name)}" class="${s.place <= 3 ? "top3" : ""}${byTotal && s.place > 16 ? " below" : ""}${s.name === mine ? " me" : ""}">
        <td class="pos">${s.place}${moveMark(s.move)}</td>
        <td class="l who-cell"><span>${ava(s.name, "sm")}<span class="who-t"><b>${esc(s.name)}</b>${s.name === mine ? '<i class="me-tag">это ты</i>' : ""}</span></span></td>
        <td class="crowns" title="${s.crowns ? `Выиграл ${s.crowns} ${plural(s.crowns, "неделю", "недели", "недель")}` : "Пока без побед в неделях"}">${s.crowns ? `<svg class="hat-ic" aria-hidden="true"><use href="#i-banhat"/></svg><b>${s.crowns}</b>` : ""}</td>
        <td class="pts">${fmt(s.total)}</td>
        ${COLS.map(([k]) => `<td class="st">${s[k] ?? 0}</td>`).join("")}
        <td class="l st">${spark(s)}</td></tr>`
        + (byTotal && s.place === 16 && rows.length > 16 ? `<tr class="cupline" aria-hidden="true"><td colspan="${NCOLS}"><span>Кубок ЕБЛ · первые 16</span></td></tr>` : "")).join("")}
</tbody>`;
  }
  // ---------- недельный зачёт: как лист «недельный зачёт» у Комиссии ----------
  // W1 — с 1 января до первого воскресенья, дальше пн–вс (п. 6)
  function weekRange(w) {
    const jan1 = new Date(Date.UTC(2026, 0, 1)), firstMon = new Date(jan1);
    firstMon.setUTCDate(1 + ((8 - jan1.getUTCDay()) % 7));
    const start = w === 1 ? jan1 : new Date(firstMon.getTime() + (w - 2) * 7 * 864e5);
    const end = w === 1 ? new Date(firstMon.getTime() - 864e5) : new Date(start.getTime() + 6 * 864e5);
    const d = (x, m) => x.toLocaleDateString("ru-RU", { day: "numeric", ...(m ? { month: "long" } : {}), timeZone: "UTC" });
    return start.getUTCMonth() === end.getUTCMonth() ? `${d(start)}–${d(end, true)}` : `${d(start, true)} — ${d(end, true)}`;
  }
  // места недели: у закрытой — из таблицы, у идущей — «если закончится сейчас»
  function weekRows(w) {
    const rows = standings.map((s) => [s.name, s.weekBaths[w] ?? 0]).filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
    const live = w >= curWeek, proj = live ? placePoints(rows) : {};
    let place = 0, prev = null;
    return rows.map(([n, c], i) => {
      if (c !== prev) { place = i + 1; prev = c; }
      const s = standings.find((x) => x.name === n);
      return { name: n, baths: c, place, pts: live ? proj[n] : s.weekPts[w] ?? 0 };
    });
  }
  let viewWeek = curWeek;
  function renderWeek() {
    const live = viewWeek >= curWeek, rows = weekRows(viewWeek);
    $("#wTitle").innerHTML = `<b>W${viewWeek}</b><span>${weekRange(viewWeek)}${live ? ` · идёт, до конца ${timeLeft()}` : " · итоги"}</span>`;
    $("#wPrev").disabled = viewWeek <= 1; $("#wNext").disabled = viewWeek >= curWeek;
    // пьедестал недели: ступени по порядку мест, на ступени — настоящее место (при ничьей у двоих может быть «1»)
    const podRow = (r, pos) => {
      if (!r) return `<div class="pod p${pos} vacant" aria-hidden="true"><span class="pod-step">${pos}</span></div>`;   // не .empty — это заглушка «пусто» с фоном и тенью
      const more = pos === 3 ? rows.filter((x, j) => j > 2 && x.place === r.place).length : 0;
      return `<button class="pod p${pos}" data-player="${esc(r.name)}">
        ${ava(r.name, "xl")}
        <span class="pod-name">${esc(r.name)}${more ? `<small>и ещё ${more}</small>` : ""}</span>
        <span class="pod-pts"><b>${r.baths}</b> ${plural(r.baths, "баня", "бани", "бань")}${r.pts ? ` · <span class="pod-plus">+${fmt(r.pts)}</span>` : ""}</span>
        <span class="pod-step">${r.place}</span>
      </button>`;
    };
    $("#weekPodium").innerHTML = rows.length ? [podRow(rows[1], 2), podRow(rows[0], 1), podRow(rows[2], 3)].join("") : "";
    $("#weekPodium").hidden = !rows.length;
    $("#weekTable").innerHTML = rows.length ? `
      <thead><tr><th>#</th><th class="l">Участник</th><th>Бань</th><th>${live ? "Будет<span class=\"wide-only\"> за место</span>" : "За место"}</th></tr></thead>
      <tbody>${rows.map((r) => `<tr data-player="${esc(r.name)}" class="${r.place <= 3 ? "top3 p" + r.place : ""}">
        <td class="pos">${r.place <= 3 ? ["🥇", "🥈", "🥉"][r.place - 1] : r.place}</td>
        <td class="l who-cell"><span>${ava(r.name, "sm")}${esc(r.name)}</span></td>
        <td class="pts">${r.baths}</td>
        <td class="wk-pts">${r.pts ? "+" + fmt(r.pts) : "—"}</td></tr>`).join("")}</tbody>`
      : `<tbody><tr><td class="l" style="padding:22px">${live ? "На этой неделе пока никто не парился. Самое время." : "На этой неделе никто не парился — неделя не разыгрывалась."}</td></tr></tbody>`;
    $("#wNote").textContent = live
      ? "Очки за место начислятся после воскресенья 22:59 МСК. Поделили место — делят и очки (п. 7)."
      : `Всего за неделю: ${rows.reduce((a, r) => a + r.baths, 0)} ${plural(rows.reduce((a, r) => a + r.baths, 0), "баня", "бани", "бань")}.`;
    renderWeekGrid();
  }
  function renderWeekGrid() {
    const weeks = Array.from({ length: curWeek }, (_, i) => curWeek - i);   // свежие недели слева
    const placeOf = {};
    for (const w of weeks) for (const r of weekRows(w)) (placeOf[w] ||= {})[r.name] = r.place;
    const wins = (n) => weeks.filter((w) => w < curWeek && placeOf[w]?.[n] === 1).length;
    const rows = [...ranked].filter((s) => weeks.some((w) => s.weekBaths[w])).sort((a, b) => wins(b.name) - wins(a.name) || a.place - b.place);
    $("#weekGrid").innerHTML = `
      <thead><tr><th class="l">Участник</th><th title="Побед в неделях"><svg class="hat-ic" aria-hidden="true"><use href="#i-banhat"/></svg></th>${weeks.map((w) => `<th data-w="${w}" class="${w === viewWeek ? "on" : ""}">W${w}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((s) => `<tr data-player="${esc(s.name)}"><td class="l who-cell"><span>${ava(s.name, "sm")}${esc(s.name)}</span></td><td class="wins">${wins(s.name) || ""}</td>
        ${weeks.map((w) => { const b = s.weekBaths[w] ?? 0, p = placeOf[w]?.[s.name];
          return `<td class="${b ? (p <= 3 ? "c p" + p : "c") : "z"} ${w === viewWeek ? "on" : ""}" title="W${w}: ${b} ${plural(b, "баня", "бани", "бань")}${p ? `, ${p} место` : ""}">${b || ""}</td>`; }).join("")}</tr>`).join("")}</tbody>`;
  }
  function setTableMode(m) {
    $$("#tMode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.m === m)));
    $("#tSeason").hidden = m !== "season"; $("#tWeek").hidden = m !== "week";
    $("#podium").hidden = m !== "season";
    if (m === "week") renderWeek();
  }
  $("#tMode").addEventListener("click", (e) => { const b = e.target.closest("button[data-m]"); if (b) setTableMode(b.dataset.m); });
  $("#wPrev").onclick = () => { viewWeek = Math.max(1, viewWeek - 1); renderWeek(); };
  $("#wNext").onclick = () => { viewWeek = Math.min(curWeek, viewWeek + 1); renderWeek(); };
  $("#weekGrid").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-w]"); if (th) { viewWeek = +th.dataset.w; renderWeek(); $("#tWeek").scrollIntoView({ behavior: calm ? "auto" : "smooth" }); return; }
    const tr = e.target.closest("tr[data-player]"); if (tr) openPlayer(tr.dataset.player);
  });
  $("#weekTable").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-player]"); if (tr) openPlayer(tr.dataset.player); });
  $("#weekPodium").addEventListener("click", (e) => { const n = e.target.closest("[data-player]"); if (n) openPlayer(n.dataset.player); });
  window.openWeekly = () => { show("table"); setTableMode("week"); };

  $("#standings").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]");
    if (th) { const k = th.dataset.k; sortDir = k === sortKey ? -sortDir : k === "place" ? 1 : -1; sortKey = k; renderTable(); return; }
    const tr = e.target.closest("tr[data-player]"); if (tr) openPlayer(tr.dataset.player);
  });
  $("#podium").addEventListener("click", (e) => { const n = e.target.closest("[data-player]"); if (n) openPlayer(n.dataset.player); });
  renderTable();

  // ---------- хозяева бань ----------
  // Хозяин бани — у кого больше всех походов в ней за сезон 2026, и не меньше двух: шапку держит тот, кто ходит чаще
  // (как мэр в Swarm и Local Legend в Strava). Поровну у нескольких — шапку делят; все по разу — баня свободна.
  // Пока по сезону: дат в таблице Комиссии нет, а портал хранит их с 26.09 — на скользящие 90 дней перейдём позже.
  // На карте — только бани с точной точкой: примерные легли бы кучей в центр города (15.10).
  function ownerOf(b) {
    const e = Object.entries(b.v26 || {}); if (!e.length) return null;
    const n = Math.max(...e.map(([, k]) => k));
    const who = e.filter(([, k]) => k === n).map(([p]) => p).sort((x, y) => x.localeCompare(y, "ru"));
    return { n, who, kind: n < 2 ? "free" : who.length > 1 ? "shared" : "owner" };
  }
  let ownMap = null, ownLayer = null, ownFree = null, ownFocus = "";
  function initOwners() {
    if (!ownMap) {
      ownMap = L.map("ownmap", { worldCopyJump: true, zoomSnap: 0.5 }).setView([55.75, 37.6], innerWidth > 760 ? 10 : 9);
      ownMap.attributionControl.setPrefix(false);
      L.tileLayer(TILE_URL, tileOpts).addTo(ownMap);
      // 18.10: в Москве аватарки налезали друг на друга — при отдалении собираем в группы: до трёх самых частых хозяев
      // и число бань (нажал — приблизились); свободные бани (белые точки) — отдельно и без групп
      ownLayer = L.markerClusterGroup({ maxClusterRadius: 46, disableClusteringAtZoom: 13, showCoverageOnHover: false, spiderfyOnMaxZoom: true,
        iconCreateFunction: (c) => {
          const kids = c.getAllChildMarkers(), tally = new Map();
          for (const m of kids) for (const p of m.options.owners || []) tally.set(p, (tally.get(p) || 0) + 1);
          const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p), sz = 34;
          return L.divIcon({ className: "", iconSize: [Math.round(sz + (top.length - 1) * sz * 0.6), sz],
            html: `<div class="own-pin own-cluster" style="--s:${sz}px">${top.map((p) => ava(p)).join("")}<b>${kids.length}</b></div>` });
        } }).addTo(ownMap);
      ownFree = L.layerGroup().addTo(ownMap);
    }
    setTimeout(() => ownMap.invalidateSize(), 0);
    renderOwners();
  }
  // хозяин — его аватарка (размер — сколько раз ходил), шапку делят — аватарки внахлёст, свободная — белая точка
  function ownerIcon(o) {
    if (o.kind === "free") return L.divIcon({ className: "", iconSize: [12, 12], html: '<i class="own-free"></i>' });
    const size = Math.round(Math.min(30 + Math.sqrt(o.n) * 4, 58)), sz = o.kind === "owner" ? size : Math.round(size * 0.8);
    const names = o.who.slice(0, 3), w = Math.round(sz + (names.length - 1) * sz * 0.6);
    return L.divIcon({ className: "", iconSize: [w, sz], html: `<div class="own-pin" style="--s:${sz}px">${names.map((p) => ava(p)).join("")}<b>${o.n}</b></div>` });
  }
  function renderOwners() {
    if (!ownMap) return;
    const onOwn = (b) => b.ll && (b.prec === "exact" || b.prec === "auto");   // «среднеточные» (19.10) — тоже, они почти всегда рядом
    const rows = baths.filter(onOwn).map((b) => [b, ownerOf(b)]).filter(([, o]) => o);
    const hidden = baths.filter((b) => !onOwn(b) && ownerOf(b)?.kind === "owner").length;
    const kingdoms = new Map();
    for (const [b, o] of rows) if (o.kind === "owner") kingdoms.set(o.who[0], [...(kingdoms.get(o.who[0]) || []), [b, o.n]]);
    ownLayer.clearLayers(); ownFree.clearLayers();
    const shown = rows.filter(([, o]) => !ownFocus || o.who.includes(ownFocus));
    for (const [b, o] of shown) {
      L.marker(b.ll, { icon: ownerIcon(o), zIndexOffset: o.kind === "free" ? -1000 : o.n * 10, title: b.name, owners: o.kind === "free" ? [] : o.who })
        .bindTooltip(`<b>${esc(b.name)}</b><br>${o.kind === "free" ? "свободна — все по разу" : `${esc(o.who.join(", "))}${o.kind === "shared" ? " делят" : ""} · ${o.n} ${plural(o.n, "поход", "похода", "походов")}`}`, { direction: "top", offset: [0, -14] })
        .on("click", () => { show("map"); openBath(b.id, true); })
        .addTo(o.kind === "free" ? ownFree : ownLayer);
    }
    if (ownFocus && shown.length) ownMap.fitBounds(L.latLngBounds(shown.map(([b]) => b.ll)).pad(0.2), { maxZoom: 12, paddingTopLeft: innerWidth > 760 ? [360, 0] : [0, 0] });
    const count = (k) => rows.filter(([, o]) => o.kind === k).length;
    $("#oSum").innerHTML = [[count("owner"), "с хозяином"], [count("shared"), "шапку делят"], [count("free"), "свободны"]]
      .map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join("");
    $("#oMe").innerHTML = myNick ? ownMine(rows, kingdoms) : "";
    const top = [...kingdoms].sort((x, y) => y[1].length - x[1].length || x[0].localeCompare(y[0], "ru"));
    $("#oList").innerHTML = top.map(([p, bs]) => `<li data-owner="${esc(p)}" aria-pressed="${ownFocus === p}">${ava(p, "sm")}<span><span class="hn">${esc(p)}</span>`
      + `<span class="hm">${bs.sort((x, y) => y[1] - x[1]).slice(0, 2).map(([b, n]) => `${esc(b.name)} · ${n}`).join(", ")}</span></span><span class="hv">${bs.length}</span></li>`).join("")
      || `<li><span></span><span class="hm">Пока у бань нет хозяев</span></li>`;
    $("#oNote").textContent = `Хозяин — больше всех походов в бане за сезон, от двух. Ещё ${hidden} ${plural(hidden, "баня", "бани", "бань")} с хозяином без точной точки — их на карте нет.`;
  }
  // где я хозяин и ближайшая шапка, которую можно отжать: где я уже был и до хозяина меньше всего походов
  function ownMine(rows, kingdoms) {
    const mine = kingdoms.get(myNick)?.length || 0;
    let near = null;
    for (const [b, o] of rows) {
      const k = b.v26?.[myNick] || 0;
      if (!k || (o.kind === "owner" && o.who[0] === myNick)) continue;
      const need = Math.max(2, o.n + 1) - k;
      if (!near || need < near.need) near = { b, o, need };
    }
    return `<b>${mine ? `Ты хозяин ${mine} ${plural(mine, "бани", "бань", "бань")}` : "Ты пока не хозяин ни одной бани"}</b>`
      + (near ? `<span>Ближе всего — «${esc(near.b.name)}»${near.o.kind === "owner" ? ` у ${esc(near.o.who[0])}` : ""}: ещё ${near.need} ${plural(near.need, "поход", "похода", "походов")}</span>` : "");
  }
  $("#oList").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-owner]"); if (!li) return;
    ownFocus = ownFocus === li.dataset.owner ? "" : li.dataset.owner;
    if (!ownFocus) ownMap.setView([55.75, 37.6], innerWidth > 760 ? 10 : 9);
    renderOwners();
  });

  // ---------- профиль участника ----------
  // походы участника из журнала портала (с 26.09; видят только участники лиги): баня → последний поход, засчитано, на проверке.
  // В таблице Комиссии дат нет — только сколько раз за сезон, поэтому бани оттуда идут без даты
  function journalOf(name) {
    const by = new Map();
    for (const v of visits) {
      if (v.status === "rejected" || !byId.has(v.bathId) || !(v.player === name || v.companions?.includes(name))) continue;
      const r = by.get(v.bathId) || { last: "", ok: 0, pending: 0 };
      if (v.status === "pending") r.pending++; else r.ok++;
      if (v.date > r.last) r.last = v.date;
      by.set(v.bathId, r);
    }
    return by;
  }
  function openPlayer(name, year) {
    // новичка ещё нет в таблице (ни бань из таблицы, ни засчитанных походов) — карточка всё равно открывается
    const s = ranked.find((x) => x.name === name)
      || { name, total: 0, baths: 0, u: 0, uu: 0, long: 0, k: 0, pub: 0, reg: 0, weekPts: {}, weekBaths: {}, place: ranked.length + 1 };
    const weeks = Array.from({ length: curWeek }, (_, i) => i + 1);
    const maxB = Math.max(1, ...weeks.map((w) => s.weekBaths[w] ?? 0));
    // 05.11: бани, география и типы — за выбранный год (2023–2026); очки, плитки и недели — сезон 2026, прошлых по неделям нет
    // в 2026 ещё не был, но был раньше — сразу последний его сезон
    year ??= s.baths ? 2026 : [2025, 2024, 2023].find((y) => baths.some((b) => b.histBy?.[y]?.[name])) || 2026;
    // "all" — за всё время (2023–2026): походы складываем по годам
    const inYear = (b, y) => (y === 2026 ? b.v26?.[name] : b.histBy?.[y]?.[name]) || 0;
    const cnt = (b) => (year === "all" ? YEARS.reduce((a, y) => a + inYear(b, y), 0) : inYear(b, year));
    const mine = baths.filter((b) => cnt(b)).sort((a, b) => cnt(b) - cnt(a));
    const regions = new Set(mine.filter((b) => b.region && b.country).map(placeKey));
    const ctry = new Set(mine.map((b) => b.country).filter(Boolean));
    const empty = !s.baths && !mine.length;
    // бани по годам (03.11, Витёк): сколько разных бань и походов у участника в каждом сезоне — из таблицы и 2026
    const byYear = {};
    for (const b of baths) {
      for (const [y, who] of Object.entries(b.histBy || {})) if (who[name]) { const r = (byYear[y] ||= { baths: 0, n: 0 }); r.baths++; r.n += who[name]; }
      if (b.v26?.[name]) { const r = (byYear["2026"] ||= { baths: 0, n: 0 }); r.baths++; r.n += b.v26[name]; }
    }
    const ys = Object.keys(byYear).sort();
    // бань по годам — кнопками: нажал год — ниже его бани, география и типы, «Показать на карте» — тот же год
    // годы — переключателем под шапкой (05.11, отзыв: кнопки в шапке переносились вразнобой) и «Всё время»
    const allBaths = baths.filter((b) => YEARS.some((y) => inYear(b, y))).length;
    const yBtn = (v, label, n) => `<button type="button" data-year="${v}" aria-pressed="${String(v) === String(year)}"><b>${label}</b><small>${n} ${plural(n, "баня", "бани", "бань")}</small></button>`;
    const yearsLine = ys.length > 1 ? `<div class="seg p-years" role="group" aria-label="Бани по годам">${ys.map((y) => yBtn(y, y, byYear[y].baths)).join("")}${yBtn("all", "Всё", allBaths)}</div>` : "";
    // плитки за выбранный год: у 2026 — из таблицы; у прошлых лет и «всего» — что известно по таблицам Комиссии
    const firstYear = (b) => YEARS.find((y) => inYear(b, y));
    const yearTiles = year === 2026 ? null : [
      [mine.reduce((a, b) => a + cnt(b), 0), "походов"], [mine.length, year === "all" ? "разных бань" : "бань"],
      year === "all" ? [YEARS.filter((y) => byYear[y]).length, "сезонов в лиге"]
        : year === YEARS[0] ? [ctry.size, plural(ctry.size, "страна", "страны", "стран")]   // в первом году данных «впервые» — все бани
        : [mine.filter((b) => firstYear(b) === year).length, "впервые"],
      [mine.filter((b) => b.t === "public").length, "общественных бань"]];
    const types = mine.reduce((a, b) => ((a[b.t] = (a[b.t] || 0) + cnt(b)), a), {});
    const best = Math.max(...weeks.map((w) => s.weekBaths[w] ?? 0));
    // строка над графиком (24.10, Леха: «непонятно, сколько бань»): итог, а на наведённом или нажатом столбике — его неделя
    const bestW = weeks.find((w) => (s.weekBaths[w] ?? 0) === best);
    const avgW = (s.baths / Math.max(1, curWeek)).toFixed(1).replace(".", ",");
    const barsSummary = best ? `в среднем ${avgW} за неделю · рекорд ${best} — W${bestW}` : "";
    // сверху — свежие походы с портала (по дате), ниже — бани из таблицы Комиссии (там дат нет); гостю журнал не виден
    const guest = D.live && !member;
    const own = D.live && me?.nick === name;   // своя карточка — аватарку можно сменить
    const jr = guest || year !== 2026 ? new Map() : journalOf(name);   // даты походов — только у сезона портала
    const onlyJournal = [...jr.keys()].filter((id) => !cnt(byId.get(id))).map((id) => byId.get(id));   // ещё на проверке
    const dated = [...mine.filter((b) => jr.has(b.id)), ...onlyJournal].sort((a, b) => jr.get(b.id).last.localeCompare(jr.get(a.id).last));
    const undated = mine.filter((b) => !jr.has(b.id)).sort((a, b) => cnt(b) - cnt(a) || a.name.localeCompare(b.name, "ru"));
    const bRow = (b) => {
      const r = jr.get(b.id), n = cnt(b);
      return `<button data-bath="${b.id}"><span>${tdot(b.t)}${esc(b.name)}</span><span class="bl-r">${r?.pending ? "<em>на проверке</em>" : ""}${n > 1 ? `<b>×${n}</b>` : ""}${r ? `<time datetime="${r.last.slice(0, 10)}">${dayLabel(r.last)}</time>` : ""}</span></button>`;
    };
    const rows = [...dated.map(bRow), ...(undated.length && !guest && year === 2026 ? [`<div class="bl-sep">${dated.length ? "Раньше — по таблице Комиссии, там без дат" : "По таблице Комиссии — там без дат"}</div>`] : []), ...undated.map(bRow)];
    // на телефоне список из 47 бань занимал три экрана (05.11): первые 8, остальное — «Показать все»; на компьютере — прокрутка, как была
    const SHOW = 8, total = dated.length + undated.length;
    let cut = 0; for (let n = 0; cut < rows.length && n < SHOW; cut++) if (rows[cut].startsWith("<button")) n++;   // 8 бань, разделитель не в счёт
    const blist = total > SHOW + 2 ? rows.slice(0, cut).join("") + `<div class="bl-rest">${rows.slice(cut).join("")}</div><button type="button" class="bl-all">Показать все ${total}</button>` : rows.join("");
    // переключили год — окно не прыгает (05.11): высота не меньше прежней, пока карточка открыта
    const sheetEl = $("#playerModal .sheet");
    sheetEl.style.minHeight = $("#playerModal").hidden ? "" : sheetEl.offsetHeight + "px";
    $("#playerBody").innerHTML = `
      <div class="p-head">${own ? avaEdit("xl") : ava(name, "xl")}<div>
        <div class="eyebrow">${commission.has(name) ? "Комиссия ЕБЛ · " : ""}${!s.baths ? "участник лиги" : `${s.place} место в сезоне${s.move > 0 ? ` <span class="up">▲${s.move}</span>` : s.move < 0 ? ` <span class="down">▼${-s.move}</span>` : ""}`}</div>
        <h2>${esc(name)}</h2>
        <div class="sub">${!s.baths ? "В этом сезоне пока без бань" : `<b>${fmt(s.total)}</b> ${plural(s.total, "очко", "очка", "очков")} · ${s.baths} ${plural(s.baths, "баня", "бани", "бань")}${s.crowns ? ` · <span class="p-hats" title="Выиграл ${s.crowns} ${plural(s.crowns, "неделю", "недели", "недель")}"><svg class="hat-ic" aria-hidden="true"><use href="#i-banhat"/></svg>${s.crowns} ${plural(s.crowns, "неделя", "недели", "недель")}</span>` : ""}`}</div>
      </div></div>
      ${yearsLine}
      ${empty ? `<div class="p-body"><div class="empty" style="padding:28px 8px">${markSvg()}<b>Сезон ещё впереди</b><p>Первая баня — сразу +1 за поход и +1 за уникальную.</p></div></div>` : `<div class="p-body">${yearTiles ? `
        <div class="stats four">${yearTiles.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join("")}</div>
        ${year === "all" ? `<section><h3>Бань по годам</h3><div class="ybars">${ys.map((y) => `<div><b>${byYear[y].baths}</b><i style="height:${Math.max(4, (byYear[y].baths / Math.max(...ys.map((z) => byYear[z].baths))) * 100)}%"></i><span>${y}</span></div>`).join("")}</div></section>` : ""}`
        : s.baths ? `
        <div class="stats four">
          <div><b>${s.u}</b><span>уникальных</span></div><div><b>${s.uu}</b><span>ультра&shy;уникальных</span></div>
          <div><b>${s.long}</b><span>долгих</span></div><div><b>${s.k}</b><span>за компанию</span></div>
        </div>
        <section>
          <div class="bars-head"><h3>Бань по неделям</h3><span class="bars-read" id="pBarsRead" aria-live="polite">${barsSummary}</span></div>
          <div class="bars" id="pBars" role="img" aria-label="Бань по неделям: ${barsSummary}">
            <i class="bars-max" aria-hidden="true"><span>${maxB}</span></i>
            ${weeks.map((w) => { const v = s.weekBaths[w] ?? 0; return `<div class="${v ? "" : "zero"}" data-w="${w}" style="height:${Math.max(2, (v / maxB) * 100)}%"></div>`; }).join("")}</div>
          <div class="axis"><span>W1</span><span>W${Math.round(curWeek / 2)}</span><span>W${curWeek}</span></div>
        </section>` : ""}
        <div class="cols2">
          <section><h3>${year === 2026 ? "Бани сезона" : year === "all" ? "Все бани" : `Бани ${year}`} · ${mine.length}</h3><div class="blist">${blist || '<span class="hint">Пока пусто</span>'}</div>
            ${guest && mine.length && year === 2026 ? '<p class="hint" style="margin:8px 0 0">Даты походов видны участникам лиги после входа.</p>' : ""}</section>
          <section>
            <h3>География</h3>
            <p class="geo" style="margin:0 0 4px"><b>${ctry.size}</b> ${plural(ctry.size, "страна", "страны", "стран")} · <b>${regions.size}</b> ${plural(regions.size, "регион", "региона", "регионов")}</p>
            <p class="hint" style="margin:0 0 18px">${[...ctry].map(esc).join(", ")}</p>
            <h3>Типы бань</h3>
            ${Object.entries(types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<div class="typerow">${tdot(t)}<span>${TYPE_LABEL[t]}</span><span>${n}</span></div>`).join("")}
            <button class="btn" style="margin-top:16px" id="pOnMap">${icon("map")}Показать на карте</button>
          </section>
        </div>
      </div>`}`;
    if (own) bindAvaEdit($("#playerBody"));
    const all = $("#playerBody .bl-all"); if (all) all.onclick = () => all.closest(".blist").classList.add("open");
    $("#playerModal").hidden = false;
    $$("#playerBody [data-bath]").forEach((x) => (x.onclick = () => { $("#playerModal").hidden = true; show("map"); openBath(+x.dataset.bath, true); }));
    if ($("#pOnMap")) $("#pOnMap").onclick = () => { $("#playerModal").hidden = true; playerOnMap(name, year); };
    $$("#playerBody [data-year]").forEach((x) => (x.onclick = () => openPlayer(name, x.dataset.year === "all" ? "all" : +x.dataset.year)));
    const bars = $("#pBars");
    if (bars) {
      const read = $("#pBarsRead");
      const pick = (el) => {
        $$("#pBars [data-w]").forEach((x) => x.classList.toggle("on", x === el));
        if (!el) return (read.textContent = barsSummary);
        const w = +el.dataset.w, v = s.weekBaths[w] ?? 0, pts = s.weekPts[w];
        read.textContent = `W${w} · ${weekRange(w)} · ${v ? `${v} ${plural(v, "баня", "бани", "бань")}` : "без бань"}${pts ? ` · ${fmt(pts)} за место` : ""}`;
      };
      bars.addEventListener("pointerover", (e) => e.pointerType === "mouse" && pick(e.target.closest("[data-w]")));
      bars.addEventListener("pointerleave", (e) => e.pointerType === "mouse" && pick(null));
      // телефон: нажал — неделя, ещё раз — итог; мышью неделя уже показана наведением
      bars.addEventListener("click", (e) => { if (e.pointerType === "mouse") return; const el = e.target.closest("[data-w]"); pick(el && !el.classList.contains("on") ? el : null); });
    }
  }
  // бани участника на карте (карточка участника, профиль): остальные фильтры сбрасываем, иначе можно увидеть «Ничего не нашлось»
  function playerOnMap(name, year = 2026) {
    show("map"); closeBath();
    $("#q").value = ""; $("#fCountry").value = ""; $("#fPrec").value = "";
    $$("#fType button[data-t]").forEach((x) => x.setAttribute("aria-pressed", "false"));
    $("#fPlayer").value = name; $("#fSeason").value = String(year);
    if (phone.matches) setSheet("half");   // 05.11: шторка оставалась свёрнутой — список бань не видно
    render(true);
  }

  // ---------- форма похода ----------
  const vf = $("#visitForm");
  $("#vPlayer").innerHTML = [...players].sort((a, b) => a.localeCompare(b, "ru")).map((p) => `<option>${esc(p)}</option>`).join("");
  let picked = null, newPin = null, pickMap = null, pickMarker = null, lastTotal = 0;
  let pickedType = null;   // тип бани со слов автора — если в справочнике он не размечен
  const TYPE_CHOICE = { public: "Общественная", spa: "Хуитнес", private: "Частная" };

  function openVisit({ bathId } = {}) {
    if (D.live && !me) return openLogin();
    if (D.live && !me.nick) return openClaim();
    vf.reset(); vf.classList.remove("is-sent"); $("#vSent").hidden = true; photoPrev([]);
    delete $("#nbCountry").dataset.manual; delete $("#nbRegion").dataset.manual;
    $("#vPlayer").value = D.live ? me.nick : store.get("me", players[0]);
    // Комиссия может завести поход за другого участника (сама в бане могла не быть); остальные — только за себя
    $("#vPlayer").disabled = D.live && !canModerate;
    $("#vPlayerHint").hidden = !(D.live && canModerate);
    $("#vPlayerField").hidden = D.live && !canModerate;
    $("#vDate").value = mskNow();
    setDur(120);
    $("#vPrMore").hidden = false; $("#vPrExtra").hidden = true;
    $$("#vPrWeekend button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.w === "")));
    picked = bathId ? byId.get(bathId) : null; newPin = null; lastTotal = 0; pickedType = null; durOver = null; compAll = false;
    if (pickMarker) { pickMarker.remove(); pickMarker = null; }
    $("#nbGeoState").textContent = "Или кликни на карте. Точку можно перетащить.";
    $("#vPhotosField").hidden = !D.live; $("#vPhotosState").textContent = PHOTOS_HINT;
    renderComp(); renderPicked(); calc();
    $("#visitModal").hidden = false;
    if (!picked) setTimeout(() => $("#vBathQ").focus(), 50);
  }
  // на телефоне наведения нет: по нажатию сначала бросок ковша и хлопок пара, потом форма — иначе шторка
  // формы сразу закрывает кнопку и анимации не видно. На компьютере её уже показало наведение — форма сразу.
  // На телефоне с 02.11 вместо ковша — веник посередине нижнего меню: хлёст короче броска ковша.
  let pouring = false;
  $("#addVisitBtn").onclick = () => {
    if (pouring) return;
    const b = $("#addVisitBtn"); b.classList.remove("pour"); void b.offsetWidth; b.classList.add("pour");
    setTimeout(() => b.classList.remove("pour"), 2600);
    const wait = calm || !matchMedia("(hover: none)").matches ? 0 : phone.matches ? 520 : 950;
    // открыта карточка бани — она и подставлена (закрытую форма похода не предлагает — тогда обычный поиск)
    const here = !$("#drawer").hidden && openId && !byId.get(openId)?.closed_on ? { bathId: openId } : {};
    if (!wait) return openVisit(here);
    pouring = true;
    setTimeout(() => { pouring = false; openVisit(here); }, wait);
  };

  const PHOTOS_HINT = $("#vPhotosState").textContent;
  // выбранные фото — сразу плитками рядом с кнопкой камеры (03.11, макет); в бакет уходят после отправки похода
  let photoUrls = [];
  function photoPrev(files) {
    photoUrls.forEach((u) => URL.revokeObjectURL(u));
    photoUrls = files.slice(0, 10).map((f) => URL.createObjectURL(f));
    $("#vPhotosPrev").innerHTML = photoUrls.map((u) => `<img src="${u}" alt="">`).join("");
    const n = files.length;
    $("#vPhotosState").textContent = n ? (n > 10 ? "возьмём первые 10" : "загрузятся после отправки") : PHOTOS_HINT;
  }
  $("#vPhotos").addEventListener("change", () => photoPrev([...$("#vPhotos").files]));
  function setDur(m) {
    $("#vDur").value = m;
    $$("#vDurChips button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.m === m)));
    renderDurs();
  }
  // своя длительность у кого-то из компании (18.10: «я и Фил — долгую, Диман — экспресс, компания у всех») — редкость,
  // поэтому спрятана за ссылкой «Кто-то ушёл раньше или остался дольше?» прямо под выбором длительности: по ней большие
  // кнопки сменяются строками «у каждого своё», ты первым. Минуты не спрашиваем — важно одно: дольше 2,5 часа или нет
  let durOver = null;   // null — всем одинаково; { ник: минуты } — у каждого своё (у автора — #vDur, длительность похода)
  const durSeg = (p, m, key) => `<div class="seg durs-seg" role="group" aria-label="Сколько парился ${esc(p)}">
    <button type="button" data-${key}="${esc(p)}" data-m="120" aria-pressed="${m <= 150}">⚡ Экспресс</button>
    <button type="button" data-${key}="${esc(p)}" data-m="180" aria-pressed="${m > 150}">🔥 Долгая</button></div>`;
  const DURS_NOTE = "+1 за долгий — каждому, кто был дольше 2,5 часа. Компания — всем.";
  // только те, у кого не как у автора (похода): их и сохраняем
  const durDiff = (people, over, base) => Object.fromEntries(people.filter((p) => over?.[p] != null && (over[p] > 150) !== (base > 150)).map((p) => [p, over[p]]));
  function renderDurs() {
    const comp = $$("#vComp button[aria-pressed=true]").map((c) => c.dataset.p), base = +$("#vDur").value, me = $("#vPlayer").value;
    if (!comp.length) durOver = null;   // компании нет — и делить нечего
    const split = !!durOver;
    $("#vDurChips").hidden = split;
    $("#vDursToggle").hidden = !comp.length || split;
    $("#vDurs").hidden = !split;
    if (!split) return;
    // у каждого своё — и не меняется вслед за чужой строкой: попутчику, которого ещё не трогали, ставим как у автора сейчас
    comp.forEach((p) => { if (durOver[p] == null) durOver[p] = base; });
    const row = (p, m, key, mine) => `<div class="durs-row">${ava(p, "sm")}<b>${esc(p)}${mine ? " <small>· ты</small>" : ""}</b>${durSeg(p, m, key)}</div>`;
    $("#vDurs").innerHTML = row(me, base, "dme", true) + comp.map((p) => row(p, durOver[p], "dp")).join("")
      + `<div class="durs-foot"><span class="hint">${DURS_NOTE}</span><button type="button" class="linkbtn" id="vDursSame">Всем одинаково</button></div>`;
  }
  $("#vDursToggle").addEventListener("click", () => { durOver = {}; renderDurs(); calc(); });
  $("#vDurs").addEventListener("click", (e) => {
    if (e.target.closest("#vDursSame")) { durOver = null; renderDurs(); return calc(); }
    const mine = e.target.closest("[data-dme]");
    if (mine) { setDur(+mine.dataset.m); return calc(); }   // своя строка автора — это и есть длительность похода
    const b = e.target.closest("[data-dp]"); if (b) { durOver[b.dataset.dp] = +b.dataset.m; renderDurs(); }
  });
  $("#vDurChips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setDur(+b.dataset.m); calc(); } });
  $("#vPrMore").addEventListener("click", () => { $("#vPrMore").hidden = true; $("#vPrExtra").hidden = false; });
  $$("#vPrWeekend button").forEach((b) => b.addEventListener("click", () => $$("#vPrWeekend button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)))));

  // «С кем был» (18.10): стена из всех участников лиги мешала — показываем выбранных и тех, с кем этот участник чаще
  // ходил (журнал сайта; дальше — по месту в зачёте), остальные — по «Все участники», с поиском по нику
  const COMP_TOP = 8;
  let compAll = false;
  function renderComp() {
    const me = $("#vPlayer").value;
    const was = new Set($$("#vComp button[aria-pressed=true]").map((c) => c.dataset.p));
    const co = new Map();
    for (const v of visits) {
      const who = [v.player, ...v.companions];
      if (v.status === "rejected" || !who.includes(me)) continue;
      for (const p of who) if (p !== me) co.set(p, (co.get(p) || 0) + 1);
    }
    const order = new Map(ranked.map((s, i) => [s.name, i]));
    const everyone = [...players].filter((p) => p !== me)
      .sort((a, b) => (co.get(b) || 0) - (co.get(a) || 0) || (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b, "ru"));
    const q = lowerE($("#vCompQ").value.trim());
    const shown = compAll ? everyone.filter((p) => !q || was.has(p) || lowerE(p).includes(q)) : everyone.filter((p, i) => i < COMP_TOP || was.has(p));
    $("#vComp").innerHTML = shown.map((p) => `<button type="button" data-p="${esc(p)}" aria-pressed="${was.has(p)}">${ava(p)}${esc(p)}</button>`).join("")
      || '<span class="hint">Никого с таким ником</span>';
    $("#vCompAll").hidden = everyone.length <= COMP_TOP;
    $("#vCompAll").textContent = compAll ? "Свернуть" : `Все участники · ${everyone.length}`;
    $("#vCompQ").hidden = !compAll;
    compCount();
  }
  $("#vCompAll").addEventListener("click", () => { compAll = !compAll; if (!compAll) $("#vCompQ").value = ""; renderComp(); });
  $("#vCompQ").addEventListener("input", () => renderComp());
  function compCount() { const n = $$("#vComp button[aria-pressed=true]").length; $("#vCompCount").textContent = n ? `· ${n + 1} в компании` : ""; renderDurs(); }
  $("#vComp").addEventListener("click", (e) => { const c = e.target.closest("button"); if (!c) return; c.setAttribute("aria-pressed", String(c.getAttribute("aria-pressed") !== "true")); compCount(); calc(); });
  $("#vPlayer").addEventListener("change", () => { store.set("me", $("#vPlayer").value); renderComp(); calc(); });
  ["#vDate", "#nbType", "#nbCountry", "#nbRegion", "#nbName"].forEach((s) => $(s).addEventListener("input", calc));

  function renderPicked() {
    const box = $("#vBathPicked"), isNew = picked === "new";
    $("#newBathBox").hidden = !isNew;
    $("#vBathBox").hidden = !!picked && !isNew;
    $("#vSuggest").hidden = true;
    if (picked && !isNew) {
      box.hidden = false;
      // тип не размечен — спрашиваем: от него зависит +1 за общественную (п. 4); ответ сохранится у бани
      const ask = picked.t === "unknown" ? `<div class="type-ask"><span class="lab">Какая это баня? <small>тип не отмечен, за общественную +1</small></span>
        <div class="chips">${Object.entries(TYPE_CHOICE).map(([t, l]) => `<button type="button" data-ptype="${t}" aria-pressed="${pickedType === t}">${tdot(t)}${l}</button>`).join("")}</div></div>` : "";
      // точки нет или она примерная — спрашиваем тут же: человек только что из бани и знает, где она (как «📍 Знаю, где это» в карточке)
      const geo = D.live && (!picked.ll || picked.prec !== "exact") ? `<div class="type-ask geo-ask"><span class="lab">${picked.ll ? "Точка этой бани на карте примерная" : "Этой бани ещё нет на карте"} <small>— кинь ссылку, если знаешь</small></span>
        <div class="geo-row"><input class="inp" id="vGeo" placeholder="Ссылка на баню в картах, адрес или координаты" autocomplete="off"><button type="button" class="btn sm" id="vGeoSet">Поставить</button></div>
        <span class="hint" id="vGeoState" hidden></span></div>` : "";
      box.innerHTML = `<div class="picked"><span><b>${esc(picked.name)}</b><small>${tdot(picked.t)} ${TYPE_LABEL[picked.t]} · ${esc(where(picked))}</small></span><button type="button" class="btn sm" data-other>Другая</button></div>${ask}${geo}`;
      $("[data-other]", box).onclick = () => { picked = null; pickedType = null; renderPicked(); calc(); $("#vBathQ").focus(); };
      $$("[data-ptype]", box).forEach((b) => (b.onclick = () => { pickedType = pickedType === b.dataset.ptype ? null : b.dataset.ptype; renderPicked(); calc(); }));
      $("#vGeoSet", box)?.addEventListener("click", () => setPickedPoint(picked));
      $("#vGeo", box)?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); setPickedPoint(picked); } });
    } else box.hidden = true;
    if (isNew) setTimeout(() => {
      if (!pickMap) {
        // стартуем с Москвы — там большинство бань лиги
        pickMap = L.map("pickmap", { attributionControl: false }).setView([55.75, 37.62], 9);
        L.tileLayer(TILE_URL, tileOpts).addTo(pickMap); syncTheme();
        pickMap.on("click", (e) => placePin([e.latlng.lat, e.latlng.lng], false));
        // шторка на телефоне выезжает с анимацией — пересчитываем размер карты, когда он меняется, иначе серая полоса
        new ResizeObserver(() => pickMap.invalidateSize()).observe($("#pickmap"));
      }
      pickMap.invalidateSize();
    }, 0);
  }
  // точка бани из справочника — прямо из формы похода; сохраняется сразу, независимо от самого похода
  async function setPickedPoint(b) {
    const input = $("#vGeo").value.trim(), state = $("#vGeoState");
    if (!input) return $("#vGeo").focus();
    state.hidden = false; state.textContent = "Ищу…";
    try {
      const p = await D.setBathLocation(b.id, input);
      b.lat = p.lat; b.lng = p.lng; b.precision = "exact"; hydrate(b); render();
      $(".geo-ask").innerHTML = `<span class="lab">📍 Точка поставлена — спасибо!</span>`;
      refreshData().catch(() => {});   // страну и регион по точке сервер мог заполнить
    } catch (err) { state.textContent = err.message; }
  }
  // точка новой бани: кликом, перетаскиванием, по ссылке/адресу или геопозиции
  function placePin(p, fly = true) {
    newPin = p;
    if (!pickMarker) {
      pickMarker = L.marker(p, { draggable: true, icon: dropIcon("var(--ember)", glyphOf(null)) }).addTo(pickMap);
      pickMarker.on("dragend", () => { const ll = pickMarker.getLatLng(); placePin([ll.lat, ll.lng], false); });
    } else pickMarker.setLatLng(p);
    if (fly) pickMap.setView(p, 16);
    $("#nbGeoState").textContent = `Точка: ${p[0].toFixed(5)}, ${p[1].toFixed(5)} ✓ — можно перетащить`;
    fillRegion(p);
  }
  // страна и регион по точке (если ещё не заполнены) — от них зависят очки за новый регион и страну
  // название из OpenStreetMap — к написанию, которое уже есть у бань лиги («Кировская область» → «Кировская обл»),
  // иначе бонус «новый регион» дадут там, где участник уже был (то же делает бот: _shared/place.ts)
  // написания геокодера, которые у лиги короче, — как COUNTRY_ALIAS / REGION_ALIAS в _shared/place.ts
  const COUNTRY_ALIAS = { "объединенные арабские эмираты": "ОАЭ", "соединенные штаты америки": "США", "соединенное королевство": "Великобритания", "республика корея": "Корея" };
  const REGION_ALIAS = { "алтай": "Горный Алтай" };
  function matchPlace(country, region) {
    const stem = (s) => regionKey(s).split(/[\s-]/)[0].slice(0, 7);
    const c0 = country && (COUNTRY_ALIAS[regionKey(country)] ?? country);
    const c = baths.find((b) => b.country && regionKey(b.country) === regionKey(c0))?.country ?? c0 ?? "";
    if (!region) return { country: c, region: "" };
    if (c === "Россия") region = REGION_ALIAS[regionKey(region)] ?? region;
    const same = baths.filter((b) => b.country === c && b.region), freq = {};
    same.forEach((b) => (freq[b.region] = (freq[b.region] || 0) + 1));
    const names = Object.keys(freq).sort((x, y) => freq[y] - freq[x]);
    const hit = names.find((n) => regionKey(n) === regionKey(region)) ?? names.find((n) => stem(n) === stem(region));
    return { country: c, region: hit ?? region.replace(/\s+область$/i, " обл").replace(/^Республика\s+/i, "") };
  }
  // вписанное руками не трогаем; подставленное по прошлой точке — меняем, если точку передвинули
  ["#nbCountry", "#nbRegion"].forEach((s) => $(s).addEventListener("input", () => ($(s).dataset.manual = "1")));
  async function fillRegion([lat, lng]) {
    const auto = (s) => !$(s).dataset.manual;
    if (!auto("#nbCountry") && !auto("#nbRegion")) return;
    try {
      const r = await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&accept-language=ru&lat=${lat}&lon=${lng}`)).json();
      const a = r.address || {}, p = matchPlace(a.country, a.province || a.state || a.region || a.city);
      if (auto("#nbCountry") && p.country) $("#nbCountry").value = p.country;
      if (auto("#nbRegion") && p.region) $("#nbRegion").value = p.region;
      calc();
    } catch { /* без автозаполнения */ }
  }
  $("#nbGeoFind").addEventListener("click", async () => {
    const input = $("#nbGeo").value.trim(); if (!input) return $("#nbGeo").focus();
    $("#nbGeoState").textContent = "Ищу…";
    try { const p = await D.findLocation(input); placePin([p.lat, p.lng]); }
    catch (err) { $("#nbGeoState").textContent = err.message; }
  });
  $("#nbGeo").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("#nbGeoFind").click(); } });
  $("#nbGeoMe").addEventListener("click", () => {
    if (!window.isSecureContext || !navigator.geolocation) {
      $("#nbGeoState").textContent = "Геопозиция в браузере работает только по https — вставь ссылку или кликни на карте.";
      return;
    }
    $("#nbGeoState").textContent = "Определяю…";
    navigator.geolocation.getCurrentPosition((pos) => placePin([pos.coords.latitude, pos.coords.longitude]),
      () => ($("#nbGeoState").textContent = "Браузер не дал геопозицию — вставь ссылку или кликни на карте."), { enableHighAccuracy: true, timeout: 10000 });
  });
  $("#vBathQ").addEventListener("input", () => {
    const raw = $("#vBathQ").value.trim(), q = raw.toLowerCase(), sg = $("#vSuggest");
    if (q.length < 2) { sg.hidden = true; return; }
    const hits = baths.filter((b) => !b.closed_on && b.search.includes(q)).sort((a, b) => b.n26 - a.n26).slice(0, 7);   // закрытые не предлагаем
    sg.innerHTML = hits.map((b) => `<button type="button" data-id="${b.id}"><span class="sn">${tdot(b.t)}${esc(b.name)}</span><small>${esc(b.region || b.country || "")}</small></button>`).join("") +
      `<button type="button" data-new="1"><span class="sn new">${icon("plus")}Новая баня «${esc(raw)}»</span><small>нет в справочнике</small></button>`;
    sg.hidden = false;
  });
  $("#vSuggest").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.new) { picked = "new"; $("#nbName").value = $("#vBathQ").value.trim(); }
    else picked = byId.get(+b.dataset.id);
    pickedType = null;
    renderPicked(); calc();
  });

  // что уже есть у участника в сезоне: бани, регионы, страны (таблица + свои походы не в отказе)
  // ключ региона как в движке очков (_shared/scoring.js): «Московская обл.» = «Московская обл», «Кировская область» = «Кировская обл»
  const regionKey = (s) => ` ${String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[.,«»"()]/g, " ")} `
    .replace(/ область /g, " обл ").replace(/ (республика|респ|город|г) /g, " ").replace(/ автономный округ /g, " ао ").replace(/\s+/g, " ").trim();
  const placeKey = (b) => regionKey(b.country) + "/" + regionKey(b.region);
  function seasonOf(player) {
    const bathIds = new Set(), regions = new Set(), countries = new Set();
    const add = (b) => { if (!b) return; bathIds.add(b.id); if (b.region) regions.add(placeKey(b)); if (b.country) countries.add(regionKey(b.country)); };
    baths.forEach((b) => b.v26?.[player] && add(b));
    visits.filter((v) => v.status !== "rejected" && (v.player === player || v.companions.includes(player))).forEach((v) => add(byId.get(v.bathId)));
    return { bathIds, regions, countries };
  }

  // очки похода на проверке — заранее, у каждого свои (03.11, «за что очки»): как в талоне формы, но без самого этого похода
  function previewFor(v, nick) {
    const b = byId.get(v.bathId); if (!b) return null;
    return pointsFor(b, nick, v.durs?.[nick] ?? v.dur, v.companions.length + 1, v.id);
  }
  // b — баня (у новой нет id), skip — сам этот поход, если он уже в журнале
  function pointsFor(b, nick, dur, n, skip) {
    const bathIds = new Set(), regions = new Set(), countries = new Set();
    const add = (x) => { if (!x) return; bathIds.add(x.id); if (x.region) regions.add(placeKey(x)); if (x.country) countries.add(regionKey(x.country)); };
    baths.forEach((x) => x.v26?.[nick] && add(x));
    visits.filter((w) => w.id !== skip && w.status !== "rejected" && (w.player === nick || w.companions.includes(nick))).forEach((w) => add(byId.get(w.bathId)));
    const lines = [["поход", 1]];
    if (b.t === "public") lines.push(["общественная", 1]);
    if (!bathIds.has(b.id)) lines.push(["уникальная", 1]);
    if (!b.n26 && !b.nHist) lines.push(["ультра?", 0]);
    if (b.region && b.country && !regions.has(placeKey(b))) lines.push(["новый регион", 1]);
    if (b.country && !countries.has(regionKey(b.country))) lines.push(["новая страна", 1]);
    if (dur > 150) lines.push(["долгая", 1]);
    if (n >= 9) lines.push(["компания ККК", 3]); else if (n >= 6) lines.push(["компания КК", 2]); else if (n >= 3) lines.push(["компания К", 1]);
    return { total: lines.reduce((a, l) => a + l[1], 0), lines };
  }
  function score() {
    const player = $("#vPlayer").value, dur = +$("#vDur").value;
    const comp = $$("#vComp button[aria-pressed=true]").map((c) => c.dataset.p);
    const date = $("#vDate").value || mskNow();
    const isNew = picked === "new";
    const b = isNew ? { t: $("#nbType").value || "unknown", country: $("#nbCountry").value.trim(), region: $("#nbRegion").value.trim(), n26: 0, nHist: 0 } : picked;
    // неделя — по моменту отметки (п. 6: пост в группе), а не по времени захода: так считает Комиссия и движок очков
    const base = { total: 0, week: weekOf(mskNow()), comp, dur, player, date };
    if (!b) return { ...base, empty: "Выбери баню — и талон заполнится сам" };
    if (date > mskNow()) return { ...base, empty: "Время захода ещё не наступило — поправь дату" };
    if (date.slice(0, 4) !== "2026") return { ...base, empty: "Сезон — 2026 год: поход из другого года не засчитывается" };
    const sameDay = !isNew && visits.some((v) => v.status !== "rejected" && v.bathId === b.id && v.date.slice(0, 10) === date.slice(0, 10) && (v.player === player || v.companions.includes(player)));
    const s = seasonOf(player), lines = [];
    // не блокируем: дата могла быть не та (баню кинули за прошлый день) — предупреждаем, решит Комиссия
    if (sameDay) lines.push(["В эту баню в этот день поход уже есть — проверь дату, иначе Комиссия может не засчитать (п. 5)", 0, "muted"]);
    lines.push(["Поход в баню", 1]);
    const bt = !isNew && b.t === "unknown" && pickedType ? pickedType : b.t;
    if (bt === "public") lines.push(["Общественная", 1]);
    else if (bt === "unknown") lines.push(["Общественная? Отметь тип бани выше", 0, "muted"]);
    if (isNew || !s.bathIds.has(b.id)) lines.push(["Уникальная", 1]);
    if (isNew) lines.push(["Ультрауникальная", 1]);
    else if (!b.n26 && !b.nHist) lines.push(["Ультра? Комиссия проверит", 0, "muted"]);
    if (b.region && b.country && !s.regions.has(placeKey(b))) lines.push([`Новый регион · ${b.region}`, 1]);
    if (b.country && !s.countries.has(regionKey(b.country))) lines.push([`Новая страна · ${b.country}`, 1]);
    if (dur > 150) lines.push(["Долгий поход", 1]);
    const n = comp.length + 1;
    if (n >= 9) lines.push([`Компания ККК · ${n}`, 3]);
    else if (n >= 6) lines.push([`Компания КК · ${n}`, 2]);
    else if (n >= 3) lines.push([`Компания К · ${n}`, 1]);
    return { ...base, lines, bath: { ...b, t: bt }, total: lines.reduce((a, l) => a + (l[1] || 0), 0) };
  }
  // «Сегодня, 19:06» / «Вчера, 23:10» / «1 нояб, 19:00» — строка «Когда зашёл»
  function whenLabel(date) {
    const day = date.slice(0, 10), now = mskNow().slice(0, 10), t = date.slice(11, 16);
    const y = new Date(now + "T12:00Z"); y.setUTCDate(y.getUTCDate() - 1);
    const d = day === now ? "Сегодня" : day === y.toISOString().slice(0, 10) ? "Вчера"
      : new Date(day + "T12:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
    return `${d}, ${t}`;
  }
  // очки каждого в компании одной строкой: «Ты +4 поход · общественная · уникальная · компания» (03.11, макет)
  const shortLine = (t) => t.split(" · ")[0].toLowerCase().replace("поход в баню", "поход").replace("долгий поход", "долгая")
    .replace("ультрауникальная", "ультра").replace(/^компания.*/, "компания");
  function peopleRows(r) {
    const n = r.comp.length + 1;
    const rows = [{ who: r.player, mine: true, total: r.total, lines: r.lines.filter((l) => l[1]).map((l) => shortLine(l[0])) }];
    for (const p of r.comp) {
      const x = pointsFor(r.bath, p, durOver?.[p] ?? r.dur, n);
      rows.push({ who: p, total: x.total, lines: x.lines.filter((l) => l[1]).map((l) => shortLine(l[0])) });
    }
    return rows;
  }
  const rowHtml = (x, totalId) => `<div class="t-who">${ava(x.who, "sm")}<b>${x.mine && (!D.live || x.who === myNick) ? "Ты" : esc(x.who)}</b>`
    + `<em${totalId ? ` id="${totalId}"` : ""}>+${x.total}</em><span>${esc(x.lines.join(" · "))}</span></div>`;
  function calc() {
    const date = $("#vDate").value;
    if (date) {
      // неделя — по моменту отметки, не по времени захода (как в score)
      $("#vWhenTxt").textContent = whenLabel(date);
      $("#vWeekHint").textContent = date > mskNow() ? " · ещё не наступило" : ` · МСК · W${weekOf(mskNow())}`;
    }
    const r = score();
    // предупреждения (тот же день, тип бани не отмечен) — над строками; «Ультра?» решит Комиссия — не шумим
    const warn = (r.lines || []).filter((l) => !l[1] && !/^Ультра/.test(l[0])).map((l) => `<div class="t-warn">${esc(l[0])}</div>`).join("");
    $("#calc").innerHTML = r.empty ? `<div class="t-empty">${esc(r.empty)}</div>`
      : warn + peopleRows(r).map((x, i) => rowHtml(x, i ? "" : "tTotal")).join("");
    if (!r.empty) countUp($("#tTotal"), lastTotal, r.total);
    lastTotal = r.total;
    $("#vSubmit").disabled = !r.total;
    $("#vSubmit").style.opacity = r.total ? 1 : .5;
  }
  function countUp(el, from, to) {
    if (calm || from === to) { el.textContent = "+" + to; return; }
    const t0 = performance.now(), dur = 380;
    const tick = (t) => { const k = Math.min(1, (t - t0) / dur); el.textContent = "+" + Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    setTimeout(() => (el.textContent = "+" + to), dur + 80);   // вкладка в фоне кадры не рисует — итог всё равно должен встать
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  }

  // Enter (или «Готово» на телефоне) в поле формы не должен отправлять поход раньше времени
  vf.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.tagName === "INPUT") e.preventDefault(); });
  vf.addEventListener("submit", async (e) => {
    e.preventDefault();
    const r = score();
    if (!r.total || vf.dataset.busy) return;
    let newBath = null;
    if (picked === "new") {
      const name = $("#nbName").value.trim();
      if (!name) { toast("Впиши название новой бани"); $("#nbName").focus(); return; }
      if (!$("#nbType").value) { toast("Выбери тип бани — от него зависит +1 за общественную"); $("#nbType").focus(); return; }
      newBath = { name, country: $("#nbCountry").value.trim() || null, region: $("#nbRegion").value.trim() || null, type: $("#nbType").value,
        ...(newPin ? { lat: newPin[0], lng: newPin[1], precision: "exact" } : {}) };
    }
    const payload = { bathId: picked.id, newBath, date: r.date, week: r.week, dur: r.dur, durs: durDiff(r.comp, durOver, r.dur),
      bathType: picked !== "new" && picked.t === "unknown" ? pickedType : null,
      companions: r.comp, player: r.player, lines: r.lines.filter((l) => l[1]), total: r.total };
    const files = [...($("#vPhotos")?.files || [])];   // форму сбросит следующее открытие — забираем сейчас
    const rows = peopleRows(r);   // для экрана «Отправлено» — пока выбор компании не сброшен
    vf.dataset.busy = "1"; $("#vSubmit span").textContent = "Отправляю…";
    try {
      const saved = await D.submitVisit(payload);
      const priceVal = priceIn($("#vPrice").value, $("#vPrCurrency").value.trim());
      if (priceVal > 0) {
        const wVal = $("#vPrWeekend [aria-pressed=true]").dataset.w;
        const isWeekend = wVal ? wVal === "1" : null;
        const beforeTime = $("#vPrBefore").value || null, currency = $("#vPrCurrency").value.trim() || null, durationMin = +$("#vPrDur").value || null;
        try {
          const pid = await D.submitBathPrice(payload.bathId, priceVal, currency, durationMin, isWeekend, beforeTime);
          if (pid) (prices[payload.bathId] ||= []).push({ id: pid, price: priceVal, currency: (currency || "RUB").toUpperCase(), duration_min: durationMin,
            is_weekend: isWeekend, before_time: beforeTime, price_date: new Date().toISOString().slice(0, 10) });
        } catch { /* поход важнее цены — если она не сохранилась, поход всё равно засчитан, отдельно не сообщаем */ }
      }
      const beerVal = priceIn($("#vPrBeer").value, $("#vPrCurrency").value.trim());
      if (beerVal > 0) {
        const currency = $("#vPrCurrency").value.trim() || null;
        try {
          const bid = await D.submitBeerPrice(payload.bathId, beerVal, currency);
          if (bid) (beerPrices[payload.bathId] ||= []).push({ id: bid, price: beerVal, currency: (currency || "RUB").toUpperCase(), price_date: new Date().toISOString().slice(0, 10) });
        } catch { /* поход важнее цены пива */ }
      }
      if (payload.createdBath) { const nb = payload.createdBath; hydrate(nb); baths.push(nb); byId.set(nb.id, nb); }
      if (payload.bathType && D.live) { const pb = byId.get(payload.bathId); if (pb && !pb.type) { pb.type = payload.bathType; pb.t = payload.bathType; } }
      if (D.live) visits.unshift({ id: saved.id, player: r.player, companions: r.comp, bathId: payload.bathId, date: r.date, posted: mskNow(), dur: r.dur, durs: payload.durs,
        lines: [], total: null, preview: r.total, status: "pending", enteredBy: r.player !== myNick ? myNick : null });
      leafBurst($("#vSubmit"));
      showSent(r, rows, payload.bathId);
      updateBadge(); render();
      if (!$("#view-feed").hidden) renderFeed();
      if (D.live && files.length) setTimeout(() => uploadPhotos(saved.id, payload.bathId, files), 1500);
    } catch (err) {
      toast("Поход не сохранился: " + err.message);
    } finally {
      delete vf.dataset.busy; $("#vSubmit span").textContent = "Отправить в Комиссию";
    }
  });
  // после отправки (03.11, макет): «С лёгким паром!», талон по людям и — пока помнишь — оценить баню
  function showSent(r, rows, bathId) {
    const b = byId.get(bathId) || r.bath;
    const when = whenLabel(r.date).replace(/^С/, "с").replace(/^В/, "в").replace(",", "");
    const rated = !!myRated?.has(bathId);
    $("#vSent").innerHTML = `<div class="vs-mark">${$("#addVisitBtn .cta-venik svg")?.outerHTML || ""}</div>
      <h2>С лёгким паром!</h2><p class="vs-sub">Комиссия проверит, бот напишет в Telegram.</p>
      <div class="ticket vs-ticket"><div class="vs-bath"><b>${esc(b?.name || "")}</b><small>${esc(when)} · ${r.dur > 150 ? "долгая" : "экспресс"}</small></div>
        ${rows.map((x) => rowHtml(x)).join("")}
        <div class="t-foot">В таблицу — после проверки Комиссии</div></div>
      ${D.live && bathId && !rated ? `<a class="rate-invite" href="rate.html?b=${bathId}"><span><b>Оцени баню, пока помнишь</b><small>минута, можно с отзывом</small></span><span class="go">Оценить</span></a>` : ""}
      <button type="button" class="cta big" id="vDone"><span>Готово</span></button>`;
    vf.classList.add("is-sent"); $("#vSent").hidden = false;
    $("#visitModal .sheet").scrollTop = 0;
    $("#vDone").onclick = () => { $("#visitModal").hidden = true; };
  }

  // листопад из дубовых листьев
  function leafBurst(from) {
    if (calm) return;
    const rc = from.getBoundingClientRect(), cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
    const colors = ["var(--oak)", "var(--oak-lite)", "var(--oak-deep)", "var(--honey)", "var(--ember)"];
    for (let i = 0; i < 18; i++) {
      const a = (Math.PI * 2 * i) / 18 + Math.random() * 0.4, dist = 90 + Math.random() * 140;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      el.setAttribute("viewBox", "-6 -17 12 18"); el.setAttribute("class", "fly");
      el.innerHTML = '<use href="#oak-leaf"/>';
      el.style.cssText = `left:${cx - 9}px;top:${cy - 12}px;--c:${colors[i % colors.length]};--dx:${Math.cos(a) * dist}px;--dy:${Math.sin(a) * dist - 60}px;--r:${Math.random() * 540 - 270}deg;animation-delay:${Math.random() * 80}ms`;
      document.body.append(el);
      setTimeout(() => el.remove(), 1500);
    }
  }

  // ---------- лента и модерация ----------
  // Комиссии — сколько ждёт её решения, участнику — сколько ждут его собственные походы
  function updateBadge() {
    const mine = (v) => !D.live || canModerate || v.player === me?.nick || v.companions.includes(me?.nick);
    const n = visits.filter((v) => v.status === "pending" && mine(v)).length;
    $("#pendingBadge").hidden = !n; $("#pendingBadge").textContent = n;
    $("#pendingBadge").title = canModerate ? "Ждут решения Комиссии" : "Твои походы на модерации";
  }
  const STATUS = { pending: "на модерации", ok: "засчитан", rejected: "отклонён" };
  // п. 5: у кого из похода в эти сутки в этой бане уже есть более ранний живой поход. Очки движок не срезает —
  // это подсказка Комиссии проверить дату (часто баню кидают за прошлый день)
  const repeatOf = (v) => v.status === "rejected" ? [] : [v.player, ...v.companions].filter((n) => visits.some((w) =>
    w.id !== v.id && w.status !== "rejected" && w.bathId === v.bathId && w.date.slice(0, 10) === v.date.slice(0, 10)
    && (w.date < v.date || (w.date === v.date && w.id < v.id)) && (w.player === n || w.companions.includes(n))));
  const fmtDate = (s) => new Date(s + ":00Z").toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  // 03.11: «Все · Мои · На проверке»; походы на проверке и так стоят первыми в своём дне
  let feedFilter = "all";
  let feedRatings = null;   // свежие оценки — для ленты; пришли — перерисовать, если лента открыта
  if (D.live && member) D.recentRatings().then((r) => { feedRatings = r; if (!$("#view-feed").hidden) renderFeed(); }).catch(() => {});
  let feedPhotos = {};   // фото походов — превью в строке; нажал — во весь экран
  if (D.live && member) D.feedPhotos().then((r) => { feedPhotos = r || {}; if (!$("#view-feed").hidden) renderFeed(); }).catch(() => {});
  $$("#feedFilter button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.f === feedFilter)));
  $("#feedFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    feedFilter = b.dataset.f;
    $$("#feedFilter button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderFeed();
  });
  function renderFeed() {
    if (!member) {
      $("#feed").innerHTML = `<div class="empty">${markSvg()}<b>Лента — для участников лиги</b><p>${me ? "Выбери свой ник из таблицы — Комиссия подтвердит, и лента откроется." : "Войди через Telegram тем же аккаунтом, что в группе."}</p><button class="cta" id="emptyLogin">${icon("check")}<span>${me ? "Кто ты в таблице?" : "Войти через Telegram"}</span></button></div>`;
      $("#emptyLogin").onclick = () => (me ? openClaim() : openLogin());
      return;
    }
    const sec = canModerate;   // Комиссия — это роль: переключатель «Режим Комиссии» убран (27.09)
    if (sec && D.live) renderSecPanel(); else $("#secPanel").innerHTML = "";
    // шапка: неделя — сколько походов и в скольких банях
    const wk = visits.filter((v) => v.status !== "rejected" && (v.week ?? weekOf(v.posted || v.date)) === curWeek);
    $("#feedWeek").innerHTML = `<b>W${curWeek}</b> · ${wk.length} ${plural(wk.length, "поход", "похода", "походов")} в ${new Set(wk.map((v) => v.bathId)).size} ${plural(new Set(wk.map((v) => v.bathId)).size, "бане", "банях", "банях")} за неделю`;
    const nPending = visits.filter((v) => v.status === "pending").length;
    $$("#feedFilter button").forEach((b) => {
      const label = { all: "Все", mine: "Мои", pending: "На проверке" }[b.dataset.f];
      b.innerHTML = `${label}${b.dataset.f === "pending" && nPending ? `<b>${nPending}</b>` : ""}`;
    });
    const pass = (v) => feedFilter === "all" || (feedFilter === "mine" ? inVisit(v) : v.status === "pending");
    const shown = visits.filter(pass);
    // оценки: к походу — если оценка по нему (visit_id) или по бане в течение двух недель после своего похода туда;
    // остальные — отдельной строкой «оценил»
    const attached = new Map(), loose = [];
    for (const r of feedRatings || []) {
      const nick = nickById[r.player_id]; if (!nick) continue;
      const rv = (reviews[r.bath_id] || []).find((x) => x.author === nick);
      const item = { nick, score: +r.overall, text: rv?.text || "", at: r.updated_at, bathId: r.bath_id };
      let v = r.visit_id ? visits.find((x) => x.id === r.visit_id) : null;
      if (!v) {
        const t = Date.parse(r.updated_at);
        v = visits.filter((x) => x.bathId === r.bath_id && x.status !== "rejected" && (x.player === nick || x.companions.includes(nick)))
          .map((x) => [x, t - Date.parse(x.date + ":00+03:00")]).filter(([, d]) => d >= 0 && d < 14 * 864e5).sort((a, b) => a[1] - b[1])[0]?.[0];
      }
      if (v) (attached.get(v.id) || attached.set(v.id, []).get(v.id)).push(item);
      else if (feedFilter === "all" || (feedFilter === "mine" && nick === myNick)) loose.push(item);
    }
    if (!shown.length && !loose.length) {
      $("#feed").innerHTML = visits.length ? `<div class="empty"><b>Здесь пусто</b><p>${feedFilter === "pending" ? "На проверке ничего нет — Комиссия всё разобрала." : "В этом разделе походов нет."}</p></div>`
        : `<div class="empty">${markSvg()}<b>Тут пока тихо</b><p>Добавь первую баню — поход появится здесь, а Комиссия засчитает его в таблицу.</p><button class="cta" id="emptyCta">${icon("plus")}<span>Добавить баню</span></button></div>`;
      $("#emptyCta")?.addEventListener("click", () => openVisit());
      return;
    }
    // по дням (МСК): походы — по времени захода, оценки без похода — по времени оценки
    const dayOf = (iso) => iso.slice(0, 10), today = mskNow().slice(0, 10), yest = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10);
    const dayName = (d) => d === today ? "Сегодня" : d === yest ? "Вчера"
      : new Date(d + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "long", ...(d.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}), timeZone: "UTC" });
    const entries = [...shown.map((v) => ({ kind: "visit", v, at: v.date })), ...loose.map((r) => ({ kind: "rate", r, at: mskIso(r.at) }))]
      .sort((a, b) => b.at.localeCompare(a.at));
    const days = [];
    for (const e of entries) { const d = dayOf(e.at); if (days[days.length - 1]?.d !== d) days.push({ d, items: [] }); days[days.length - 1].items.push(e); }
    const time = (iso) => iso.slice(11, 16).replace(/^0/, "");
    // своя длительность у кого-то из компании — «долгая · Шурик — экспресс»
    const durLabel = (v) => { const diff = Object.entries(v.durs || {}).filter(([, m]) => (m > 150) !== (v.dur > 150)).map(([n]) => n);
      return (v.dur > 150 ? "долгая" : "экспресс") + (diff.length ? ` · ${diff.map(esc).join(", ")} — ${v.dur > 150 ? "экспресс" : "долгая"}` : ""); };
    const stack = (names, cls = "") => `<span class="stack ${cls}">${names.slice(0, 3).map((n) => ava(n)).join("")}</span>`;
    const people = (v) => [v.player, ...v.companions];
    // оценки в строке похода (03.11): без текста — одной строкой чипов «Фил 4,8 🌿», с отзывом — имя и оценка, ниже цитата
    // в две строки (нажал — целиком). В большой компании так не растягивается на экран
    const rchip = (r) => `<span class="f-rchip">${esc(r.nick)} <b>${fmt(r.score)}</b>${fanSvg(r.score)}</span>`;
    const rateLine = (list) => {
      const bare = list.filter((r) => !r.text), said = list.filter((r) => r.text);
      return (bare.length ? `<div class="f-rates">${bare.map(rchip).join("")}</div>` : "")
        + said.map((r) => `<div class="f-rate"><div class="f-rates">${rchip(r)}</div><blockquote class="f-rv" title="Нажми — отзыв целиком"><span>${esc(r.text)}</span></blockquote></div>`).join("");
    };
    const card = (v) => {
      const b = byId.get(v.bathId), who = people(v);
      const rep = repeatOf(v);
      const pts = who.map((n) => v.pts?.[n] != null ? `<span class="f-pt">${esc(n)} <b>+${fmt(v.pts[n])}</b></span>` : "").join("");
      return `<article class="post f-pending">
        <div class="f-head">${stack(who)}<div class="f-who"><b>${esc(who.length > 2 ? `${who[0]}, ${who[1]} и ещё ${who.length - 2}` : who.join(" и "))}</b><small>${time(v.date)} · W${v.week ?? weekOf(v.posted || v.date)}${v.enteredBy ? ` · внёс ${esc(v.enteredBy)}` : ""}</small></div><span class="status pending">на проверке</span></div>
        <a class="f-bath" href="#map" data-bath="${v.bathId}">${b ? tdot(b.t) : ""}<span><b>${esc(b?.name || "баня")}</b><small>${[b && esc(where(b)), durLabel(v), v.companions.length && "компания"].filter(Boolean).join(" · ")}</small></span></a>
        ${pts ? `<div class="f-pts">${pts}</div>` : `<div class="f-why">${who.map((n) => { const r = previewFor(v, n); return r ? `<div class="f-why-row"><b>${esc(n)}</b><b class="f-why-pts">+${r.total}</b><small>${r.lines.map(([t, k]) => k ? `${t}${k > 1 ? ` ${k}` : ""}` : t).join(" · ")}</small></div>` : ""; }).join("")}</div>`}
        ${rep.length ? `<div class="warn">⚠️ похоже на повтор бани в те же сутки${rep.length < who.length ? " у " + rep.map(esc).join(", ") : ""} — проверь дату (п. 5)</div>` : ""}
        ${/^https:\/\/t\.me\//.test(v.tgLink || "") ? `<a class="f-tg" href="${esc(v.tgLink)}" target="_blank" rel="noopener">пост в группе ↗</a>` : ""}
        ${sec || inVisit(v) ? `<div class="post-actions">
          ${sec ? `<button class="btn solid" data-ok="${v.id}">${icon("check")}Засчитать</button><button class="btn danger" data-no="${v.id}">Отклонить</button>` : ""}
          ${inVisit(v) ? `<button class="btn" data-addph="${v.id}" aria-label="Добавить фото">📷</button>` : ""}
          ${sec && D.live ? `<button class="btn" data-edit="${v.id}" aria-label="Изменить поход">${icon("pencil")}</button>` : ""}
        </div>` : ""}
      </article>`;
    };
    const row = (e) => {
      if (e.kind === "rate") {
        const r = e.r, b = byId.get(r.bathId);
        // оценка без похода: отзыв — такой же цитатой, как в строке похода (две строки, нажал — целиком)
        return `<div class="frow">${stack([r.nick])}<div class="f-main"><a class="f-title" href="#map" data-bath="${r.bathId}">${esc(r.nick)} оценил ${esc(b?.name || "баню")}</a>${r.text ? "" : "<small>оценка лиги · без отзыва</small>"}
          ${r.text ? `<div class="f-rate"><blockquote class="f-rv" title="Нажми — отзыв целиком"><span>${esc(r.text)}</span></blockquote></div>` : ""}</div><span class="rv-rate">${fmt(r.score) ? `<b>${fmt(r.score)}</b>` : ""}${fanSvg(r.score)}</span></div>`;
      }
      const v = e.v, b = byId.get(v.bathId), who = people(v);
      const split = who.map((n) => `<span class="f-pt${n === myNick ? " me" : ""}">${esc(n)}${v.pts?.[n] != null ? ` <b>+${fmt(v.pts[n])}</b>` : ""}</span>`).join("");
      const rejected = v.status === "rejected";
      return `<div class="frow${rejected ? " rejected" : ""}">${stack(who)}<div class="f-main">
          <a class="f-title" href="#map" data-bath="${v.bathId}">${esc(b?.name || "баня")}</a>
          <small>${time(v.date)} · ${durLabel(v)}${v.companions.length ? ` · компания` : ""}${rejected ? ` · <span class="f-no">отклонён${v.reason ? `: ${esc(v.reason)}` : ""}</span>` : ""}</small>
          <div class="f-split">${split}</div>
          ${(feedPhotos[v.id] || []).length ? `<div class="f-photos">${feedPhotos[v.id].slice(0, 6).map((ph, i) => `<button type="button" class="f-ph" data-fph="${v.id}:${i}" aria-label="Фото ${i + 1}"><img src="${esc(ph.thumb)}" alt="" loading="lazy" onerror="this.remove()"></button>`).join("")}${feedPhotos[v.id].length > 6 ? `<button type="button" class="f-ph more" data-fph="${v.id}:6">+${feedPhotos[v.id].length - 6}</button>` : ""}</div>` : ""}
          ${rateLine(attached.get(v.id) || [])}
        </div>
        ${sec && D.live || inVisit(v) ? `<span class="f-acts">${inVisit(v) && !rejected ? `<button class="f-ic" data-addph="${v.id}" aria-label="Добавить фото" title="Добавить фото">${icon("camplus")}</button>` : ""}${sec && D.live ? `<button class="f-ic" data-edit="${v.id}" aria-label="Изменить поход">${icon("pencil")}</button>` : ""}</span>` : ""}
      </div>`;
    };
    $("#feed").innerHTML = days.map((g) => {
      const pend = g.items.filter((e) => e.kind === "visit" && e.v.status === "pending"), rest = g.items.filter((e) => !(e.kind === "visit" && e.v.status === "pending"));
      return `<section class="f-day"><h3>${dayName(g.d)}</h3>${pend.map((e) => card(e.v)).join("")}${rest.length ? `<div class="f-list">${rest.map(row).join("")}</div>` : ""}</section>`;
    }).join("");
  }
  $("#feed").addEventListener("click", (e) => {
    const rv = e.target.closest(".f-rv"); if (rv) { rv.classList.toggle("open"); return; }
    const fph = e.target.closest("[data-fph]"); if (fph) { const [vid, i] = fph.dataset.fph.split(":"); return openPhotos(feedPhotos[vid] || [], +i); }   // длинный отзыв — две строки, нажал — целиком
    const ok = e.target.closest("[data-ok]")?.dataset.ok, no = e.target.closest("[data-no]")?.dataset.no, bl = e.target.closest("[data-bath]");
    const ed = e.target.closest("[data-edit]")?.dataset.edit, ph = e.target.closest("[data-addph]")?.dataset.addph;
    if (ed) return openEdit(visits.find((x) => x.id === +ed));
    if (ph) return pickPhotos(visits.find((x) => x.id === +ph));
    if (ok || no) {
      const v = visits.find((x) => x.id === +(ok || no));
      // причину отказа увидит автор — и в ленте, и в чате; «Отмена» — не отклонять
      const reason = no ? prompt("Причина отказа — её увидит автор (можно оставить пустой)", "") : null;
      if (no && reason === null) return;
      const btns = $$("button", e.target.closest(".post-actions")); btns.forEach((b) => (b.disabled = true));
      D.moderate(v.id, ok ? "ok" : "rejected", reason?.trim()).then(() => {
        v.status = ok ? "ok" : "rejected"; v.reason = reason?.trim() || null;
        updateBadge(); renderFeed(); toast(ok ? "Засчитано — таблица пересчитывается" : "Отклонено");
        recomputeSoon();
      }).catch((err) => { btns.forEach((b) => (b.disabled = false)); toast("Не получилось: " + err.message); });
    } else if (bl) { e.preventDefault(); show("map"); openBath(+bl.dataset.bath, true); }
  });

  // ---------- свежие данные после решений Комиссии: таблица, гонка, карта — без перезагрузки страницы ----------
  let refreshTimer = null;
  function recomputeSoon() {
    clearTimeout(refreshTimer);
    // пачку решений подряд пересчитываем один раз
    refreshTimer = setTimeout(async () => {
      try { await D.recompute(); await refreshData(); } catch (err) { toast("Таблица не пересчиталась: " + err.message); }
    }, 1200);
  }
  async function refreshData() {
    if (!D.live) return;
    const fresh = await D.load();
    standings.splice(0, standings.length, ...fresh.standings);
    const freshIds = new Set(fresh.baths.map((b) => b.id));
    for (let i = baths.length - 1; i >= 0; i--) if (!freshIds.has(baths[i].id)) { byId.delete(baths[i].id); baths.splice(i, 1); }
    for (const nb of fresh.baths) {
      const b = byId.get(nb.id);
      if (!b) { hydrate(nb); baths.push(nb); byId.set(nb.id, nb); continue; }
      Object.assign(b, { v26: nb.v26, hist: nb.hist, histBy: nb.histBy, type: nb.type, country: nb.country, region: nb.region,
        lat: nb.lat, lng: nb.lng, precision: nb.precision, status: nb.status, isNew: nb.isNew, closed_on: nb.closed_on });
      hydrate(b);
    }
    visits = fresh.visits;
    Object.keys(reviews).forEach((k) => delete reviews[k]); Object.assign(reviews, fresh.reviews);
    Object.keys(prices).forEach((k) => delete prices[k]); Object.assign(prices, fresh.prices);
    Object.keys(beerPrices).forEach((k) => delete beerPrices[k]); Object.assign(beerPrices, fresh.beerPrices);
    rankTable(); renderKpis(); render(); renderRace(); renderTable(); updateBadge();
    if (!$("#tWeek").hidden) renderWeek();
    if (!$("#view-feed").hidden) renderFeed();
  }

  // ---------- правка заявки Комиссией ----------
  function openEdit(v) {
    const f = $("#editForm");
    let bath = byId.get(v.bathId), people = [v.player, ...v.companions], status = v.status, long = v.dur > 150;
    let durs = { ...(v.durs || {}) }, split = Object.keys(durs).length > 0;   // своя длительность у кого-то из компании
    let typed = {};   // введённое в поля — чтобы не терялось при перерисовке
    const keep = () => {
      typed = { entered: $("#eEntered")?.value, posted: $("#ePosted")?.value, reason: $("#eReason")?.value };
    };
    function draw() {
      f.innerHTML = `
        <div class="eyebrow">Заявка №${v.id} · ${esc(v.player)}</div>
        <h2 id="editTitle">Правка заявки</h2>
        <div class="field"><span class="lab">Баня</span>
          <div class="picked"><span><b>${esc(bath?.name || "—")}</b><small>${bath ? `${tdot(bath.t)} ${TYPE_LABEL[bath.t]} · ${esc(where(bath))}` : ""}</small></span>
            <button type="button" class="btn sm" id="eBathChange">Сменить</button></div>
          <label class="searchbox" id="eBathBox" hidden>${icon("search")}<input id="eBathQ" placeholder="Найти баню" autocomplete="off"></label>
          <div class="suggest" id="eSuggest" hidden></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="eEntered">Заход, МСК</label><input id="eEntered" class="inp" type="datetime-local" value="${v.date}"></div>
          <div class="field"><label for="ePosted">Пост, МСК — по нему неделя</label><input id="ePosted" class="inp" type="datetime-local" value="${v.posted || v.date}"><span class="hint" id="eWeek"></span></div>
        </div>
        <div class="field"><span class="lab">Долгая или экспресс</span>
          <div class="seg" id="eDur">${[[false, "⚡ Экспресс — до 2,5 ч"], [true, "🔥 Долгая — больше 2,5 ч"]].map(([l, t]) => `<button type="button" data-long="${l ? 1 : 0}" aria-pressed="${l === long}">${t}</button>`).join("")}</div>
          <span class="hint">У автора и по умолчанию у всей компании. +1 за долгий — каждому, кто был дольше 2,5 часа.</span></div>
        <div class="field"><span class="lab">Компания</span>
          <div id="ePeople">${people.map((n) => `<div class="erow">${ava(n, "sm")}<b>${esc(n)}</b>${n === v.player ? '<span class="hint">автор</span>' : `<button type="button" class="linkbtn" data-rm="${esc(n)}">убрать</button>`}${split && n !== v.player ? durSeg(n, durs[n] ?? (long ? 180 : 120), "ed") : ""}</div>`).join("")}</div>
          ${people.length > 1 ? (split ? `<p class="hint">${DURS_NOTE}</p><button type="button" class="linkbtn durs-toggle" id="eDursSame">Всем одинаково</button>`
            : '<button type="button" class="linkbtn durs-toggle" id="eDursToggle">Кто-то ушёл раньше или остался дольше?</button>') : ""}
          <select class="sel" id="eAdd"><option value="">+ добавить участника</option>${players.filter((p) => !people.includes(p)).sort((a, b) => a.localeCompare(b, "ru")).map((p) => `<option>${esc(p)}</option>`).join("")}</select>
        </div>
        <div class="field"><span class="lab">Статус</span>
          <div class="seg" id="eStatus">${["pending", "ok", "rejected"].map((st) => `<button type="button" data-st="${st}" aria-pressed="${st === status}">${STATUS[st]}</button>`).join("")}</div>
          <input class="inp" id="eReason" placeholder="Причина отказа — увидит автор" value="${esc(v.reason || "")}" ${status === "rejected" ? "" : "hidden"}>
        </div>
        <div class="edit-actions"><button type="button" class="btn" data-close-edit>Отмена</button><button class="cta" type="submit">${icon("check")}<span>Сохранить</span></button></div>`;
      if (typed.entered) $("#eEntered").value = typed.entered;
      if (typed.posted) $("#ePosted").value = typed.posted;
      if (typed.reason != null && $("#eReason")) $("#eReason").value = typed.reason;
      const weekHint = () => ($("#eWeek").textContent = $("#ePosted").value ? `неделя W${weekOf($("#ePosted").value)}` : "");
      weekHint(); $("#ePosted").oninput = weekHint;
      $("#eBathChange").onclick = () => { $("#eBathBox").hidden = false; $("#eBathQ").focus(); };
      $("#eBathQ").oninput = () => {
        const q = $("#eBathQ").value.trim().toLowerCase(), sg = $("#eSuggest");
        if (q.length < 2) { sg.hidden = true; return; }
        sg.innerHTML = baths.filter((b) => b.search.includes(q)).sort((a, b) => b.nAll - a.nAll).slice(0, 7)
          .map((b) => `<button type="button" data-id="${b.id}"><span class="sn">${tdot(b.t)}${esc(b.name)}</span><small>${esc(b.region || b.country || "")}</small></button>`).join("");
        sg.hidden = false;
      };
      $("#eSuggest").onclick = (e) => { const b = e.target.closest("button[data-id]"); if (b) { keep(); bath = byId.get(+b.dataset.id); draw(); } };
      $$("[data-rm]", f).forEach((b) => (b.onclick = () => { keep(); people = people.filter((n) => n !== b.dataset.rm); delete durs[b.dataset.rm]; draw(); }));
      $$("[data-ed]", f).forEach((b) => (b.onclick = () => { keep(); durs[b.dataset.ed] = +b.dataset.m; draw(); }));
      $("#eDursToggle", f)?.addEventListener("click", () => { keep(); split = true; draw(); });
      $("#eDursSame", f)?.addEventListener("click", () => { keep(); split = false; durs = {}; draw(); });
      $("#eAdd").onchange = () => { const n = $("#eAdd").value; keep(); if (n) people.push(n); draw(); };
      $$("#eStatus button").forEach((b) => (b.onclick = () => { keep(); status = b.dataset.st; draw(); }));
      $$("#eDur button").forEach((b) => (b.onclick = () => { keep(); long = b.dataset.long === "1"; draw(); }));
      $$("[data-close-edit]", f).forEach((b) => (b.onclick = () => ($("#editModal").hidden = true)));
    }
    f.onsubmit = async (e) => {
      e.preventDefault(); keep();
      // по регламенту важно одно — дольше 2,5 часа или нет; минуты не спрашиваем
      const dur = long ? (v.dur > 150 ? v.dur : 180) : (v.dur <= 150 ? v.dur : 120);
      const patch = { bath_id: bath.id, entered_at: $("#eEntered").value + ":00+03:00", posted_at: $("#ePosted").value + ":00+03:00", duration_min: dur, status,
        reject_reason: status === "rejected" ? ($("#eReason").value.trim() || null) : null,
        ...(status !== v.status ? { moderated_by: data.playerIds?.[me?.nick], moderated_at: new Date().toISOString() } : {}) };
      try {
        const own = split ? durDiff(people.filter((n) => n !== v.player), durs, dur) : {};
        await D.updateVisit(v.id, patch, people, own);
        Object.assign(v, { bathId: bath.id, date: $("#eEntered").value, posted: $("#ePosted").value, dur, durs: own, status, reason: patch.reject_reason,
          companions: people.filter((n) => n !== v.player), week: undefined, total: status === "ok" ? v.total : null });
        $("#editModal").hidden = true; updateBadge(); renderFeed();
        toast("Сохранено — таблица пересчитывается");
        recomputeSoon();
      } catch (err) { toast("Не сохранилось: " + err.message); }
    };
    draw();
    $("#editModal").hidden = false;
  }

  // Комиссия: заявки «это я» и новые бани
  async function renderSecPanel() {
    const box = $("#secPanel");
    const accounts = await D.pendingAccounts().catch(() => []);
    const newOnes = baths.filter((b) => b.isNew);
    if (!accounts.length && !newOnes.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="post sec"><div class="kom-title"><svg aria-hidden="true"><use href="#i-seal"/></svg>Стол Комиссии</div>
      ${accounts.length ? `<h3>Заявки «это я» · ${accounts.length}</h3>${accounts.map((a) => `<div class="sec-row"><span><b>${esc(a.tg_name || "")}</b> ${a.tg_username ? "@" + esc(a.tg_username) : ""} — говорит, что это <b>${esc(a.claimed_nick)}</b></span>
        <button class="btn sm solid" data-link="${a.id}" data-nick="${esc(a.claimed_nick)}">Подтвердить</button></div>`).join("")}` : ""}
      ${newOnes.length ? `<h3>Новые бани · ${newOnes.length}</h3>${newOnes.map((b) => `<div class="sec-row">
        <input class="inp sm" data-bname="${b.id}" value="${esc(b.name)}" placeholder="Название — как в справочнике" aria-label="Название бани">
        <input class="inp sm" data-bcountry="${b.id}" value="${esc(b.country || "")}" placeholder="Страна" aria-label="Страна">
        <input class="inp sm" data-bregion="${b.id}" value="${esc(b.region || "")}" placeholder="Регион — как в таблице" aria-label="Регион">
        <select class="sel" data-btype="${b.id}"><option value="public" ${b.type === "public" ? "selected" : ""}>Общественная</option><option value="spa" ${b.type === "spa" ? "selected" : ""}>Хуитнес</option><option value="private" ${b.type === "private" ? "selected" : ""}>Частная</option></select>
        <button class="btn sm solid" data-bok="${b.id}">Принять</button><button class="btn sm danger" data-bno="${b.id}">Дубль</button></div>`).join("")}` : ""}
    </div>`;
  }
  $("#secPanel").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-dupq]"); if (!inp) return;
    const id = +inp.dataset.dupq, q = inp.value.trim().toLowerCase(), sg = $(`[data-dupsg="${id}"]`);
    if (q.length < 2) { sg.hidden = true; return; }
    sg.innerHTML = baths.filter((b) => b.id !== id && !b.isNew && b.search.includes(q)).sort((a, b) => b.nAll - a.nAll).slice(0, 6)
      .map((b) => `<button type="button" data-dupof="${id}" data-dupto="${b.id}"><span class="sn">${tdot(b.t)}${esc(b.name)}</span><small>${esc(b.region || b.country || "")}</small></button>`).join("")
      || '<div class="more">Не нашлось — попробуй другое слово</div>';
    sg.hidden = false;
  });
  $("#secPanel").addEventListener("click", async (e) => {
    const t = e.target.closest("button"); if (!t) return;
    try {
      if (t.dataset.link) { await D.linkAccount(t.dataset.link, t.dataset.nick); toast(`${t.dataset.nick} привязан`); }
      if (t.dataset.bok) {
        // страна и регион нужны для бонусов п. 14 — Комиссия проверяет их вместе с типом
        const id = +t.dataset.bok, b = byId.get(id), p = matchPlace($(`[data-bcountry="${id}"]`).value.trim(), $(`[data-bregion="${id}"]`).value.trim());
        const name = $(`[data-bname="${id}"]`).value.trim() || b.name;   // Комиссия может поправить, как назвал автор
        const patch = { status: "ok", name, type: $(`[data-btype="${id}"]`).value, country: p.country || null, region: p.region || null };
        await D.moderateBath(id, patch);
        Object.assign(b, { isNew: false, name, t: patch.type, type: patch.type, country: patch.country, region: patch.region });
        hydrate(b);
        toast("Баня в справочнике"); recomputeSoon();
      }
      if (t.dataset.bno) {
        // дубль: сначала выбрать оригинал — походы переедут в него, иначе они останутся привязаны к отклонённой бане
        const row = t.closest(".sec-row"), id = +t.dataset.bno;
        row.insertAdjacentHTML("beforeend", `<div class="dup-pick"><input class="inp sm" data-dupq="${id}" placeholder="Какая это баня из справочника?" aria-label="Оригинал бани"><div class="suggest" data-dupsg="${id}" hidden></div></div>`);
        t.disabled = true; $("[data-dupq]", row).focus();
        return;
      }
      if (t.dataset.dupto) {
        const dup = +t.dataset.dupof, orig = +t.dataset.dupto;
        await D.mergeBath(dup, orig);
        visits.forEach((v) => { if (v.bathId === dup) v.bathId = orig; });
        byId.get(dup).isNew = false; byId.get(dup).status = "rejected";
        toast(`Походы перенесены в «${byId.get(orig).name}», дубль убран`); recomputeSoon();
      }
      renderSecPanel();
    } catch (err) { toast("Не получилось: " + err.message); }
  });

  // ---------- общее ----------
  $$("[data-close]").forEach((b) => b.addEventListener("click", () => (b.closest(".modal").hidden = true)));
  // открылось окно — шаг в истории, чтобы «Назад» закрыл его, а не ушёл с сайта
  const modalSeen = new MutationObserver((ms) => ms.forEach((m) => {
    const el = m.target;
    if (el.hidden || m.oldValue === null) return;   // закрылось или уже было открыто
    if (!steps.slice(1, depth + 1).some((s) => s.type === "modal" && s.id === el.id && stepLive(s))) pushStep({ type: "modal", id: el.id });
  }));
  $$(".modal[id]").forEach((el) => modalSeen.observe(el, { attributes: true, attributeFilter: ["hidden"], attributeOldValue: true }));
  // формы (поход, правка заявки) не закрываем случайным тапом мимо и Esc — иначе вписанное пропадает; закрывает крестик
  const FORMS = ["visitModal", "editModal"];
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m && !FORMS.includes(m.id)) m.hidden = true; }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $$(".modal").filter((m) => !m.hidden && !FORMS.includes(m.id));
    if (open.length) open.forEach((m) => (m.hidden = true)); else if (!$("#drawer").hidden && $$(".modal").every((m) => m.hidden)) closeBath();
  });
  let tt;
  function toast(msg, html, ms = 3000) {
    $(".toast")?.remove(); clearTimeout(tt);
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status");
    t[html ? "innerHTML" : "textContent"] = msg; document.body.append(t);
    tt = setTimeout(() => t.remove(), ms);
  }

  // ---------- вход через Telegram ----------
  // вход полноценной страницей Telegram (без всплывающих окон): Telegram возвращает на сайт с #tgAuthResult=…
  // Вход (16.10) — кодом из бота: виджет Telegram просит номер телефона и подтверждение на своей странице, это долго.
  // Телефон — кнопка сразу в бота; компьютер — QR для камеры телефона и код, который можно прислать боту. В боте
  // «✅ Да, это я» — и сайт, который опрашивает код раз в 2 с, входит сам. Код с секретом лежит в браузере до 10 минут:
  // Telegram, открытый со ссылки, бывает, перезапускает страницу — вернулся, и вход подхватывается (resumeCodeLogin).
  // Виджет остался «другими способами».
  const TG_ICON = `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 4.5 2.8 11.7c-1 .4-1 1.8.1 2.1l4.6 1.4 1.8 5.5c.3.8 1.3 1 1.9.4l2.6-2.5 4.7 3.4c.8.6 1.9.1 2.1-.9L23 5.9c.2-1.1-.8-1.9-1.5-1.4Z" style="fill:currentColor;stroke:none"/></svg>`;
  const LOGIN_KEY = "ebl-login-code";
  const LOGIN_LEAD = "Через нашего бота в Telegram — без паролей и номера телефона.";
  const loginSteps = (list) => `<ol class="login-steps">${list.map((t) => `<li><span>${t}</span></li>`).join("")}</ol>`;
  let loginRun = 0, qrReady = null;
  const savedCode = () => { try { const c = JSON.parse(localStorage.getItem(LOGIN_KEY)); return c && Date.parse(c.expires_at) > Date.now() + 60e3 ? c : null; } catch { return null; } };
  const saveCode = (c) => { try { c ? localStorage.setItem(LOGIN_KEY, JSON.stringify(c)) : localStorage.removeItem(LOGIN_KEY); } catch { /* приватный режим — просто без подхвата */ } };
  // библиотека QR нужна только здесь — грузим при открытии окна; адрес с версией ставит deploy.sh (meta в index.html)
  const loadQr = () => (qrReady ??= new Promise((ok, no) => {
    const el = document.createElement("script");
    el.src = document.querySelector('meta[name="ebl-qr"]')?.content || "vendor/qrcode.js";
    el.onload = ok; el.onerror = () => { qrReady = null; no(new Error("QR не загрузился")); };
    document.head.append(el);
  }));
  // пауза между опросами; вернулся на страницу (из Telegram) — опрашиваем сразу
  const nap = (ms) => new Promise((ok) => {
    const done = () => { clearTimeout(t); document.removeEventListener("visibilitychange", vis); ok(); };
    const vis = () => { if (!document.hidden) done(); };
    const t = setTimeout(done, ms);
    document.addEventListener("visibilitychange", vis);
  });

  function openLogin() {
    if (!D.live) return;
    const cfg = window.EBL_CONFIG;
    if (!cfg.telegramBot) return toast("Вход через Telegram откроется совсем скоро");
    $("#loginBody").innerHTML = `<div class="eyebrow">Для участников лиги</div><h2>Вход в ЕБЛ</h2>
      <div class="login-way" id="loginWay"><p class="lead">${LOGIN_LEAD}</p><p class="login-wait"><i aria-hidden="true"></i>Готовлю вход…</p></div>
      <p class="hint login-err" id="loginErr"></p>
      ${cfg.telegramBotId ? `<p class="hint login-alt"><button class="linkbtn" id="loginAlt">Другие способы входа</button></p>` : ""}`;
    if ($("#loginAlt")) $("#loginAlt").onclick = widgetLogin;
    $("#loginModal").hidden = false;
    codeLogin(++loginRun, 0);
  }

  async function codeLogin(run, renewed) {
    const cfg = window.EBL_CONFIG, way = $("#loginWay");
    const alive = () => run === loginRun && !$("#loginModal").hidden && way.isConnected;
    let c = renewed ? null : savedCode();
    if (!c) {
      try { c = await D.loginCode(); } catch (err) { if (alive()) $("#loginErr").textContent = "Не получилось начать вход: " + err.message; return; }
      saveCode(c);
    }
    if (!alive()) return;
    const link = `https://t.me/${cfg.telegramBot}?start=login_${c.code}`;
    const chip = `<button type="button" class="login-code" id="loginCopy" title="Скопировать код">${c.code.slice(0, 3)}-${c.code.slice(3)}</button>`;
    const phone = matchMedia("(pointer: coarse)").matches;
    way.innerHTML = `<p class="lead">${LOGIN_LEAD}</p>` + (phone
      ? `<a class="cta big tg-btn" id="botLogin" href="${esc(link)}">${TG_ICON}<span>Войти через Telegram</span></a>
        ${loginSteps(["Откроется наш бот — нажми «Старт»", "Потом «Да, это я»", "Вернись сюда — ты уже внутри"])}
        <p class="login-wait"><i aria-hidden="true"></i>Ждём подтверждения · код ${chip}</p>`
      : `<div class="login-scan">
          <div class="login-qr" id="loginQr" role="img" aria-label="QR-код для входа через бота"></div>
          ${loginSteps(["Наведи камеру телефона", "В Telegram нажми «Старт»", "Нажми «Да, это я» — сайт войдёт сам"])}
        </div>
        <p class="login-wait"><i aria-hidden="true"></i>Ждём подтверждения в боте</p>
        <p class="hint login-more">Telegram открыт на этом компьютере? <a href="${esc(link)}" target="_blank" rel="noopener">Открой бота здесь</a> —
          код подставится сам. Или пришли боту @${esc(cfg.telegramBot)} код ${chip}</p>`);
    $("#loginCopy").onclick = () => navigator.clipboard?.writeText(c.code).then(() => toast("Код скопирован"), () => toast("Код: " + c.code));
    if (!phone) loadQr().then(() => {
      if (!alive()) return;
      const q = window.qrcode(0, "M");
      q.addData(link); q.make();
      $("#loginQr").innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }).catch(() => $("#loginQr")?.remove());

    while (alive()) {
      await nap(2000);
      if (!alive()) return;
      if (document.hidden) continue;
      try {
        if (await D.loginPoll(c.code, c.secret)) {
          saveCode(null);
          way.innerHTML = `<p class="login-done">✅ Готово — входим…</p>`;
          $("#loginAlt")?.remove();
          location.reload();
          return;
        }
      } catch (err) {
        if (!alive()) return;
        if (!err.status || err.status >= 500 || err.status === 429) continue;   // связь моргнула — спросим ещё раз
        saveCode(null);
        // код устарел — выдаём новый, пока окно открыто (до часа); «Нет» в боте или чужой код — начать заново
        if (err.status === 410 && renewed < 6) return codeLogin(run, renewed + 1);
        way.innerHTML = `<p class="lead">${esc(err.status === 403 ? "Вход отменён в боте." : err.message)}</p>
          <button class="cta" id="loginAgain" style="justify-self:start"><span>Начать заново</span></button>`;
        $("#loginAgain").onclick = () => codeLogin(++loginRun, 1);
        return;
      }
    }
  }

  // подтвердил в боте, а страницу Telegram перезапустил — входим, не дожидаясь, пока снова откроют окно
  async function resumeCodeLogin() {
    const c = savedCode();
    if (!c || me) return;
    try { if (await D.loginPoll(c.code, c.secret)) { saveCode(null); location.reload(); } }
    catch (err) { if (err.status && err.status < 500 && err.status !== 429) saveCode(null); }
  }

  // «Другие способы» — прежний вход через страницу Telegram (oauth.telegram.org → #tgAuthResult)
  function widgetLogin() {
    const cfg = window.EBL_CONFIG;
    loginRun++;   // код больше не опрашиваем
    $("#loginWay").innerHTML = `<p class="lead">Обычный вход Telegram: откроется его страница — подтверди вход, и тебя вернёт сюда.</p>
      <button class="cta big tg-btn" id="tgLogin">${TG_ICON}<span>Войти через страницу Telegram</span></button>
      <p class="hint">Тем же аккаунтом, что в группе. Мы видим имя, username и фото профиля — телефон остаётся у Telegram.</p>`;
    $("#loginAlt").textContent = "Войти через бота";
    $("#loginAlt").onclick = () => { $("#loginAlt").textContent = "Другие способы входа"; $("#loginAlt").onclick = widgetLogin; codeLogin(++loginRun, 0); };
    $("#tgLogin").onclick = () => {
      const back = location.origin + location.pathname;
      location.href = "https://oauth.telegram.org/auth?bot_id=" + cfg.telegramBotId + "&origin=" + encodeURIComponent(location.origin)
        + "&request_access=write&return_to=" + encodeURIComponent(back);
    };
  }
  // возврат от Telegram: #tgAuthResult=<base64 JSON>
  async function finishTelegramLogin() {
    const m = location.hash.match(/tgAuthResult=([^&]+)/);
    if (!m) return false;
    history.replaceState(history.state, "", location.pathname);
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = decodeURIComponent(escape(atob(b64 + "===".slice((b64.length + 3) % 4))));
      const user = JSON.parse(json);
      if (!user || user === false) throw new Error("Telegram не подтвердил вход");
      toast("Входим…");
      await D.login(user);
      location.reload();
    } catch (err) {
      openLogin();
      $("#loginErr").textContent = "Не получилось войти: " + err.message;
    }
    return true;
  }
  function openClaim() {
    const waiting = me?.claimedNick;
    $("#loginBody").innerHTML = `<div class="eyebrow">Почти готово</div><h2>Кто ты в таблице?</h2>
      ${waiting ? `<p class="lead">Заявка ушла: ты — <b>${esc(waiting)}</b>. Как только Комиссия подтвердит, откроются лента и отметки походов.</p>` :
      `<p class="lead">Выбери свой ник — Комиссия подтвердит, что это ты.</p>`}
      <div class="grid2"><select id="claimNick" class="sel">${[...players].sort((a, b) => a.localeCompare(b, "ru")).map((p) => `<option ${p === waiting ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>
      <button class="cta" id="claimBtn"><span>${waiting ? "Поменять заявку" : "Это я"}</span></button></div>
      <p class="hint" style="margin-top:14px"><button class="linkbtn" id="logoutBtn">Выйти</button></p>`;
    $("#claimBtn").onclick = async () => {
      try { await D.claim($("#claimNick").value); toast("Заявка ушла в Комиссию"); me.claimedNick = $("#claimNick").value; openClaim(); renderMe(); }
      catch (err) { toast(err.message); }
    };
    $("#logoutBtn").onclick = async () => { await D.logout(); location.reload(); };
    $("#loginModal").hidden = false;
  }
  function renderMe() {
    const btn = $("#meBtn");
    if (!D.live || (!me && !window.EBL_CONFIG.telegramBot)) { btn.hidden = true; return; }
    btn.hidden = false;
    btn.classList.toggle("guest", !me);
    btn.setAttribute("aria-label", !me ? "Войти через Telegram" : me.nick ? `Профиль: ${me.nick}` : "Выбрать свой ник");   // «Войти» видно всегда, ник на узком экране прячем до аватарки
    if (!me) btn.innerHTML = `${icon("check")}<span class="me-name">Войти</span>`;
    else if (!me.nick) btn.innerHTML = `${ava(me.claimedNick || "?")}<span class="me-name">${me.claimedNick ? "Ждём Комиссию" : "Кто ты?"}</span>`;
    else btn.innerHTML = `${ava(me.nick)}<span class="me-name">${esc(me.nick)}</span>`;
    btn.onclick = () => {
      if (!me) return openLogin();
      if (!me.nick) return openClaim();
      // быстрые действия (18.10): окно было почти пустым — «Мой сезон» и «Выйти»
      const mine = visits.filter((v) => v.player === me.nick || v.companions.includes(me.nick));
      const pend = mine.filter((v) => v.status === "pending").length;
      const place = ranked.find((r) => r.name === me.nick)?.place;
      $("#loginBody").innerHTML = `<div class="p-mini">${avaEdit("lg")}<div><div class="eyebrow">${me.isCommission ? "Комиссия ЕБЛ" : "Участник лиги"}</div><h2>${esc(me.nick)}</h2>${avaLinks()}</div></div>
        <div class="me-acts">
          <button type="button" class="me-act" id="myProfile">${icon("trophy")}<span>Мой сезон</span><small>${place ? `${place} место` : ""}</small></button>
          <button type="button" class="me-act" id="myMap">${icon("map")}<span>Мои бани на карте</span><small></small></button>
          <button type="button" class="me-act" id="myFeed">${icon("feed")}<span>Мои походы в ленте</span><small>${pend ? `на модерации: ${pend}` : ""}</small></button>
        </div>
        <button type="button" class="btn danger" id="logoutBtn">Выйти</button>`;
      $("#myProfile").onclick = () => { $("#loginModal").hidden = true; openPlayer(me.nick); };
      $("#myMap").onclick = () => { $("#loginModal").hidden = true; playerOnMap(me.nick); };
      $("#myFeed").onclick = () => { $("#loginModal").hidden = true; show("feed"); $(`#feedFilter button[data-f="${pend ? "pending" : "mine"}"]`)?.click(); };
      $("#logoutBtn").onclick = async () => { await D.logout(); location.reload(); };
      bindAvaEdit($("#loginBody"));
      $("#loginModal").hidden = false;
    };
  }
  // своя аватарка (03.11): нажал на свою аватарку — выбрал фото — оно сразу на месте, пока грузится — тонкое кольцо.
  // Браузер сам обрезает до квадрата (у вертикальных — ближе к верху, где обычно лицо) и уменьшает до 400 px
  const avaEdit = (cls) => `<label class="ava-edit" title="Сменить фото">${ava(me.nick, cls)}<span class="ava-cam">${icon("camplus")}</span>`
    + `<input type="file" accept="image/*" data-ava-file aria-label="Сменить фото"></label>`;
  const avaLinks = () => `<div class="ava-links"><button type="button" class="linkbtn" data-ava-pick>${photos[me.nick] ? "Сменить фото" : "Добавить фото"}</button>`
    + `${me.ownPhoto ? ' · <button type="button" class="linkbtn" data-ava-reset>вернуть из Telegram</button>' : ""}</div>`;
  async function squareJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("Это не картинка — выбери фото")); i.src = url; });
      const w = img.naturalWidth, h = img.naturalHeight, side = Math.min(w, h), S = Math.min(400, side);
      const c = document.createElement("canvas"); c.width = c.height = S;
      c.getContext("2d").drawImage(img, (w - side) / 2, h > w ? (h - side) * 0.25 : (h - side) / 2, side, side, 0, 0, S, S);
      const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.86));
      if (!blob) throw new Error("Фото не сжалось — попробуй другое");
      return blob;
    } finally { URL.revokeObjectURL(url); }
  }
  async function saveAvatar(root, blob) {
    const boxes = $$(".ava-edit", root);
    const prev = photos[me.nick], local = blob && URL.createObjectURL(blob);
    boxes.forEach((b) => {
      b.classList.add("busy");
      const a = $(".ava", b); $("img", a)?.remove();
      if (local) a.insertAdjacentHTML("beforeend", `<img src="${local}" alt="">`);
    });
    try {
      const url = await D.setAvatar(blob);
      if (url) photos[me.nick] = url; else delete photos[me.nick];
      me.ownPhoto = !!url;
      render(); renderMe();
      if (!$("#view-feed").hidden) renderFeed();
      $$(".ava-links", root).forEach((x) => (x.outerHTML = avaLinks()));
      bindAvaLinks(root);
      toast(url ? "Фото обновлено" : "Вернули фото из Telegram — подтянется при следующем входе");
    } catch (err) {
      if (prev) photos[me.nick] = prev;
      boxes.forEach((b) => { const a = $(".ava", b); $("img", a)?.remove(); if (prev) a.insertAdjacentHTML("beforeend", `<img src="${esc(prev)}" alt="">`); });
      toast("Фото не сохранилось: " + err.message);
    } finally {
      boxes.forEach((b) => b.classList.remove("busy"));
    }
  }
  function bindAvaLinks(root) {
    $$("[data-ava-pick]", root).forEach((b) => (b.onclick = () => $("[data-ava-file]", root)?.click()));
    $$("[data-ava-reset]", root).forEach((b) => (b.onclick = () => saveAvatar(root, null)));
  }
  function bindAvaEdit(root) {
    $$("[data-ava-file]", root).forEach((inp) => (inp.onchange = async () => {
      const f = inp.files[0]; inp.value = ""; if (!f) return;
      try { await saveAvatar(root, await squareJpeg(f)); } catch (err) { toast(err.message); }
    }));
    bindAvaLinks(root);
  }
  // таблица шире экрана (телефон): мягкая тень у правого края, пока её можно листать вбок — колонки «Бань», «У»… не прячутся молча
  $$(".tablewrap").forEach((w) => {
    const card = w.closest(".tablecard"); if (!card) return;
    const upd = () => card.classList.toggle("more-right", w.scrollWidth - w.clientWidth - w.scrollLeft > 4);
    w.addEventListener("scroll", upd, { passive: true });
    const ro = new ResizeObserver(upd); ro.observe(w); if (w.firstElementChild) ro.observe(w.firstElementChild);
  });
  renderMe();
  if (D.live) finishTelegramLogin().then((back) => {
    // вошёл, но ник не выбрал — без этого шага Комиссии нечего подтверждать; раньше его пропускали, не заметив кнопку в углу
    if (!back && me && !me.nick && !me.claimedNick) openClaim();
    if (!back) resumeCodeLogin();
  });

  // пара примерных отзывов на самую посещаемую баню, чтобы в витрине было видно, как это выглядит
  const top = [...baths].sort((a, b) => b.n26 - a.n26)[0];
  if (!D.live && top && !store.get("seeded2", false)) {
    reviews[top.id] = [
      { author: "Пример", rate: 5, text: "Пар держат до закрытия, веники свежие, в мужской день людно — лучше с утра.", sample: true },
      { author: "Пример", rate: 4, text: "Купель ледяная, парная большая. Минус — очередь в кассу по выходным.", sample: true },
    ];
    store.set("reviews", reviews); store.set("seeded2", true);
  }

  // ---------- справочник бань — только Комиссии ----------
  // Все бани лиги: тип (меняется прямо здесь), где, сколько походов и кто где был — по нику, сколько раз за все годы
  // (выделены, кто был в 2026). Просьба Витька, 02.10: «список всех бань, где смотреть, с отметками, кто где был».
  // Фильтры: поиск (название, место, ник), страна, тип, были/не были в 2026, без региона; сортировка — по заголовку.
  // Тип поменяли — таблица пересчитается (recomputeSoon), сообщения бота о походах в эту баню обновит триггер в базе.
  const DIR_PAGE = 150, DIR_WHO = 4;
  let dirLimit = DIR_PAGE, dirSort = { key: "all", dir: -1 };
  const dirOpen = new Set();   // строки, где раскрыт весь список «кто был»
  const lowerE = (s) => String(s ?? "").toLowerCase().replace(/ё/g, "е");
  function dirWho(b) {
    const all = {};
    for (const [n, k] of Object.entries(b.v26 || {})) all[n] = (all[n] || 0) + k;
    for (const y of Object.values(b.histBy || {})) for (const [n, k] of Object.entries(y)) all[n] = (all[n] || 0) + k;
    return Object.entries(all).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0], "ru"));
  }
  const DIR_COLS = [
    ["name", "Баня"], ["type", "Тип"], ["country", "Страна"], ["region", "Регион"], ["n26", "2026", "num"], ["all", "Всего", "num"], ["who", "Кто был"],
  ];
  // пустые страна/регион — в конце при любом направлении: «\uffff» сортируется после букв
  const dirKey = {
    name: (b) => lowerE(b.name), type: (b) => TYPE_LABEL[b.t],
    country: (b) => `${lowerE(b.country) || "\uffff"} ${lowerE(b.region) || "\uffff"}`, region: (b) => lowerE(b.region) || "\uffff",
    n26: (b) => b.n26, all: (b) => b.nAll, who: (b) => dirWho(b).length,
  };
  function dirCountries() {
    const n = {};
    for (const b of byId.values()) if (b.country) n[b.country] = (n[b.country] || 0) + 1;
    const cur = $("#dirCountry").value;
    $("#dirCountry").innerHTML = '<option value="">Все страны</option>' + Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"))
      .map(([c, k]) => `<option value="${esc(c)}" ${c === cur ? "selected" : ""}>${esc(c)} · ${k}</option>`).join("");
  }
  function renderDir() {
    if ($("#dirCountry").options.length <= 1) dirCountries();
    const q = lowerE($("#dirQ").value.trim()), t = $("#dirType [aria-pressed='true']")?.dataset.t ?? "";
    const season = $("#dirSeason [aria-pressed='true']")?.dataset.s ?? "", country = $("#dirCountry").value, noRegion = $("#dirNoRegion").checked;
    const k = dirKey[dirSort.key];
    const rows = [...byId.values()].filter((b) => b.status !== "rejected" && (!t || b.t === t) && (!country || b.country === country)
        && (!season || (season === "yes" ? b.n26 > 0 : !b.n26)) && (!noRegion || !b.region))
      .filter((b) => !q || lowerE(b.search).includes(q) || dirWho(b).some(([n]) => lowerE(n).includes(q)))
      .sort((a, b) => { const x = k(a), y = k(b); return (typeof x === "string" ? x.localeCompare(y, "ru") : x - y) * dirSort.dir || b.nAll - a.nAll; });
    $("#dirCount").textContent = `${rows.length} ${plural(rows.length, "баня", "бани", "бань")}`;
    const head = DIR_COLS.map(([key, label, cls]) => `<th class="${cls || ""}" aria-sort="${dirSort.key === key ? (dirSort.dir > 0 ? "ascending" : "descending") : "none"}">`
      + `<button type="button" class="dir-sort" data-sort="${key}">${label}<span class="arr">${dirSort.key === key ? (dirSort.dir > 0 ? "↑" : "↓") : ""}</span></button></th>`).join("");
    $("#dirTable").innerHTML = `<thead><tr>${head}</tr></thead><tbody>`
      + rows.slice(0, dirLimit).map((b) => {
        const who = dirWho(b), open = dirOpen.has(b.id), list = open ? who : who.slice(0, DIR_WHO);
        // одна строка на баню: длинное — троеточием (полностью — в подсказке), участники — «Ден 216 · Alex B 72 · +12»
        return `<tr data-t="${b.t}" data-id="${b.id}" class="${open ? "open" : ""}">
          <td class="dir-name" title="${esc(b.name)}"><button type="button" class="dir-bath" data-dirbath="${b.id}">${esc(b.name)}</button>${b.isNew ? ' <span class="pill ember">новая</span>' : ""}${b.closed_on ? ' <span class="pill">закрыта</span>' : ""}</td>
          <td><label class="dir-pill t-${b.t}"><i class="dir-dot"></i><select data-dirtype="${b.id}" aria-label="Тип бани «${esc(b.name)}»">${b.t === "unknown" ? '<option value="" selected>не указан</option>' : ""}${Object.entries(TYPE_CHOICE).map(([k2, l]) => `<option value="${k2}" ${b.t === k2 ? "selected" : ""}>${l}</option>`).join("")}</select></label></td>
          <td class="dir-country" title="${esc(b.country || "")}">${b.country ? esc(b.country) : '<span class="hint">—</span>'}</td>
          <td class="dir-region" title="${esc(b.region || "")}">${b.region ? esc(b.region) : '<span class="hint">—</span>'}</td>
          <td class="num" data-label="в 2026">${b.n26 || '<span class="hint">—</span>'}</td><td class="num" data-label="всего">${b.nAll || '<span class="hint">—</span>'}</td>
          <td class="dir-who" title="${esc(who.map(([n, c]) => `${n} ${c}`).join(", "))}"><div class="who-line"><span class="who-list">${list.map(([n, c]) => `<span class="who-n ${b.v26?.[n] ? "now" : ""}">${esc(n)}${c > 1 ? ` <i>${c}</i>` : ""}</span>`).join('<span class="sep">·</span>')}${!who.length ? '<span class="hint">—</span>' : ""}</span>`
          + `${who.length > DIR_WHO ? `<button type="button" class="linkbtn dir-more" data-dirwho="${b.id}">${open ? "свернуть" : `+${who.length - DIR_WHO}`}</button>` : ""}</div></td>
        </tr>`;
      }).join("") + "</tbody>";
    $("#dirMore").hidden = rows.length <= dirLimit;
  }
  if (canModerate && D.live) $('.nav [data-view="dir"]').hidden = false;
  const dirReset = () => { dirLimit = DIR_PAGE; renderDir(); };
  $("#dirQ").addEventListener("input", dirReset);
  $("#dirCountry").addEventListener("change", dirReset);
  $("#dirNoRegion").addEventListener("change", dirReset);
  $("#dirSortSel").addEventListener("change", (e) => { const [key, dir] = e.target.value.split(":"); dirSort = { key, dir: Number(dir) }; renderDir(); });
  for (const id of ["#dirType", "#dirSeason"]) $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$(`${id} button`).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    dirReset();
  });
  $("#dirMore").addEventListener("click", () => { dirLimit += DIR_PAGE; renderDir(); });
  $("#dirTable").addEventListener("click", (e) => {
    const sort = e.target.closest("[data-sort]");
    if (sort) {
      const key = sort.dataset.sort;
      // тот же столбец — обратный порядок; новый: текст — по алфавиту, числа — сначала большие
      dirSort = dirSort.key === key ? { key, dir: -dirSort.dir } : { key, dir: ["name", "type", "country", "region"].includes(key) ? 1 : -1 };
      const opt = [...$("#dirSortSel").options].find((o) => o.value === `${dirSort.key}:${dirSort.dir}`);
      if (opt) $("#dirSortSel").value = opt.value;
      return renderDir();
    }
    const more = e.target.closest("[data-dirwho]");
    if (more) { const id = Number(more.dataset.dirwho); dirOpen.has(id) ? dirOpen.delete(id) : dirOpen.add(id); return renderDir(); }
    const n = e.target.closest("[data-dirbath]");
    if (n) { show("map"); openBath(Number(n.dataset.dirbath), true); }
  });
  $("#dirTable").addEventListener("change", async (e) => {
    const sel = e.target.closest("select[data-dirtype]"); if (!sel) return;
    const b = byId.get(Number(sel.dataset.dirtype)); if (!b) return;
    try {
      await D.moderateBath(b.id, { type: sel.value || null });
      b.type = sel.value || null; b.t = b.type || "unknown"; render(); renderDir();
      toast(`«${b.name}»: ${TYPE_LABEL[b.t]} — таблица пересчитывается`); recomputeSoon();
    } catch (err) { toast("Не получилось: " + err.message); renderDir(); }
  });

  // ---------- Радар — только Комиссии (16.10) ----------
  // Бани, которые нашёл еженедельный локальный прогон агентов (OSM, 2ГИС, Яндекс, сайты бань), с индексом общественности.
  // Решает Комиссия: «Завести в лигу» (тип можно выбрать), «Перенести точку» нашей бани сюда, «Скрыть» с причиной — она же
  // метка для следующего прогона. Без её решения на карту лиги ничего не попадает. Устроено как карта с выдачей: вкладки
  // по смыслу решения, список слева и карта справа (на телефоне — сверху), наведение на место подсвечивает точку.
  let radar = null, radarTab = null, radarQ = "", radarRegion = "", radarFitKey = "";
  const radarOpen = new Set();                 // раскрытые «Подробнее»
  let radarAsk = null;                          // { id, act: "add" | "match" | "hide" } — строка подтверждения на месте кнопок
  const AQUA_RX = /(аквапарк|аква|термол|термы|терм[ао]|фитнес|бассейн)/i;
  function radarBase(p) {                       // группа по смыслу, без учёта решения
    const x = p.public_index ?? 0;
    if (p.kind === "closed" || p.kind === "other") return "rest";
    // «Наши» — только к бане лиги с примерной точкой: у точной «перенести точку» не нужно (та же — radarKnown, другая — новая)
    const hb = p.league_hint && byId.get(p.league_hint);
    if (hb && hb.precision !== "exact" && (p.kind === "public" || x >= 60)) return "ours";
    if (p.kind === "public" && x >= 70) return "new";
    if ((p.kind === "public" && x >= 40) || (p.ticket_per_person && p.kind !== "private" && !AQUA_RX.test(p.name + " " + (p.note || "")))) return "review";
    if (p.kind === "unknown" && x >= 40) return "search";
    return "rest";
  }
  // место ближе 150 м к точной точке бани лиги — это она и есть (23.10, Леха): в Радаре не показываем, решать нечего.
  // Считаем на сайте, а не в прогоне: Комиссия ставит точки каждый день, и вчерашнее «Новое» сегодня уже в лиге
  const RADAR_NEAR_KM = 0.15;
  let radarNearMemo = null;
  function radarNear(p) {
    if (p.lat == null) return null;
    if (!radarNearMemo || radarNearMemo.n !== baths.length) radarNearMemo = { n: baths.length, at: new Map() };
    if (!radarNearMemo.at.has(p.id)) radarNearMemo.at.set(p.id, baths.find((b) => b.precision === "exact" && b.lat != null && b.status !== "rejected"
      && Math.abs(b.lat - p.lat) < 0.01 && distKm([b.lat, b.lng], [p.lat, p.lng]) < RADAR_NEAR_KM) || null);
    return radarNearMemo.at.get(p.id);
  }
  // подсказка «похоже на нашу», а у нашей бани уже точная точка: место без точки или ближе 1 км — это она, решать нечего
  // (24.10, Леха: «Сандуновские» с «Сандуны вр»). Дальше 1 км — другая баня: идёт как новая
  function radarKnown(p) {
    const hb = p.league_hint && byId.get(p.league_hint);
    if (!hb || hb.precision !== "exact" || hb.lat == null) return false;
    return p.lat == null || distKm([hb.lat, hb.lng], [p.lat, p.lng]) < 1;
  }
  const radarGroup = (p) => (p.status !== "new" ? "done" : radarNear(p) || radarKnown(p) ? "known" : radarBase(p));
  const RADAR_TABS = [
    ["new", "Новые", "Похоже на общественные бани, которых нет в лиге. Проверь по ссылкам и заводи."],
    ["ours", "Наши", "Название совпало с нашей баней, а у нашей точка примерная. Если это она — перенеси точку сюда."],
    ["review", "Спорные", "Вход по билету есть, но на грани хуитнеса или данных мало — реши, заводить ли и как."],
    ["search", "Без данных", "Похоже на баню, но подробностей агенты не нашли. Следующий прогон поищет ещё — или проверь сам по ссылкам."],
    ["rest", "Прочее", "Аренда, сауны, спа и закрытые. Обычно делать ничего не нужно."],
    ["done", "Решено", "Что уже решили. Скрыли зря — «Вернуть»; заведённую баню правят в её карточке на карте."],
  ];
  const RADAR_TYPES = [["public", "Общественная"], ["spa", "Хуитнес"], ["private", "Частная"]];
  const HIDE_REASONS = [["not_bath", "не баня"], ["rental", "аренда, сауна"], ["spa", "хуитнес"], ["closed", "закрыта"], ["duplicate", "дубль"], ["other", "другое"]];
  const PREC_RU = { exact: "точная", auto: "среднеточная (нашёл геокодер)", city: "по городу", region: "по региону", country: "по стране", approx: "примерная" };
  function radarVerdict(p) {
    const x = p.public_index ?? 0;
    if (p.kind === "public") return x >= 90 ? ["точно общественная", "ok"] : x >= 70 ? ["скорее общественная", "ok"] : ["под вопросом", "warn"];
    return { spa: ["хуитнес", "muted"], private: ["аренда", "muted"], closed: ["закрыта", "muted"], other: ["не баня", "muted"] }[p.kind] || ["нет данных", "muted"];
  }
  function radarFacts(p) {
    const f = [];
    if (p.gender_split) f.push("мужские и женские дни");
    if (p.ticket_per_person) f.push("билет на человека");
    const price = (p.price_example || "").match(/\d[\d\s]{1,6}(?:\s*[–—-]\s*\d[\d\s]{1,6})?\s*₽/);
    if (price) f.push(price[0].replace(/\s+/g, " ").trim());
    return f;
  }
  const radarWhere = (p) => [p.city, p.address].filter(Boolean).filter((x, i, a) => !(i && a[0] && x.includes(a[0]))).join(", ") || p.region || "";
  function radarLinks(p) {
    const q = encodeURIComponent([p.name, radarWhere(p)].filter(Boolean).join(", "));
    const ll = p.lat != null ? `${p.lng.toFixed(5)},${p.lat.toFixed(5)}` : "";
    const ya = /yandex|yango/.test(p.map_url || "") ? p.map_url : `https://yandex.ru/maps/?text=${q}${ll ? `&ll=${ll}&z=15` : ""}`;
    const dg = /2gis/.test(p.map_url || "") ? p.map_url : `https://2gis.ru/search/${q}${ll ? `?m=${ll}/15` : ""}`;
    const site = p.website && !/yandex|2gis|zoon|yell/.test(p.website)
      ? `<a href="${esc(p.website)}" target="_blank" rel="noopener">Сайт: ${esc(p.website.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}</a>` : "";
    return `${site}<a href="${esc(ya)}" target="_blank" rel="noopener">Яндекс Карты</a><a href="${esc(dg)}" target="_blank" rel="noopener">2ГИС</a>`;
  }
  function radarOurs(p) {
    const b = p.league_hint && byId.get(p.league_hint);
    if (!b) return "";
    const far = b.ll && p.lat != null ? distKm(b.ll, [p.lat, p.lng]) : null;
    const pt = !b.ll ? "у неё нет точки на карте" : `наша точка ${PREC_RU[b.prec] || "примерная"}${far != null ? `, ${fmtKm(far)} отсюда` : ""}`;
    return `<div class="radar-ours">Похоже на нашу <button type="button" class="linkbtn" data-radar="ourbath" data-id="${p.id}">«${esc(b.name)}»</button> — ${pt}.</div>`;
  }
  function radarActs(p, g) {
    const hint = p.league_hint && byId.get(p.league_hint);
    if (p.status !== "new") {
      const b = p.bath_id && byId.get(p.bath_id);
      const what = p.status === "added" ? `Заведена в лигу${b ? ` как «${esc(b.name)}» · ${esc(TYPE_LABEL[b.t] || "")}` : ""}`
        : p.status === "matched" ? `Точка «${esc(b?.name || hint?.name || "")}» перенесена сюда`
        : `Скрыта${p.hide_reason ? ": " + (HIDE_REASONS.find(([k]) => k === p.hide_reason)?.[1] || "") : ""}`;
      // «Вернуть» — только скрытым: заведённая баня осталась бы в лиге, и второе «Завести» дало бы дубль; её правят в карточке
      return `<span class="radar-doneline">${what}</span>${b ? `<button type="button" class="linkbtn" data-radar="ourbath" data-id="${p.id}">на карте лиги</button>` : ""}${p.status === "hidden" ? `<button type="button" class="linkbtn" data-radar="reopen" data-id="${p.id}">Вернуть</button>` : ""}`;
    }
    if (radarAsk?.id === p.id && radarAsk.act === "add") {
      const def = p.kind === "spa" ? "spa" : p.kind === "private" ? "private" : "public";
      return `<div class="radar-ask"><span>Завести как</span>
        <div class="seg seg-sm" role="group" aria-label="Тип бани">${RADAR_TYPES.map(([t, l]) => `<button type="button" data-type="${t}" aria-pressed="${t === def}">${l}</button>`).join("")}</div>
        <button type="button" class="btn solid sm" data-radar="add-go" data-id="${p.id}">Завести</button><button type="button" class="linkbtn" data-radar="cancel">Отмена</button></div>`;
    }
    // «Это наша»: Комиссия сама выбирает баню лиги, когда название не совпало («Лотос» — это «Тула, Баня 4», 24.10)
    if (radarAsk?.id === p.id && radarAsk.act === "pick") {
      return `<div class="radar-ask radar-pick"><span>Какая это баня лиги?</span>
        <input class="inp sm" data-radarpick="${p.id}" placeholder="Название бани лиги" aria-label="Баня лиги" value="${esc(radarAsk.q || "")}">
        <div class="radar-sug" data-radarsug="${p.id}">${radarPickList(p, radarAsk.q || "")}</div>
        <button type="button" class="linkbtn" data-radar="cancel">Отмена</button></div>`;
    }
    if (radarAsk?.id === p.id && radarAsk.act === "match") {
      const tb = byId.get(radarAsk.bath || p.league_hint) || hint;
      return `<div class="radar-ask"><span>Перенести точку «${esc(tb.name)}» сюда${p.address ? ` — ${esc(p.address)}` : ""}?</span>
        <button type="button" class="btn solid sm" data-radar="match-go" data-id="${p.id}">Перенести</button><button type="button" class="linkbtn" data-radar="cancel">Отмена</button></div>`;
    }
    if (radarAsk?.id === p.id && radarAsk.act === "hide") {
      return `<div class="radar-ask"><span>Скрыть — почему?</span>${HIDE_REASONS.map(([k, l]) => `<button type="button" class="chip" data-radar="hide-go" data-reason="${k}" data-id="${p.id}">${l}</button>`).join("")}<button type="button" class="linkbtn" data-radar="cancel">Отмена</button></div>`;
    }
    const add = (main) => `<button type="button" class="btn sm ${main ? "solid" : ""}" data-radar="add" data-id="${p.id}">${main ? "Завести в лигу" : "Завести"}</button>`;
    const parts = g === "ours" && hint
      ? [`<button type="button" class="btn solid sm" data-radar="match" data-id="${p.id}">Перенести точку «${esc(hint.name)}» сюда</button>`, `<button type="button" class="btn sm" data-radar="add" data-id="${p.id}">Это другая — завести</button>`]
      : [add(g === "new")];
    return parts.join("") + `<button type="button" class="linkbtn" data-radar="pick" data-id="${p.id}">Это наша баня</button><button type="button" class="linkbtn" data-radar="hide" data-id="${p.id}">Скрыть</button>`;
  }
  // бани лиги для «Это наша»: по названию, а без запроса — ближайшие к месту (у Радара точка почти всегда есть)
  function radarPickList(p, q) {
    q = lowerE(q.trim());
    const d = (b) => (b.ll && p.lat != null ? distKm(b.ll, [p.lat, p.lng]) : 1e9);
    const list = baths.filter((b) => !b.isNew && (q ? b.search.includes(q) : d(b) < 30)).sort((a, b) => d(a) - d(b) || b.nAll - a.nAll).slice(0, 6);
    return list.length ? list.map((b) => `<button type="button" data-radar="pick-bath" data-id="${p.id}" data-bath="${b.id}"><span>${esc(b.name)}</span><small>${d(b) < 1e9 ? fmtKm(d(b)) : esc(b.region || "")}</small></button>`).join("")
      : `<span class="hint">${q ? "Не нашлось — попробуй другое слово" : "Рядом бань лиги нет — начни вводить название"}</span>`;
  }
  function radarCard(p) {
    const g = radarGroup(p), [verdict, tone] = radarVerdict(p), facts = radarFacts(p), open = radarOpen.has(p.id);
    const name = p.lat != null ? `<button type="button" class="radar-name" data-radar="fly" data-id="${p.id}" title="Показать на карте">${esc(p.name)}</button>` : `<b class="radar-name">${esc(p.name)}</b>`;
    const quotes = (p.evidence || []).filter((e) => e.quote).map((e) => `<blockquote>«${esc(e.quote.replace(/^\[пересказ\]\s*/, ""))}» <a href="${esc(e.url)}" target="_blank" rel="noopener">источник</a></blockquote>`).join("");
    const more = open ? `<div class="radar-more">${p.price_example ? `<p><b>Цены:</b> ${esc(p.price_example)}</p>` : ""}${quotes}
      <p class="hint">Нашли ${p.first_seen ? new Date(p.first_seen).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : ""} · ${esc(String(p.key || "").startsWith("osm:") ? "OpenStreetMap" : String(p.key || "").startsWith("2gis:") ? "2ГИС" : String(p.key || "").startsWith("yandex:") ? "Яндекс Карты" : "справочник")}${p.confidence ? ` · уверенность: ${{ high: "высокая", medium: "средняя", low: "низкая" }[p.confidence]}` : ""}</p></div>` : "";
    return `<li class="radar-card${g === "done" ? " is-done" : ""}${p.id === radarPin ? " focus" : ""}" data-id="${p.id}">
      <div class="radar-head">${name}<span class="radar-city">${esc(p.city || (p.region === "Москва" ? "Москва" : ""))}</span></div>
      <div class="radar-verdict"><span class="vd vd-${tone}">${verdict}${p.public_index != null ? ` · ${p.public_index}` : ""}</span>${facts.map((f) => `\u00a0· <span class="fact">${esc(f)}</span>`).join("")}</div>
      ${p.note ? `<p class="radar-note">${esc(p.note)}</p>` : ""}
      ${g === "ours" || (g === "done" && p.status === "matched") ? radarOurs(p) : ""}
      <div class="radar-links">${radarLinks(p)}${(p.price_example || quotes) ? `<button type="button" class="linkbtn" data-radar="more" data-id="${p.id}">${open ? "Свернуть" : "Подробнее"}</button>` : ""}</div>
      ${more}
      <div class="radar-acts">${radarActs(p, g)}</div></li>`;
  }
  // карта: точки текущей вкладки; наведение на карточку — точка крупнее, клик по точке — к карточке
  let radarMap = null, radarLayer = null;
  const radarMarks = new Map();
  function radarMapRender(rows) {
    if ($("#radarSide").classList.contains("folded")) return;
    if (!radarMap) {
      radarMap = L.map("radarmap", { zoomSnap: 0.5 }).setView([55.75, 37.6], 8);
      radarMap.attributionControl.setPrefix(false);
      L.tileLayer(TILE_URL, tileOpts).addTo(radarMap); syncTheme();
      radarLayer = L.layerGroup().addTo(radarMap);
    }
    setTimeout(() => radarMap.invalidateSize(), 0);
    radarLayer.clearLayers(); radarMarks.clear(); radarGhost = null; radarHot = null;
    const pts = [];
    for (const p of rows) {
      if (p.lat == null) continue;
      pts.push([p.lat, p.lng]);
      const m = L.circleMarker([p.lat, p.lng], { radius: 7, weight: 2, className: `rd rd-${radarBase(p)}${p.status !== "new" ? " rd-done" : ""}` })
        .bindTooltip(`<b>${esc(p.name)}</b>${p.city ? `<br>${esc(p.city)}` : ""}`, { direction: "top", offset: [0, -6] })
        .on("click", () => radarFocus(p.id, true))
        .addTo(radarLayer);
      radarMarks.set(p.id, m);
    }
    const key = radarTab + "|" + radarQ + "|" + radarRegion;
    if (key !== radarFitKey && pts.length) { radarMap.fitBounds(pts, { padding: [28, 28], maxZoom: 13, animate: false }); radarFitKey = key; }
  }
  // «Наши»: наша точка сейчас и пунктир до найденного места — видно, насколько она мимо. При наведении — пока мышь
  // на карточке; по клику на название — остаётся (radarPin), пока не выберут другое место или вкладку
  let radarGhost = null, radarHot = null, radarPin = null;
  function radarPair(p) {
    if (radarGhost) { radarLayer.removeLayer(radarGhost); radarGhost = null; }
    const b = p && radarBase(p) === "ours" && byId.get(p.league_hint);
    if (!b?.ll || p.lat == null || !radarMap) return null;
    radarGhost = L.layerGroup([
      L.polyline([[p.lat, p.lng], b.ll], { className: "rd-link", weight: 2, dashArray: "4 6", interactive: false }),
      L.circleMarker(b.ll, { radius: 6, weight: 2, className: "rd rd-league" }).bindTooltip(`Наша точка «${esc(b.name)}» сейчас`, { direction: "top", offset: [0, -6] }),
    ]);
    radarLayer.addLayer(radarGhost);
    return b.ll;
  }
  function radarHover(id, on) {
    if (on ? radarHot === id : radarHot !== id) return;   // mouseover летит с каждого вложенного элемента
    radarHot = on ? id : null;
    const m = radarMarks.get(id);
    if (m) { m.setRadius(on ? 12 : 7); if (on) m.bringToFront(); }
    radarPair(radar.find((x) => x.id === (on ? id : radarPin)));
  }
  function radarFocus(id, scroll) {
    $$("#radarList .radar-card.focus").forEach((x) => x.classList.remove("focus"));
    const card = $(`#radarList .radar-card[data-id="${id}"]`); if (!card) return;
    card.classList.add("focus");
    if (scroll) card.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
  }
  function renderRadar() {
    if (!radar) {
      D.radar().then((rows) => { radar = rows; renderRadar(); })
        .catch((err) => { $("#radarList").innerHTML = `<li class="hint">Радар не загрузился: ${esc(err.message)}</li>`; });
      return;
    }
    const q = lowerE(radarQ.trim());
    const pass = (p) => (!radarRegion || p.region === radarRegion) && (!q || lowerE(`${p.name} ${p.city || ""} ${p.address || ""}`).includes(q));
    const by = {};
    for (const p of radar) if (pass(p)) (by[radarGroup(p)] ||= []).push(p);
    if (!radarTab || !RADAR_TABS.some(([t]) => t === radarTab)) radarTab = ["new", "ours", "review", "search"].find((t) => by[t]?.length) || "new";
    $("#radarTabs").innerHTML = RADAR_TABS.map(([t, l]) => `<button type="button" role="tab" data-tab="${t}" aria-pressed="${t === radarTab}">${l}<span class="n">${by[t]?.length || 0}</span></button>`).join("");
    // прогресс — по тем, где нужно решение: новые, наши, спорные
    const act = radar.filter((p) => ["new", "ours", "review"].includes(radarBase(p)) && (p.status !== "new" || !radarNear(p) && !radarKnown(p)));
    const known = (by.known || []).length;
    const doneN = act.filter((p) => p.status !== "new").length, week = radar.filter((p) => p.status === "new" && Date.now() - Date.parse(p.first_seen) < 7 * 864e5).length;
    $("#radarProgress").hidden = !act.length;
    $("#radarProgress").innerHTML = `<div class="bar"><i style="width:${act.length ? Math.round(doneN / act.length * 100) : 0}%"></i></div>
      <span>Разобрано <b>${doneN}</b> из ${act.length}${week && week < radar.length ? ` · новых за неделю: ${week}` : ""}${known ? ` · не показываем ${known} ${plural(known, "место", "места", "мест")}: это бани лиги с точной точкой` : ""}</span>`;
    $("#radarN").textContent = act.length - doneN ? ` · ${act.length - doneN}` : "";
    $("#radarTabNote").textContent = RADAR_TABS.find(([t]) => t === radarTab)[2];
    const rows = (by[radarTab] || []).sort((a, b) => (b.public_index ?? -1) - (a.public_index ?? -1));
    $("#radarList").innerHTML = rows.length ? rows.map(radarCard).join("")
      : `<li class="radar-empty">${radarTab === "done" ? "Пока ничего не решено." : q || radarRegion ? "Ничего не нашлось — попробуй убрать фильтр." : "Здесь всё разобрано. Новые места появятся после следующего прогона."}</li>`;
    radarMapRender(rows);
  }
  function setDirMode(mode) {
    radarMode = mode;
    $$("#dirMode button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
    $("#dirBox").hidden = mode !== "dir";
    $("#radarBox").hidden = mode !== "radar";
    $("#catBox").hidden = mode !== "catalog";
    $("#dirTitle").textContent = { radar: "Радар", catalog: "Сверка каталога" }[mode] || "Справочник бань";
    if (mode === "radar") renderRadar();
    if (mode === "catalog") renderCat();
    history.replaceState(history.state, "", "#" + mode);
  }
  $("#dirMode").addEventListener("click", (e) => { const b = e.target.closest("button[data-mode]"); if (b) setDirMode(b.dataset.mode); });
  $("#radarTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]"); if (!b) return;
    radarTab = b.dataset.tab; radarAsk = null; radarPin = null; store.set("radarTab", radarTab); renderRadar();
  });
  radarTab = store.get("radarTab", null);
  let radarQT = null;
  $("#radarQ").addEventListener("input", (e) => { clearTimeout(radarQT); radarQT = setTimeout(() => { radarQ = e.target.value; renderRadar(); }, 150); });
  $("#radarRegion").addEventListener("change", (e) => { radarRegion = e.target.value; renderRadar(); });
  $("#radarMapToggle").addEventListener("click", () => {
    const f = $("#radarSide").classList.toggle("folded");
    $("#radarMapToggle").textContent = f ? "Показать карту" : "Свернуть карту";
    store.set("radarMapFolded", f);
    if (!f) renderRadar();
  });
  if (store.get("radarMapFolded", false) && innerWidth <= 1000) { $("#radarSide").classList.add("folded"); $("#radarMapToggle").textContent = "Показать карту"; }
  $("#radarList").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-radarpick]"); if (!inp || !radarAsk) return;
    radarAsk.q = inp.value;
    const p = radar.find((x) => x.id === Number(inp.dataset.radarpick));
    $(`[data-radarsug="${p.id}"]`).innerHTML = radarPickList(p, inp.value);   // только подсказки: поле не теряет фокус
  });
  $("#radarList").addEventListener("mouseover", (e) => { const c = e.target.closest(".radar-card"); if (c) radarHover(Number(c.dataset.id), true); });
  $("#radarList").addEventListener("mouseout", (e) => { const c = e.target.closest(".radar-card"); if (c && !c.contains(e.relatedTarget)) radarHover(Number(c.dataset.id), false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && radarAsk) { radarAsk = null; renderRadar(); } });
  // подсказка с отменой — внизу, как обычный toast, но с кнопкой и подольше
  function radarToast(msg, label, fn) {
    toast(`${esc(msg)} <button type="button" class="toast-act">${esc(label)}</button>`, true);
    const t = $(".toast"), b = t?.querySelector(".toast-act");
    if (b) b.onclick = () => { t.remove(); fn(); };
  }
  async function radarDo(p, act, opts = {}) {
    const res = await D.radarDecide(p.id, act, opts);
    Object.assign(p, { status: { add: "added", match: "matched", hide: "hidden", reopen: "new" }[act], hide_reason: act === "hide" ? opts.reason : null,
      bath_id: act === "add" ? res : act === "match" ? opts.bath : null });
    return res;
  }
  $("#radarList").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-radar]");
    const typeBtn = e.target.closest(".radar-ask [data-type]");
    if (typeBtn) { $$("[data-type]", typeBtn.parentElement).forEach((x) => x.setAttribute("aria-pressed", String(x === typeBtn))); return; }
    if (!b) return;
    const act = b.dataset.radar, p = radar.find((x) => x.id === Number(b.dataset.id));
    if (act === "cancel") { radarAsk = null; return renderRadar(); }
    if (!p) return;
    if (act === "fly") {
      radarFocus(p.id); radarPin = p.id;
      const ours = radarPair(p);
      if (ours) radarMap?.fitBounds([[p.lat, p.lng], ours], { padding: [48, 48], maxZoom: 15, animate: !calm });
      else radarMap?.setView([p.lat, p.lng], 15, { animate: !calm });
      if (innerWidth <= 1000) $("#radarmap").scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
      return;
    }
    if (act === "more") { radarOpen.has(p.id) ? radarOpen.delete(p.id) : radarOpen.add(p.id); return renderRadar(); }
    if (act === "ourbath") { const id = p.bath_id || p.league_hint; if (byId.has(id)) { show("map"); openBath(id, true); } return; }
    if (act === "add" || act === "match" || act === "hide" || act === "pick") {
      radarAsk = { id: p.id, act }; renderRadar();
      if (act === "pick") $(`[data-radarpick="${p.id}"]`)?.focus();
      return;
    }
    if (act === "pick-bath") { radarAsk = { id: p.id, act: "match", bath: Number(b.dataset.bath) }; renderRadar(); return; }
    $$("button", b.closest(".radar-acts")).forEach((x) => (x.disabled = true));
    try {
      if (act === "add-go") {
        const type = $(".radar-ask [data-type][aria-pressed='true']", b.closest(".radar-acts"))?.dataset.type || "public";
        const id = await radarDo(p, "add", { type });
        radarAsk = null; renderRadar();
        refreshData().then(() => { renderRadar(); radarToast(`«${p.name}» в лиге`, "Показать на карте", () => { show("map"); openBath(id, true); }); }).catch(() => {});
      } else if (act === "match-go") {
        const bath = radarAsk?.bath || p.league_hint;
        if (p.lat != null) await D.setBathLocation(bath, `${p.lat}, ${p.lng}`);
        await radarDo(p, "match", { bath });
        radarAsk = null; renderRadar();
        toast(p.lat != null ? "Точка перенесена" : "Привязано — точку поправь в карточке бани");
        refreshData().then(renderRadar).catch(() => {});
      } else if (act === "hide-go") {
        await radarDo(p, "hide", { reason: b.dataset.reason });
        radarAsk = null; renderRadar();
        radarToast(`Скрыто: ${p.name}`, "Отменить", () => radarDo(p, "reopen").then(renderRadar).catch((err) => toast("Не получилось: " + err.message)));
      } else if (act === "reopen") {
        await radarDo(p, "reopen"); renderRadar(); toast("Вернули в радар");
      }
    } catch (err) {
      $$("button", b.closest(".radar-acts")).forEach((x) => (x.disabled = false));
      toast("Не получилось: " + err.message);
    }
  });

  // ---------- Сверка каталога — только Комиссии (19.10) ----------
  // Агенты прошли бани лиги по 2ГИС, Яндекс Картам, OpenStreetMap и сайтам бань (docs/catalog.md). В карточке — как баня
  // записана у нас (тип, регион, походы, кто был) и что нашли (название, адрес, точка, ссылки, факты) с индексом уверенности.
  // «Принять» — найденная точка становится точной (нашу точную рядом не двигаем), «Оставить нашу», «Отклонить» с причиной.
  // Уверенные — пачкой. Регион Комиссии не меняем: расхождение показываем отдельной вкладкой.
  let cat = null, catTab = null, catQ = "", catRegion = "", catFitKey = "", catAsk = null, catPin = null;
  const catOpen = new Set();
  // похоже на общественную, а у нас — хуитнес, частная или без типа (обратный ход 20.10)
  // смена типа по факту: похоже на общественную, а у нас — хуитнес, частная или без типа; у бань без типа — и хуитнес или частная
  const catRetype = (p) => {
    const t = byId.get(p.bath_id)?.t || "unknown";
    return p.kind_found === "public" ? t !== "public" : (p.kind_found === "spa" || p.kind_found === "private") && t === "unknown";
  };
  const RETYPE = { public: "Сделать общественной", spa: "Сделать хуитнесом", private: "Сделать частной" };
  function catBase(p) {
    if (catRetype(p)) return "type";
    if (p.region_conflict) return "region";
    if (p.is_public === false || p.place_status === "closed" || p.place_status === "repair") return "flag";
    if (p.match >= 90 && p.lat != null && p.bin !== "move") return "sure";
    return p.match >= 70 ? "check" : "doubt";
  }
  const catGroup = (p) => (p.status !== "new" ? "done" : catBase(p));
  const CAT_TABS = [
    ["type", "Тип", "Агенты определили тип по факту: похоже на общественную, а у нас — хуитнес, частная или без типа; у бань без типа — ещё хуитнес или частная. Проверь по ссылкам: «Сделать …» поменяет тип (очки за походы сюда пересчитаются) и примет точку и данные."],
    ["sure", "Уверенные", "Название, город и регион сошлись, адрес подтвердили два источника. Можно принять пачкой: найденная точка станет точной, а нашу точную, если она рядом, не тронем."],
    ["check", "Проверить", "Нашли, но источник один, данных мало или наша точка далеко. Глянь по ссылкам и реши по одной."],
    ["region", "Регион", "Регион по карточке не тот, что у нас. Точку можно принять — регион от этого не меняется, его правят в справочнике."],
    ["flag", "Флажки", "Похоже, баня закрылась, на ремонте или это не общественная баня (аренда, спа при отеле). Реши, что с ней делать."],
    ["doubt", "Не нашли", "Агенты не нашли или сомневаются. Спроси у тех, кто был, — они в строке «У нас»."],
    ["done", "Решено", "Что уже решили. Передумал — «Вернуть»: принятая точка вернётся прежней, если баню с тех пор не двигали."],
  ];
  const CAT_REJECT = [["other_bath", "другая баня"], ["wrong_point", "точка не та"], ["not_public", "не общественная"], ["closed", "закрыта"], ["duplicate", "дубль"], ["other", "другое"]];
  const CAT_REASON = Object.fromEntries([...CAT_REJECT, ["own_point", "поставили свою точку"]]);
  const CAT_SRC = { "2gis": "2ГИС", yandex: "Яндекс Карты", osm: "OpenStreetMap", site: "сайт бани" };
  const catRaw = (b) => (b?.lat != null ? [b.lat, b.lng] : null);
  const catFar = (p, b) => (catRaw(b) && p.lat != null ? distKm(catRaw(b), [p.lat, p.lng]) : null);
  // принять — значит двинуть точку? (так же решает catalog_decide: наша точная ближе 300 м остаётся)
  const catMoves = (p, b) => p.lat != null && (!catRaw(b) || b.precision !== "exact" || catFar(p, b) > 0.3);
  function catOurs(p, b) {
    if (!b) return `<div class="cat-ours"><span class="cat-lbl">У нас</span> баню удалили из лиги</div>`;
    const who = dirWho(b), more = who.length > 6 ? ` и ещё ${who.length - 6}` : "";
    const visits = b.nAll ? `${b.nAll} ${plural(b.nAll, "поход", "похода", "походов")}${b.n26 ? `, в 2026 — ${b.n26}` : ""}` : "походов нет";
    const pt = (!catRaw(b) ? "точки нет" : `точка ${PREC_RU[b.precision || "exact"] || "примерная"}`) + (b.closed_on ? ` · закрыта с ${closedWhen(b)}` : "");
    return `<div class="cat-ours"><span class="cat-lbl">У нас</span><div><b>${esc(b.name)}</b> · ${esc(TYPE_LABEL[b.t] || "")} · ${esc(where(b))} · ${pt} · ${visits}
      ${who.length ? `<div class="cat-who">Были: ${who.slice(0, 6).map(([n, k]) => `${esc(n)}${k > 1 ? ` ${k}` : ""}`).join(", ")}${more}</div>` : ""}</div></div>`;
  }
  function catProp(p, b) {
    const far = catFar(p, b);
    const pt = p.lat == null ? "координат в источниках нет — наша точка останется"
      : !catRaw(b) ? `точка — ${CAT_SRC[p.point_src] || "из источника"}, у нас точки не было`
      : `точка — ${CAT_SRC[p.point_src] || "из источника"}, ${far < 0.05 ? "там же, где наша" : `${fmtKm(far)} от нашей`}`;
    const reg = p.region_conflict ? `<div class="cat-warn">Регион по карточке: ${esc(p.region_found || "другой")}, у нас — ${esc(b?.region || "не указан")}</div>` : "";
    const KIND = { public: "общественная", spa: "хуитнес", private: "частная, аренда" };
    const kind = !p.kind_found || p.kind_found === "unknown" || !b || p.kind_found === b.t ? ""
      : `<div class="${catRetype(p) ? "cat-type" : "cat-pt"}">По факту — ${KIND[p.kind_found]}${p.kind_why ? `: ${esc(p.kind_why)}` : ""}</div>`;
    const facts = [p.hours, p.gender_days, p.price && `${p.price}${p.price_date ? ` (${p.price_date})` : ""}`].filter(Boolean);
    const flag = p.place_status === "closed" ? "похоже, закрыта" : p.place_status === "repair" ? "на ремонте" : p.is_public === false ? "не общественная" : "";
    return `<div class="cat-prop"><span class="cat-lbl">Нашли</span><div>
      <b>${esc(p.found_name || "—")}</b>${p.address ? ` · ${esc(p.address)}` : ""}
      <div class="cat-pt">${pt}</div>${reg}${kind}
      ${flag ? `<div class="cat-warn">${flag}${p.public_why ? `: ${esc(p.public_why)}` : ""}</div>` : ""}
      ${facts.length ? `<div class="cat-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join("")}</div>` : ""}
      ${p.note ? `<p class="radar-note">${esc(p.note)}</p>` : ""}</div></div>`;
  }
  function catLinks(p) {
    const q = encodeURIComponent([p.found_name, p.address || p.city].filter(Boolean).join(", "));
    const ll = p.lat != null ? `${p.lng.toFixed(5)},${p.lat.toFixed(5)}` : "";
    const ya = p.yandex_url || (q && `https://yandex.ru/maps/?text=${q}${ll ? `&ll=${ll}&z=16` : ""}`);
    const dg = p.twogis_url || (q && `https://2gis.ru/search/${q}${ll ? `?m=${ll}/16` : ""}`);
    const a = (u, t) => (u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>` : "");
    return a(p.website, `Сайт: ${esc((p.website || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0])}`) + a(ya, "Яндекс Карты") + a(dg, "2ГИС");
  }
  function catMore(p) {
    const row = (k, v) => (v ? `<p><b>${k}:</b> ${esc(v)}</p>` : "");
    const quotes = (p.evidence || []).filter((e) => e.quote).map((e) => `<blockquote>«${esc(e.quote)}» <a href="${esc(e.url)}" target="_blank" rel="noopener">источник</a></blockquote>`).join("");
    return `<div class="radar-more">${row("Почему так уверены", p.match_why)}${row("Телефон", p.phone)}${row("Отделения", (p.sections || []).join(", "))}
      ${row("Что есть", (p.amenities || []).join(", "))}${row("Общественная", p.public_why)}
      ${p.price_src ? `<p><b>Цена:</b> <a href="${esc(p.price_src)}" target="_blank" rel="noopener">откуда</a></p>` : ""}${quotes}
      <p class="hint">Прогон ${esc(p.run)}</p></div>`;
  }
  function catActs(p, b) {
    if (p.status !== "new") {
      const what = p.status === "accepted" ? (p.prev_type ? `Тип — ${(TYPE_LABEL[byId.get(p.bath_id)?.t] || "").toLowerCase()}` + (p.prev_precision ? ", точка перенесена" : "") : p.prev_precision ? "Точка перенесена сюда" : "Принято") : p.status === "kept" ? "Оставили нашу точку"
        : p.reject_reason === "own_point" ? "Поставили свою точку" : `Отклонено${p.reject_reason ? ": " + (CAT_REASON[p.reject_reason] || "") : ""}`;
      return `<span class="radar-doneline">${what}</span>${b ? `<button type="button" class="linkbtn" data-cat="ourbath" data-id="${p.id}">на карте лиги</button>` : ""}<button type="button" class="linkbtn" data-cat="reopen" data-id="${p.id}">Вернуть</button>`;
    }
    // своя точка (20.10): Комиссия знает, где баня, — ссылка на карты, адрес или координаты, как «перенести точку» в карточке
    if (catAsk?.id === p.id && catAsk.own) {
      return `<form class="radar-ask cat-own" data-own="${p.id}"><span>Где баня? Ссылка на Яндекс Карты, 2ГИС или Google, адрес с домом или координаты</span>
        <input class="inp" name="own" required autocomplete="off" placeholder="https://yandex.ru/maps/org/… или 55.7558, 37.6173" aria-label="Где баня">
        <button type="submit" class="btn solid sm">Поставить</button><button type="button" class="linkbtn" data-cat="cancel">Отмена</button></form>`;
    }
    if (catAsk?.id === p.id) {
      return `<div class="radar-ask"><span>Отклонить — почему?</span>${CAT_REJECT.map(([k, l]) => `<button type="button" class="chip" data-cat="reject-go" data-reason="${k}" data-id="${p.id}">${l}</button>`).join("")}<button type="button" class="linkbtn" data-cat="cancel">Отмена</button></div>`;
    }
    const moves = catMoves(p, b);
    if (catRetype(p)) {   // главное здесь — тип; точку и данные «Сделать …» тоже принимает
      return `<button type="button" class="btn sm solid" data-cat="retype" data-id="${p.id}">${RETYPE[p.kind_found]}</button>`
        + `<button type="button" class="btn sm" data-cat="accept" data-id="${p.id}">Тип не менять, ${p.lat == null ? "данные" : "точку"} принять</button>`
        + `<button type="button" class="linkbtn" data-cat="own" data-id="${p.id}">своя точка</button>`
        + `<button type="button" class="linkbtn" data-cat="reject" data-id="${p.id}">Отклонить</button>`;
    }
    const main = p.lat == null ? "Подтвердить данные" : !moves ? "Подтвердить" : catRaw(b) ? "Перенести точку сюда" : "Поставить точку";
    const solid = p.match >= 70 && !p.region_conflict;
    return `<button type="button" class="btn sm${solid ? " solid" : ""}" data-cat="accept" data-id="${p.id}">${main}</button>`
      + (moves ? `<button type="button" class="btn sm" data-cat="keep" data-id="${p.id}">Оставить нашу точку</button>` : "")
      + (p.place_status === "closed" && b && !b.closed_on ? `<button type="button" class="btn sm" data-cat="close" data-id="${p.id}">Отметить закрытой</button>` : "")
      + `<button type="button" class="linkbtn" data-cat="own" data-id="${p.id}">своя точка</button>`
      + `<button type="button" class="linkbtn" data-cat="reject" data-id="${p.id}">Отклонить</button>`;
  }
  function catCard(p) {
    const b = byId.get(p.bath_id), g = catGroup(p), open = catOpen.has(p.id);
    const title = esc(b?.name || p.found_name || "Баня");
    const name = p.lat != null || catRaw(b) ? `<button type="button" class="radar-name" data-cat="fly" data-id="${p.id}" title="Показать на карте">${title}</button>` : `<b class="radar-name">${title}</b>`;
    const tone = p.match >= 90 ? "ok" : p.match >= 70 ? "ok" : p.match >= 40 ? "warn" : "muted";
    return `<li class="radar-card cat-card${g === "done" ? " is-done" : ""}${p.id === catPin ? " focus" : ""}" data-id="${p.id}">
      <div class="radar-head">${name}<span class="vd vd-${tone}">уверенность ${p.match}</span></div>
      ${catOurs(p, b)}${catProp(p, b)}
      <div class="radar-links">${catLinks(p)}<button type="button" class="linkbtn" data-cat="more" data-id="${p.id}">${open ? "Свернуть" : "Подробнее"}</button></div>
      ${open ? catMore(p) : ""}
      <div class="radar-acts">${catActs(p, b)}</div></li>`;
  }
  // карта: найденные точки вкладки; на выбранной — наша точка сейчас и пунктир до найденной
  let catMap = null, catLayer = null, catGhost = null, catHot = null;
  const catMarks = new Map();
  function catMapRender(rows) {
    if ($("#catSide").classList.contains("folded")) return;
    if (!catMap) {
      catMap = L.map("catmap", { zoomSnap: 0.5 }).setView([55.75, 37.6], 5);
      catMap.attributionControl.setPrefix(false);
      L.tileLayer(TILE_URL, tileOpts).addTo(catMap); syncTheme();
      catLayer = L.layerGroup().addTo(catMap);
    }
    setTimeout(() => catMap.invalidateSize(), 0);
    catLayer.clearLayers(); catMarks.clear(); catGhost = null; catHot = null;
    const pts = [];
    for (const p of rows) {
      const ll = p.lat != null ? [p.lat, p.lng] : catRaw(byId.get(p.bath_id));
      if (!ll) continue;
      pts.push(ll);
      const m = L.circleMarker(ll, { radius: 7, weight: 2, className: `rd ${p.lat != null ? "rd-new" : "rd-search"}${p.status !== "new" ? " rd-done" : ""}` })
        .bindTooltip(`<b>${esc(byId.get(p.bath_id)?.name || p.found_name || "")}</b>${p.address ? `<br>${esc(p.address)}` : ""}`, { direction: "top", offset: [0, -6] })
        .on("click", () => catFocus(p.id, true))
        .addTo(catLayer);
      catMarks.set(p.id, m);
    }
    const key = catTab + "|" + catQ + "|" + catRegion;
    if (key !== catFitKey && pts.length) { catMap.fitBounds(pts, { padding: [28, 28], maxZoom: 13, animate: false }); catFitKey = key; }
  }
  function catPair(p) {
    if (catGhost) { catLayer.removeLayer(catGhost); catGhost = null; }
    const ours = p && catRaw(byId.get(p.bath_id));
    if (!ours || p.lat == null || !catMap || catFar(p, byId.get(p.bath_id)) < 0.03) return ours || null;
    catGhost = L.layerGroup([
      L.polyline([[p.lat, p.lng], ours], { className: "rd-link", weight: 2, dashArray: "4 6", interactive: false }),
      L.circleMarker(ours, { radius: 6, weight: 2, className: "rd rd-league" }).bindTooltip("Наша точка сейчас", { direction: "top", offset: [0, -6] }),
    ]);
    catLayer.addLayer(catGhost);
    return ours;
  }
  // показать баню на карте: найденная точка, а если наша в другом месте — обе в кадре, с пунктиром
  function catShow(p, zoom) {
    const ours = catPair(p), here = p.lat != null ? [p.lat, p.lng] : ours;
    if (!catMap || !here) return;
    if (ours && here !== ours) catMap.fitBounds([here, ours], { padding: [48, 48], maxZoom: zoom, animate: !calm });
    else catMap.setView(here, zoom, { animate: !calm });
  }
  // навёл на карточку и задержался — карта едет к бане (20.10); мышь просто проходит по списку — карта стоит.
  // Только с мышью и при открытой карте: на телефоне — нажатием на название
  const HOVER = matchMedia("(hover: hover) and (pointer: fine)").matches;
  let catFlyT = null;
  function catHover(id, on) {
    if (on ? catHot === id : catHot !== id) return;
    catHot = on ? id : null;
    const m = catMarks.get(id);
    if (m) { m.setRadius(on ? 12 : 7); if (on) m.bringToFront(); }
    const p = cat.find((x) => x.id === (on ? id : catPin));
    catPair(p);
    clearTimeout(catFlyT);
    if (on && p && HOVER && !$("#catSide").classList.contains("folded")) catFlyT = setTimeout(() => { if (catHot === id) catShow(p, 15); }, 250);
  }
  function catFocus(id, scroll) {
    $$("#catList .radar-card.focus").forEach((x) => x.classList.remove("focus"));
    const card = $(`#catList .radar-card[data-id="${id}"]`); if (!card) return;
    card.classList.add("focus");
    if (scroll) card.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
  }
  const catPass = () => {
    const q = lowerE(catQ.trim());
    return (p) => {
      const b = byId.get(p.bath_id);
      if (catRegion && (b?.region || b?.country || "") !== catRegion) return false;
      return !q || lowerE(`${b?.name || ""} ${p.found_name || ""} ${p.city || ""} ${p.address || ""} ${b?.region || ""} ${b ? dirWho(b).map(([n]) => n).join(" ") : ""}`).includes(q);
    };
  };
  function renderCat() {
    if (!cat) {
      D.catalog().then((rows) => { cat = rows; renderCat(); })
        .catch((err) => { $("#catList").innerHTML = `<li class="hint">Сверка не загрузилась: ${esc(err.message)}</li>`; });
      return;
    }
    const regions = [...new Set(cat.map((p) => byId.get(p.bath_id)).filter(Boolean).map((b) => b.region || b.country).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    if ($("#catRegion").options.length !== regions.length + 1)
      $("#catRegion").innerHTML = `<option value="">Все регионы</option>` + regions.map((r) => `<option${r === catRegion ? " selected" : ""}>${esc(r)}</option>`).join("");
    const pass = catPass(), by = {};
    for (const p of cat) if (pass(p)) (by[catGroup(p)] ||= []).push(p);
    if (!catTab || !CAT_TABS.some(([t]) => t === catTab)) catTab = ["type", "sure", "check", "region", "flag", "doubt"].find((t) => by[t]?.length) || "sure";
    $("#catTabs").innerHTML = CAT_TABS.map(([t, l]) => `<button type="button" role="tab" data-tab="${t}" aria-pressed="${t === catTab}">${l}<span class="n">${by[t]?.length || 0}</span></button>`).join("");
    const doneN = cat.filter((p) => p.status !== "new").length;
    $("#catProgress").hidden = !cat.length;
    $("#catProgress").innerHTML = `<div class="bar"><i style="width:${cat.length ? Math.round(doneN / cat.length * 100) : 0}%"></i></div><span>Разобрано <b>${doneN}</b> из ${cat.length}</span>`;
    $("#catN").textContent = cat.length - doneN ? ` · ${cat.length - doneN}` : "";
    $("#catTabNote").textContent = CAT_TABS.find(([t]) => t === catTab)[2];
    const rows = (by[catTab] || []).sort((a, b) => (catTab === "done" ? Date.parse(b.decided_at || 0) - Date.parse(a.decided_at || 0) : b.match - a.match || (byId.get(b.bath_id)?.nAll || 0) - (byId.get(a.bath_id)?.nAll || 0)));
    // пачкой — только уверенные: у них два источника сошлись
    const batch = catTab === "sure" ? rows.filter((p) => p.status === "new") : [];
    $("#catBatch").hidden = !batch.length;
    $("#catBatch").innerHTML = !batch.length ? "" : catAsk?.batch
      ? `<div class="radar-ask"><span>Принять ${batch.length} ${plural(batch.length, "баню", "бани", "бань")}? Найденные точки станут точными, наши точные рядом не тронем.</span>
          <button type="button" class="btn solid sm" data-cat="batch-go">Принять ${batch.length}</button><button type="button" class="linkbtn" data-cat="cancel">Отмена</button></div>`
      : `<span>${batch.length} ${plural(batch.length, "баня ждёт", "бани ждут", "бань ждут")} решения${catQ || catRegion ? " (с учётом фильтра)" : ""}</span><button type="button" class="btn solid sm" data-cat="batch">Принять все ${batch.length}</button>`;
    $("#catList").innerHTML = rows.length ? rows.map(catCard).join("")
      : `<li class="radar-empty">${catTab === "done" ? "Пока ничего не решено." : catQ || catRegion ? "Ничего не нашлось — попробуй убрать фильтр." : "Здесь всё разобрано."}</li>`;
    catMapRender(rows);
  }
  $("#catTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]"); if (!b) return;
    catTab = b.dataset.tab; catAsk = null; catPin = null; store.set("catTab", catTab); renderCat();
  });
  catTab = store.get("catTab", null);
  let catQT = null;
  $("#catQ").addEventListener("input", (e) => { clearTimeout(catQT); catQT = setTimeout(() => { catQ = e.target.value; catAsk = null; renderCat(); }, 150); });
  $("#catRegion").addEventListener("change", (e) => { catRegion = e.target.value; catAsk = null; renderCat(); });
  $("#catMapToggle").addEventListener("click", () => {
    const f = $("#catSide").classList.toggle("folded");
    $("#catMapToggle").textContent = f ? "Показать карту" : "Свернуть карту";
    store.set("catMapFolded", f);
    if (!f) renderCat();
  });
  if (store.get("catMapFolded", false) && innerWidth <= 1000) { $("#catSide").classList.add("folded"); $("#catMapToggle").textContent = "Показать карту"; }
  $("#catList").addEventListener("mouseover", (e) => { const c = e.target.closest(".radar-card"); if (c) catHover(Number(c.dataset.id), true); });
  $("#catList").addEventListener("mouseout", (e) => { const c = e.target.closest(".radar-card"); if (c && !c.contains(e.relatedTarget)) catHover(Number(c.dataset.id), false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && catAsk) { catAsk = null; renderCat(); } });
  // решение по одной или пачке; после — данные бань заново (точки на карте лиги), внизу «Отменить»
  async function catDo(list, act, reason = null) {
    // вернули «сделали общественной» — тип бани прежний, очки снова пересчитать (смотрим по свежим данным, а не по старым карточкам)
    const retyped = act === "reopen" && (cat || []).some((x) => x.prev_type && list.some((l) => l.id === x.id));
    await D.catalogDecide(list.map((p) => p.id), act, reason);
    const fresh = await D.catalog();
    cat = fresh; catAsk = null; renderCat(); factCache.clear(); factNow.clear();   // «О бане» в карточках — по новым решениям
    if (act !== "reject" && act !== "keep") refreshData().then(renderCat).catch(() => {});
    if (retyped) recomputeSoon();
  }
  function catUndo(list, msg) {
    radarToast(msg, "Отменить", () => catDo(list, "reopen").then(() => toast("Вернули в сверку")).catch((err) => toast("Не получилось: " + err.message)));
  }
  async function catClick(e) {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    const act = b.dataset.cat, p = cat?.find((x) => x.id === Number(b.dataset.id));
    if (act === "cancel") { catAsk = null; return renderCat(); }
    if (act === "batch") { catAsk = { batch: true }; return renderCat(); }
    if (act === "batch-go") {
      const pass = catPass(), list = cat.filter((x) => x.status === "new" && catGroup(x) === "sure" && pass(x));
      b.disabled = true;
      try { await catDo(list, "accept"); catUndo(list, `Принято ${list.length} ${plural(list.length, "баня", "бани", "бань")}`); }
      catch (err) { b.disabled = false; toast("Не получилось: " + err.message); }
      return;
    }
    if (!p) return;
    if (act === "fly") {
      catFocus(p.id); catPin = p.id; clearTimeout(catFlyT);
      catShow(p, 16);
      if (innerWidth <= 1000) $("#catmap").scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "center" });
      return;
    }
    if (act === "more") { catOpen.has(p.id) ? catOpen.delete(p.id) : catOpen.add(p.id); return renderCat(); }
    if (act === "ourbath") { if (byId.has(p.bath_id)) { show("map"); openBath(p.bath_id, true); } return; }
    if (act === "reject") { catAsk = { id: p.id }; return renderCat(); }
    if (act === "own") { catAsk = { id: p.id, own: true }; renderCat(); $(`#catList form[data-own="${p.id}"] input`)?.focus(); return; }
    const name = byId.get(p.bath_id)?.name || p.found_name || "баня";
    $$("button", b.closest(".radar-acts")).forEach((x) => (x.disabled = true));
    try {
      if (act === "accept") { await catDo([p], "accept"); catUndo([p], `«${name}»: принято`); }
      else if (act === "retype") {   // тип бани → найденный агентами: очки за походы сюда пересчитаются
        await catDo([p], "retype"); recomputeSoon();
        catUndo([p], `«${name}» — ${TYPE_LABEL[p.kind_found].toLowerCase()}, таблица пересчитывается`);
      }
      else if (act === "keep") { await catDo([p], "keep"); catUndo([p], `«${name}»: оставили нашу точку`); }
      else if (act === "close") {   // баня закрылась: отметка в лиге (походы остаются), предложение — «оставили нашу»
        const bath = byId.get(p.bath_id), was = bath.closed_on;
        bath.closed_on = new Date().toISOString().slice(0, 7) + "-01";
        await D.moderateBath(bath.id, { closed_on: bath.closed_on });
        await catDo([p], "keep"); render();
        radarToast(`«${name}»: закрыта`, "Отменить", () => D.moderateBath(bath.id, { closed_on: was || null }).then(() => { bath.closed_on = was || null; return catDo([p], "reopen"); }).then(() => { render(); toast("Вернули"); }).catch((err) => toast("Не получилось: " + err.message)));
      }
      else if (act === "reject-go") { await catDo([p], "reject", b.dataset.reason); catUndo([p], `«${name}»: отклонено`); }
      else if (act === "reopen") { await catDo([p], "reopen"); toast("Вернули в сверку"); }
    } catch (err) {
      $$("button", b.closest(".radar-acts")).forEach((x) => (x.disabled = false));
      toast("Не получилось: " + err.message);
    }
  }
  $("#catList").addEventListener("click", catClick);
  // своя точка: ставим обычным путём (bath-location — точная), предложение агентов — в «Решено»: их место не то
  $("#catList").addEventListener("submit", async (e) => {
    const f = e.target.closest("form[data-own]"); if (!f) return;
    e.preventDefault();
    const p = cat.find((x) => x.id === Number(f.dataset.own)), v = f.own.value.trim(); if (!p || !v) return;
    const name = byId.get(p.bath_id)?.name || p.found_name || "баня";
    $$("button, input", f).forEach((x) => (x.disabled = true));
    try {
      await D.setBathLocation(p.bath_id, v);
      await catDo([p], "reject", "own_point");
      refreshData().then(renderCat).catch(() => {});
      toast(`«${name}»: точка поставлена`);
    } catch (err) {
      $$("button, input", f).forEach((x) => (x.disabled = false));
      toast("Не нашёл: " + err.message);
    }
  });
  $("#catBatch").addEventListener("click", catClick);

  // решения Комиссии с прошлого захода (18.10): «✅ Комиссия засчитала „Василевские“ · +4» — один раз на человека. Отметка
  // «видел» — в аккаунте (25.10: в браузере каждое устройство показывало заново) и в браузере — на случай, если сервер
  // не ответил; берём более позднюю. Первый заход — старые решения не вываливаем; свои решения Комиссии не показываем
  async function announceDecisions() {
    if (!D.live || !me?.nick) return;
    const key = `ebl.seenDecisions.${me.nick}`, nowMs = Date.now();
    let local = null, remote = null;
    try { local = Number(localStorage.getItem(key)) || null; localStorage.setItem(key, String(nowMs)); } catch { /* приватный режим */ }
    try { remote = await D.decisionsSeen(); D.markDecisionsSeen(nowMs).catch(() => {}); } catch { /* сервер не ответил */ }
    const seen = Math.max(local || 0, remote || 0) || null;
    if (!seen) return;
    const fresh = visits.filter((v) => (v.player === me.nick || v.companions.includes(me.nick)) && v.status !== "pending"
      && v.decidedAt && v.decidedAt > seen && v.decidedBy !== me.playerId).sort((a, b) => a.decidedAt - b.decidedAt);
    if (!fresh.length) return;
    const name = (v) => esc(byId.get(v.bathId)?.name || "баня");
    const ok = fresh.filter((v) => v.status === "ok"), no = fresh.filter((v) => v.status === "rejected");
    const pts = ok.reduce((a, v) => a + (v.pts?.[me.nick] || 0), 0);
    const one = fresh.length === 1 ? fresh[0] : null;
    const msg = one ? (one.status === "ok"
        ? `✅ Комиссия засчитала «${name(one)}»${one.pts?.[me.nick] ? ` · <b>+${fmt(one.pts[me.nick])}</b>` : ""}`
        : `❌ Комиссия отклонила поход в «${name(one)}»${one.reason ? `: ${esc(one.reason)}` : ""}`)
      : `Комиссия решила ${fresh.length} ${plural(fresh.length, "твой поход", "твоих похода", "твоих походов")}: `
        + [ok.length && `✅ ${ok.length}${pts ? ` · <b>+${fmt(pts)}</b>` : ""}`, no.length && `❌ ${no.length}`].filter(Boolean).join(", ");
    toast(`<span class="toast-msg">${msg}</span><button type="button" class="toast-act">В ленту</button>`, true, 9000);
    const b = $(".toast .toast-act");
    if (b) b.onclick = () => { $(".toast")?.remove(); show("feed"); $('#feedFilter button[data-f="all"]')?.click(); };
  }
  updateBadge();
  render("home");
  setTimeout(announceDecisions, 600);   // после первой отрисовки — не поверх заставки
  const h = location.hash.slice(1);
  loadRatings();
  const linked = h.match(/^bath=(\d+)$/);   // ссылка на баню — сразу её карточка на карте
  if (linked && byId.has(+linked[1])) { show("map"); openBath(+linked[1], true); }
  if (["owners", "table", "feed", "rules"].includes(h) || (h === "dir" && canModerate && D.live)) {
    show(h);
    setTimeout(() => $(`#view-${h}`)?.scrollTo(0, 0), 0);   // «#feed» — ещё и id списка: браузер прокручивал к нему, заголовок уезжал
  }
  if ((h === "radar" || h === "catalog") && canModerate && D.live) { show("dir"); setDirMode(h); }
  if (tgStart === "visit") openVisit();   // кнопка «Отметить поход» из Telegram
})();
