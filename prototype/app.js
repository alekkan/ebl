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
  const PREC_LABEL = { city: "по городу из названия", region: "по центру региона", country: "по центру страны" };
  const CUR_SIGN = { RUB: "₽", USD: "$", EUR: "€", JPY: "¥", AED: "د.إ" };
  const curSign = (c) => CUR_SIGN[c] || c;
  // будни/выходной и «до HH:MM» у цены — оба поля необязательные, показываем только то, что указано
  const schedLabel = (p) => [p.is_weekend == null ? "" : p.is_weekend ? "вых" : "будни", p.before_time ? `до ${p.before_time.slice(0, 5)}` : ""].filter(Boolean).join(", ");
  const PLACE_PTS = [15, 12, 10, 8, 6, 4, 2, 1];
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- данные ----------
  const D = window.EBLData, store = D.store;
  const boot = (html) => { const el = $("#boot"); if (el) { el.innerHTML = html; el.classList.add("err"); } };
  if (D.broken) { boot("Не загрузилась связь с базой. Проверь интернет и обнови страницу."); return; }
  let data;
  try { data = await D.load(); } catch (e) {
    boot(`Не получилось загрузить данные: ${esc(e.message)}. Обнови страницу.`);
    throw e;
  }
  $("#boot")?.remove();
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
      const spread = { exact: 0, city: 0.02, region: 0.25, country: 1.2 }[prec] ?? 0;
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
  const leafSvg = (on) => `<svg class="leaf ${on ? "on" : ""}" viewBox="-6 -17 12 18" aria-hidden="true"><use href="#oak-leaf"/></svg>`;
  const leaves = (n, cls = "") => `<span class="leaves ${cls}" title="${fmt(n)} из 5">${[1, 2, 3, 4, 5].map((i) => leafSvg(i <= Math.round(n))).join("")}</span>`;
  const where = (b) => [b.region, b.country].filter(Boolean).join(", ") || "регион не указан";
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
  function show(view) {
    $$(".nav button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === view)));
    $$(".view").forEach((v) => (v.hidden = v.id !== "view-" + view));
    if (view === "map") setTimeout(() => map.invalidateSize(), 0);
    if (view === "heat") initHeat(); else stopPlay();
    if (view === "feed") renderFeed();
    history.replaceState(null, "", "#" + view);
  }
  $$(".nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

  // ---------- карта ----------
  const dark = () => document.documentElement.dataset.theme === "dark" ||
    (document.documentElement.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  const map = L.map("map", { zoomControl: true, worldCopyJump: true }).setView([55.75, 37.62], 5);
  map.attributionControl.setPrefix(false);
  const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const tileOpts = { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' };
  L.tileLayer(TILE_URL, tileOpts).addTo(map);
  const syncTheme = () => $$("#map .leaflet-tile-pane, #pickmap .leaflet-tile-pane").forEach((p) => { p.classList.toggle("tiles-dark", dark()); p.classList.toggle("tiles-soft", !dark()); });
  syncTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTheme);
  new MutationObserver(syncTheme).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const cluster = L.markerClusterGroup({ disableClusteringAtZoom: 13, maxClusterRadius: 48, showCoverageOnHover: false, spiderfyOnMaxZoom: true });
  map.addLayer(cluster);
  const markers = new Map();

  function markerFor(b) {
    // размер — по походам в 2026, силуэт внутри — тип бани
    const size = b.n26 ? Math.round(Math.min(20 + Math.sqrt(b.n26) * 2.2, 32)) : 18;
    const glyph = b.t !== "unknown" ? `<svg aria-hidden="true"><use href="#bt-${b.t}"/></svg>` : "";
    const icon = L.divIcon({
      className: "", iconSize: [size, size],
      html: `<div class="pin ${b.prec !== "exact" ? "approx" : ""} ${b.n26 >= 15 ? "hot" : ""} ${b.id === openId ? "sel" : ""}" style="width:${size}px;height:${size}px;--c:var(--t-${b.t})">${glyph}${b._pot?.length >= 3 ? `<span class="pot">+${b._pot.length}</span>` : ""}</div>`,
    });
    const m = L.marker(b.ll, { icon, title: b.name, riseOnHover: true }).on("click", () => openBath(b.id));
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
  single($("#fSeason")); single($("#fType"));
  $("#q").addEventListener("input", () => render());
  $("#fCountry").addEventListener("change", () => render(true));
  $("#fPlayer").addEventListener("change", () => render(true));
  // «Я» — выбрать себя одним нажатием (повторное — снова вся лига)
  const myNick = D.live ? me?.nick : null;
  $("#fMe").hidden = !myNick;
  $("#fMe").addEventListener("click", () => { $("#fPlayer").value = $("#fPlayer").value === myNick ? "" : myNick; render(true); });
  // «📍 Рядом» — сортировка по расстоянию. Геопозицию спрашиваем только по нажатию, никуда её не отправляем
  let here = null, hereMarker = null;
  $("#fNear").addEventListener("click", () => {
    if (here) { here = null; hereMarker?.remove(); hereMarker = null; render(); return; }
    if (!navigator.geolocation) { toast("Браузер не отдаёт геопозицию"); return; }
    $("#fNear").disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      $("#fNear").disabled = false;
      here = [pos.coords.latitude, pos.coords.longitude];
      hereMarker = L.marker(here, { icon: L.divIcon({ className: "", iconSize: [18, 18], html: '<div class="here" title="Ты здесь"></div>' }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      render(true);
    }, () => { $("#fNear").disabled = false; toast("Нет доступа к геопозиции — разреши его сайту в настройках браузера"); },
    { timeout: 10000, maximumAge: 300000 });
  });

  function render(fit) {
    const q = $("#q").value.trim().toLowerCase();
    const type = $("#fType [aria-pressed=true]").dataset.t, season = $("#fSeason [aria-pressed=true]").dataset.v;
    const country = $("#fCountry").value, player = $("#fPlayer").value;
    const metric = season === "2026" ? (b) => (player ? b.v26?.[player] || 0 : b.n26) : (b) => (player ? countFor(b, "all", player) : b.nAll);
    // выбран участник — «были / не были в 2026» считаются про него, а не про всю лигу:
    // «Не были в 2026» — все бани, где он в этом сезоне ещё не был, со счётом, сколько очков даст первый поход
    const inSeason = (b) => season === "all" ? !player || metric(b) > 0
      : season === "2026" ? (player ? metric(b) > 0 : b.n26 > 0 || b.isNew)
      : player ? !(b.v26?.[player] > 0) : b.n26 === 0;
    const pot = player && season === "never" ? potentialFor(player) : null;
    const current = baths.filter((b) => (!type || b.t === type) && (!country || b.country === country) && (!q || b.search.includes(q)) && inSeason(b));
    current.forEach((b) => {
      b._m = metric(b); b._pot = pot ? pot(b) : null;
      b._km = here && b.lat != null && b.prec !== "country" ? distKm(here, [b.lat, b.lng]) : null;   // точка «по центру страны» — не расстояние
    });
    if (here) current.sort((a, b) => (a._km ?? 1e9) - (b._km ?? 1e9));
    else if (pot) current.sort((a, b) => b._pot.length - a._pot.length || b.n26 - a.n26 || a.name.localeCompare(b.name, "ru"));
    else current.sort((a, b) => b._m - a._m || a.name.localeCompare(b.name, "ru"));
    $("#fMe").setAttribute("aria-pressed", String(!!myNick && player === myNick));
    $("#fNear").setAttribute("aria-pressed", String(!!here));
    const maxM = Math.max(1, ...current.map((b) => b._m));
    cluster.clearLayers(); markers.clear();
    const onMap = current.filter((b) => b.ll);
    cluster.addLayers(onMap.map(markerFor));
    const noPin = current.length - onMap.length;
    const rich = pot ? current.filter((b) => b._pot.length >= 3).length : 0;
    $("#count").textContent = pot
      ? `${player}: новых в 2026 — ${current.length} ${plural(current.length, "баня", "бани", "бань")}${rich ? ` · +3 и больше — ${rich}` : ""}`
      : `${current.length} ${plural(current.length, "баня", "бани", "бань")} · ${season === "2026" ? "походы в 2026" : "походы за 2023–2026"}` + (noPin ? ` · ${noPin} без точки` : "");
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
      const meta = [where(b), last && dayLabel(last), b._km != null && `${b.prec !== "exact" ? "~" : ""}${fmtKm(b._km)}`, known && `знакомая · ${known}`].filter(Boolean).join(" · ");
      return `<button class="item ${b.id === openId ? "active" : ""}" data-id="${b.id}">
        ${tdot(b.t)}
        <span><span class="it-name">${esc(b.name)}</span><span class="it-meta">${esc(meta)}</span></span>
        ${b._pot ? `<span class="it-pot" title="${esc(b._pot.join(" · "))}"><b>+${b._pot.length}</b><small>${plural(b._pot.length, "очко", "очка", "очков")}</small></span>`
          : `<span class="it-heat">${n ? `<b>${n}</b><i style="--w:${Math.max(8, (n / maxM) * 100)}%"></i>` : ""}</span>`}
      </button>`;
    }).join("") + (current.length > LIMIT ? `<div class="more">и ещё ${current.length - LIMIT} — уточни поиск</div>` : "")
      : `<div class="more">Ничего не нашлось. Попробуй другое слово или сбрось фильтры.</div>`;
    const pad = { paddingTopLeft: innerWidth > 760 ? [380, 0] : [0, 0] };
    // при старте — Европа и Россия до Урала, где почти все бани; дальние страны видно, если отдалить
    // рамка подобрана так, чтобы и на телефоне шириной 360 px влезла в зум 3, а не отскочила к целому миру
    if (fit === "home") map.fitBounds([[43, 3], [62, 60]], { ...pad, animate: false });
    else if (fit && here) map.fitBounds(L.latLngBounds([here, ...onMap.filter((b) => b._km != null).slice(0, 8).map((b) => b.ll)]).pad(0.2), { maxZoom: 13, ...pad });
    else if (fit && onMap.length) map.fitBounds(L.latLngBounds(onMap.map((b) => b.ll)).pad(0.15), { maxZoom: 12, ...pad });
  }
  $("#list").addEventListener("click", (e) => { const it = e.target.closest(".item[data-id]"); if (it) openBath(+it.dataset.id, true); });
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
  let openId = null;
  function selectPin(id) {
    $$(".pin.sel").forEach((p) => p.classList.remove("sel"));
    markers.get(id)?.getElement()?.querySelector(".pin")?.classList.add("sel");
  }
  function openBath(id, fly) {
    const b = byId.get(id); if (!b) return;
    openId = id;
    $$(".item.active").forEach((x) => x.classList.remove("active"));
    $(`.item[data-id="${id}"]`)?.classList.add("active");
    // на телефоне карточка — шторка снизу: поднимаем карту наверх, чтобы точка бани была видна над шторкой
    const narrow = innerWidth <= 760;
    if (narrow) $("#view-map").scrollTo({ top: 0, behavior: calm ? "auto" : "smooth" });
    if (fly && b.ll) {
      const z = Math.max(map.getZoom(), b.prec === "exact" ? 15 : 11);
      map.flyTo(b.ll, z, { duration: calm ? 0 : 0.7 });
      map.once("moveend", () => selectPin(id));
    } else {
      if (narrow && b.ll) map.panTo(b.ll, { animate: !calm });
      selectPin(id);
    }
    const who = Object.entries(b.v26 || {}).sort((x, y) => y[1] - x[1]);
    const pv = prices[id] || [];   // по возрастанию price_date — последняя цена в конце
    const lastP = pv[pv.length - 1], olderP = pv.slice(0, -1).reverse();
    const bv = beerPrices[id] || [];
    const lastBeer = bv[bv.length - 1], olderBeer = bv.slice(0, -1).reverse();
    const rv = reviews[id] || [];
    // отзывов у участника может быть несколько (сходил ещё раз — написал ещё); в средней — последняя оценка каждого
    const lastRate = new Map();
    for (const r of rv) if (!lastRate.has(r.author)) lastRate.set(r.author, r.rate);
    const avg = lastRate.size ? [...lastRate.values()].reduce((a, x) => a + x, 0) / lastRate.size : 0;
    const myRate = 4, iWrote = rv.some((r) => r.mine);
    const pending = visits.filter((v) => v.bathId === id && v.status === "pending").length;
    // последний засчитанный поход с портала — журнал видят только участники, гостю строки нет
    const lastV = visits.filter((v) => v.bathId === id && v.status === "ok").sort((x, y) => y.date.localeCompare(x.date))[0];
    const hist = Object.entries(b.hist || {}).sort();
    const d = $("#drawer");
    d.innerHTML = `
      <button class="x" aria-label="Закрыть">${icon("close")}</button>
      <div class="d-hero t-${b.t}">
        <div class="pills">
          ${canModerate && D.live
            ? `<label class="pill pill-sel">${tdot(b.t)}<select id="dType" aria-label="Тип бани — меняет Комиссия">${b.t === "unknown" ? '<option value="" selected>Тип не указан</option>' : ""}${Object.entries(TYPE_CHOICE).map(([t, l]) => `<option value="${t}" ${b.t === t ? "selected" : ""}>${l}</option>`).join("")}</select></label>`
            : `<span class="pill">${tdot(b.t)}${TYPE_LABEL[b.t]}</span>`}
          ${b.t === "public" ? '<span class="pill oak">+1 очко</span>' : ""}
          ${b.isNew ? '<span class="pill ember">новая, на модерации</span>' : ""}
          ${!b.n26 && !b.nHist && !b.isNew ? '<span class="pill ember">кандидат в ультрауникальные</span>' : ""}
          ${b.n26 >= 15 ? `<span class="pill ember">${icon("flame").replace('class="ic"', 'class="ic" style="width:14px;height:14px"')}место силы</span>` : ""}
        </div>
        <h2>${esc(b.name)}${canModerate && D.live ? ` <button type="button" class="linkbtn rename" id="dRename" title="Поправить название — Комиссия">✏️</button>` : ""}</h2>
        <div class="where">${icon("pin")}${esc(where(b))}</div>
      </div>
      <div class="d-body">
        <div class="stats">
          <div><b>${b.n26}</b><span>${plural(b.n26, "поход", "похода", "походов")} в 2026</span></div>
          <div><b>${who.length}</b><span>${plural(who.length, "участник", "участника", "участников")}</span></div>
          <div><b>${avg ? fmt(avg) : "—"}</b><span>${avg ? leaves(avg) : "нет оценок"}</span></div>
        </div>
        ${(() => {
          const who = $("#fPlayer").value || myNick; if (!who) return "";
          const parts = potentialFor(who)(b); if (!parts) return "";
          return `<div class="note-soft pot-line"><span>🎯 ${who === myNick ? "Тебе" : esc(who)} за первый поход в 2026:</span><b>+${parts.length}</b><span class="hint">${parts.join(" · ")}</span></div>`;
        })()}
        ${!b.ll || b.prec !== "exact" ? `<div class="note-soft geo-fix">
          <span>${b.ll ? `Точка на карте примерная — ${PREC_LABEL[b.prec] || "по названию"}.` : "Этой бани ещё нет на карте."}</span>
          ${D.live && member ? `<button class="btn sm" id="geoFixBtn" type="button">📍 Знаю, где это</button>
          <form id="geoFixForm" hidden><input class="inp" id="geoFixInput" placeholder="Ссылка на баню в картах, адрес или координаты" required>
          <button class="btn sm solid" type="submit">Поставить</button></form>` : D.live ? `<span class="hint">Войди — и сможешь поставить точную точку.</span>` : ""}
        </div>` : ""}
        <div class="d-actions">
          <button class="cta" id="dVisit">${icon("plus")}<span>Я тут парился</span></button>
          <a class="btn" target="_blank" rel="noopener" href="${b.prec === "exact" && b.ll
            ? `https://yandex.ru/maps/?rtext=~${b.ll[0]},${b.ll[1]}&rtt=auto`   /* точка есть — маршрут прямо до неё */
            : `https://yandex.ru/maps/?text=${encodeURIComponent(b.name + " " + (b.region || b.country || ""))}`}">${icon("route")}Маршрут</a>
        </div>
        <section>
          <h3>Цена</h3>
          ${lastP ? `<p class="hint" style="margin:0"><b>${fmt(lastP.price)} ${curSign(lastP.currency)}</b>${lastP.duration_min ? ` / ${lastP.duration_min} мин` : ""}${schedLabel(lastP) ? ` · ${schedLabel(lastP)}` : ""} <small>— ${dayLabel(lastP.price_date)}</small></p>
            ${olderP.length ? `<p class="hint" style="margin:6px 0 0">Раньше: ${olderP.map((p) => `${fmt(p.price)} ${curSign(p.currency)}${p.duration_min ? ` / ${p.duration_min} мин` : ""}${schedLabel(p) ? ` · ${schedLabel(p)}` : ""} (${dayLabel(p.price_date)})`).join(" · ")}</p>` : ""}`
            : `<p class="hint" style="margin:0">Цену пока никто не указал.</p>`}
          ${lastBeer ? `<p class="hint" style="margin:6px 0 0">🍺 <b>${fmt(lastBeer.price)} ${curSign(lastBeer.currency)}</b> <small>— ${dayLabel(lastBeer.price_date)}</small></p>
            ${olderBeer.length ? `<p class="hint" style="margin:6px 0 0">Раньше: ${olderBeer.map((p) => `${fmt(p.price)} ${curSign(p.currency)} (${dayLabel(p.price_date)})`).join(" · ")}</p>` : ""}` : ""}
          ${member ? `<form class="prform" id="prForm">
            <div class="row">
              <input class="inp" id="prPrice" type="number" min="1" step="1" placeholder="♨️ Цена входа, ₽" required>
              <input class="inp" id="prBeer" type="number" min="1" step="1" placeholder="🍺 Цена пива, ₽">
            </div>
            <button class="btn solid" type="submit" style="justify-self:start">Добавить</button>
            <button type="button" class="linkbtn" id="prMore">ещё: продолжительность сеанса · будни/выходной · валюта →</button>
            <div class="row" id="prExtra" hidden>
              <input class="inp" id="prDur" type="number" min="1" placeholder="Продолжительность сеанса, мин">
              <div class="seg" id="prWeekend" role="radiogroup" aria-label="Будни или выходной">
                <button type="button" data-w="" aria-pressed="true">Любой день</button>
                <button type="button" data-w="0" aria-pressed="false">Будни</button>
                <button type="button" data-w="1" aria-pressed="false">Выходной</button>
              </div>
              <label class="hint" style="display:flex;align-items:center;gap:6px">Скидка до <input class="inp" id="prBefore" type="time" style="flex:0 0 auto"></label>
              <input class="inp" id="prCurrency" placeholder="Валюта (по умолчанию ₽)">
            </div>
          </form>` : ""}
        </section>
        <section>
          <h3>Кто парился в 2026</h3>
          ${who.length ? `<div class="who">${who.map(([p, n]) => `<button data-player="${esc(p)}">${ava(p, "sm")}${esc(p)}${n > 1 ? `<b>×${n}</b>` : ""}</button>`).join("")}</div>`
            : `<p class="hint" style="margin:0">${!b.nHist && !b.isNew
                ? "С 2023 года здесь никого из лиги не было — первые, кто сходит, возьмут +1 за ультрауникальную и +1 за уникальную."
                : "В этом сезоне здесь ещё никого не было — каждому, кто сходит, +1 за уникальную."}</p>`}
          ${lastV ? `<p class="hint last-visit" style="margin:10px 0 0">Последний раз — <b>${dayLabel(lastV.date)}</b>: ${esc([lastV.player, ...(lastV.companions || [])].join(", "))}</p>` : ""}
          ${hist.length ? `<p class="hint" style="margin:10px 0 0">Прошлые сезоны: ${hist.map(([y, n]) => `${y} — ${n}`).join(" · ")} · всего с 2023 — <b>${b.nAll}</b></p>` : ""}
          ${pending ? `<p class="hint" style="margin:6px 0 0">Ещё ${pending} на модерации</p>` : ""}
        </section>
        <section>
          <h3>Отзывы${rv.length ? " · " + rv.length : ""}</h3>
          <div class="reviews">
            ${rv.length ? rv.map((r) => `<div class="review">${ava(r.author)}<div>
              <div class="rh"><b>${esc(r.author)}${r.sample ? '<span class="sample">пример</span>' : ""}</b>${leaves(r.rate)}${r.at ? `<small class="hint">${dayLabel(mskIso(r.at))}</small>` : ""}</div>
              <p>${esc(r.text)}</p>${r.id && (r.mine || canModerate) ? `<button type="button" class="linkbtn" data-rvdel="${r.id}">удалить</button>` : ""}</div></div>`).join("") : `<p class="hint" style="margin:0">Отзывов пока нет — расскажи про пар первым.</p>`}
          </div>
        </section>
        ${!member ? `<div class="rvform"><p class="hint" style="margin:0">Отзывы пишут участники лиги.</p><button class="btn solid" type="button" id="rvLogin" style="justify-self:start">${D.live && me ? "Кто ты в таблице?" : "Войти через Telegram"}</button></div>` : `
        <form class="rvform" id="rvForm">
          <div class="row">
            <div class="rate" id="rvRate" role="radiogroup" aria-label="Оценка в вениках">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-r="${n}" role="radio" aria-checked="${n === myRate}" aria-label="${n} из 5">${leafSvg(n <= myRate).replace('class="leaf', 'class="leaf big')}</button>`).join("")}</div>
            ${D.live ? `<span class="hint">от имени <b>${esc(me.nick)}</b></span>` : `<select id="rvAuthor" class="sel" aria-label="Автор">${players.map((p) => `<option ${p === store.get("me", "") ? "selected" : ""}>${esc(p)}</option>`).join("")}</select>`}
          </div>
          <textarea id="rvText" class="inp" placeholder="Какой пар, веники, купель, мужские часы, цены…" required aria-label="Текст отзыва"></textarea>
          <button class="btn solid" type="submit" style="justify-self:start">${iWrote ? "Добавить ещё отзыв" : "Опубликовать отзыв"}</button>
          ${iWrote ? '<span class="hint">Прошлый отзыв останется — это будет ещё один.</span>' : ""}
        </form>`}
      </div>`;
    d.hidden = false;
    $(".x", d).onclick = closeBath;
    $("#dType", d)?.addEventListener("change", async (e) => {
      try {
        await D.moderateBath(b.id, { type: e.target.value || null });
        b.type = e.target.value || null; b.t = b.type || "unknown"; render(); openBath(b.id);
        toast(`Тип: ${TYPE_LABEL[b.t]} — таблица пересчитывается`); recomputeSoon();
      } catch (err) { toast("Не получилось: " + err.message); }
    });
    $("#dVisit", d).onclick = () => openVisit({ bathId: id });
    $("#prMore", d)?.addEventListener("click", () => { $("#prMore", d).hidden = true; $("#prExtra", d).hidden = false; });
    $$("#prWeekend button", d).forEach((b) => b.addEventListener("click", () => $$("#prWeekend button", d).forEach((x) => x.setAttribute("aria-pressed", String(x === b)))));
    $("#prForm", d)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const price = +$("#prPrice", d).value; if (!price || price <= 0) return;
      const currency = $("#prCurrency", d).value.trim() || null;
      const durationMin = +$("#prDur", d).value || null;
      const wVal = $("#prWeekend [aria-pressed=true]", d)?.dataset.w;
      const isWeekend = wVal === "" || wVal == null ? null : wVal === "1";
      const beforeTime = $("#prBefore", d).value || null;
      const beerPrice = +$("#prBeer", d).value || null;
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
    const rateBtns = $$("#rvRate button", d);
    const setRate = (n) => rateBtns.forEach((x) => { const on = +x.dataset.r <= n; x.setAttribute("aria-checked", String(+x.dataset.r === n)); $(".leaf", x).classList.toggle("on", on); });
    rateBtns.forEach((x) => (x.onclick = () => setRate(+x.dataset.r)));
    $("#geoFixBtn", d)?.addEventListener("click", () => { $("#geoFixBtn", d).hidden = true; $("#geoFixForm", d).hidden = false; $("#geoFixInput", d).focus(); });
    $("#geoFixForm", d)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        const p = await D.setBathLocation(id, $("#geoFixInput", d).value.trim());
        b.lat = p.lat; b.lng = p.lng; b.precision = "exact"; hydrate(b);
        render(); openBath(id, true); toast("📍 Точка поставлена — спасибо!");
        refreshData().then(() => openId === id && openBath(id)).catch(() => {});   // страну и регион по точке сервер мог заполнить
      } catch (err) { toast(err.message); }
    });
    $("#rvLogin", d)?.addEventListener("click", () => (me ? openClaim() : openLogin()));
    $$("[data-rvdel]", d).forEach((x) => (x.onclick = async () => {
      if (!confirm("Удалить отзыв?")) return;
      try { await D.deleteReview(id, +x.dataset.rvdel); reviews[id] = (reviews[id] || []).filter((r) => r.id !== +x.dataset.rvdel); toast("Отзыв удалён"); openBath(id); }
      catch (err) { toast("Не удалилось: " + err.message); }
    }));
    // Комиссия правит название бани прямо в карточке («Северные Киров» → «Киров, Северные»)
    $("#dRename", d)?.addEventListener("click", async () => {
      const name = prompt("Название бани — как в справочнике Комиссии", b.name)?.trim();
      if (!name || name === b.name) return;
      try { await D.moderateBath(id, { name }); b.name = name; hydrate(b); render(); openBath(id); toast("Название поправлено"); }
      catch (err) { toast("Не получилось: " + err.message); }
    });
    const rvForm = $("#rvForm", d);
    if (rvForm) rvForm.onsubmit = async (e) => {
      e.preventDefault();
      const text = $("#rvText", d).value.trim(); if (!text) return;
      const rate = +(rateBtns.find((x) => x.getAttribute("aria-checked") === "true")?.dataset.r || 4);
      const author = D.live ? me.nick : $("#rvAuthor", d).value;
      try {
        const rid = await D.submitReview(id, author, rate, text);
        if (D.live) reviews[id] = [{ id: rid, author, rate, text, at: new Date().toISOString(), mine: true }, ...(reviews[id] || [])];
        toast("Отзыв опубликован — спасибо за пар"); openBath(id);
      } catch (err) { toast("Отзыв не сохранился: " + err.message); }
    };
  }
  function closeBath() { $("#drawer").hidden = true; openId = null; $$(".pin.sel").forEach((p) => p.classList.remove("sel")); $$(".item.active").forEach((x) => x.classList.remove("active")); }

  // ---------- таблица ----------
  let sortKey = "total", sortDir = -1;
  const COLS = [["baths", "Бань"], ["u", "У"], ["uu", "УУ"], ["long", "Дл"], ["k", "К"], ["pub", "Общ"], ["reg", "Рег"]];
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
    const playedWeeks = Math.max(0, ...standings.flatMap((s) => Object.keys(s.weekPts || {}).map(Number)));
    $("#tableEyebrow").innerHTML = `Сезон 2026 · разыграно <b>${playedWeeks}</b> ${plural(playedWeeks, "неделя", "недели", "недель")}`;
    // в начале сезона (или на пустой базе) участников может быть меньше трёх — пьедестал без пустых ступеней
    $("#podium").innerHTML = [ranked[1], ranked[0], ranked[2]].filter(Boolean).map((s) => `
      <button class="pod p${s.place}" data-player="${esc(s.name)}">
        ${ava(s.name, "xl")}
        <span class="pod-name">${esc(s.name)}</span>
        <span class="pod-pts"><b>${fmt(s.total)}</b> ${plural(s.total, "очко", "очка", "очков")}</span>
        <span class="pod-step">${s.place}</span>
      </button>`).join("");
  }
  rankTable();
  const renderTimer = () => ($("#tableTimer").innerHTML = `${icon("clock")}до конца W${curWeek} <b>${timeLeft()}</b>`);
  renderTimer();
  function renderTable() {
    const rows = [...ranked].sort((a, b) => sortDir * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) || a.place - b.place);
    const byTotal = sortKey === "total" && sortDir < 0;
    const th = (k, l, cls = "") => `<th data-k="${k}" class="${cls} ${k === sortKey ? "on" : ""}">${l}${k === sortKey ? (sortDir < 0 ? " ↓" : " ↑") : ""}</th>`;
    $("#standings").innerHTML = `
      <thead><tr>${th("place", "#")}<th class="l">Участник</th>${th("crowns", `<svg class="hat-ic" aria-hidden="true"><use href="#i-banhat"/></svg>`, "crown-col")}${th("total", "Очки")}${COLS.map(([k, l]) => th(k, l)).join("")}<th class="l">12 недель</th></tr></thead>
      <tbody>${rows.map((s) => `<tr data-player="${esc(s.name)}" class="${s.place <= 3 ? "top3" : ""} ${byTotal && s.place === 16 ? "cut" : ""} ${byTotal && s.place > 16 ? "below" : ""}">
        <td class="pos">${s.place}</td>
        <td class="l who-cell"><span>${ava(s.name, "sm")}${esc(s.name)}</span></td>
        <td class="crowns" title="${s.crowns ? `Выиграл ${s.crowns} ${plural(s.crowns, "неделю", "недели", "недель")}` : "Пока без побед в неделях"}">${s.crowns ? `<svg class="hat-ic" aria-hidden="true"><use href="#i-banhat"/></svg><b>${s.crowns}</b>` : ""}</td>
        <td class="pts">${fmt(s.total)}</td>
        ${COLS.map(([k]) => `<td>${s[k] ?? 0}</td>`).join("")}
        <td class="l">${spark(s)}</td></tr>`).join("")}</tbody>`;
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
      if (!r) return `<div class="pod p${pos} empty"><span class="pod-step">${pos}</span></div>`;
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

  // ---------- тепловая карта ----------
  let heatMap = null, heat = null, heatYear = 2026, playTimer = null;
  // на светлой карте самое жаркое — насыщенно-красное (белое ядро там не видно), на тёмной и спутнике — «огонь» до белого
  const GRAD = {
    light: { 0.12: "#fdd49e", 0.3: "#fdae6b", 0.5: "#f16913", 0.7: "#d7301f", 0.88: "#a50f15", 1: "#5c0010" },
    fire: { 0.12: "#4a1203", 0.3: "#9c2a06", 0.5: "#e4561a", 0.7: "#f7962c", 0.88: "#fdd36a", 1: "#ffffff" },
  };
  const SAT_URL = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const SAT_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
  const heatLayers = {};
  let heatStyle = store.get("heatStyle", "light");
  $("#hPlayer").innerHTML += [...allPlayers].sort((a, b) => a.localeCompare(b, "ru")).map((p) => `<option>${esc(p)}</option>`).join("");
  function initHeat() {
    if (heatMap) { setTimeout(() => heatMap.invalidateSize(), 0); return; }
    heatMap = L.map("heatmap", { worldCopyJump: true, zoomSnap: 0.5 }).setView([52, 45], 3);
    heatMap.attributionControl.setPrefix(false);
    heatLayers.osm = L.tileLayer(TILE_URL, tileOpts);
    heatLayers.sat = L.layerGroup([
      L.tileLayer(SAT_URL, { maxZoom: 18, attribution: "Снимки &copy; Esri, Maxar, Earthstar Geographics" }),
      L.tileLayer(SAT_LABELS, { maxZoom: 18, pane: "overlayPane" }),
    ]);
    // leaflet-heat дорисовывает кадр и тогда, когда вкладку «Жар» уже скрыли (холст 0×0) — getImageData падает; такой кадр пропускаем
    if (!L.HeatLayer.prototype._eblGuard) {
      const redraw = L.HeatLayer.prototype._redraw;
      L.HeatLayer.prototype._redraw = function () { if (this._canvas?.width && this._canvas?.height) return redraw.call(this); this._frame = null; };
      L.HeatLayer.prototype._eblGuard = true;
    }
    heat = L.heatLayer([], { radius: 14, blur: 18, max: 1, minOpacity: 0.2, gradient: GRAD.light }).addTo(heatMap);
    heatMap.on("zoomend", tuneHeat);
    setHeatStyle(heatStyle);
    renderHeat(true);
  }
  function setHeatStyle(st) {
    heatStyle = st; store.set("heatStyle", st);
    $("#view-heat").dataset.style = st;
    $$("#hStyle button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.s === st)));
    if (!heatMap) return;
    const base = st === "sat" ? heatLayers.sat : heatLayers.osm, other = st === "sat" ? heatLayers.osm : heatLayers.sat;
    if (heatMap.hasLayer(other)) heatMap.removeLayer(other);
    if (!heatMap.hasLayer(base)) heatMap.addLayer(base);
    const pane = $("#heatmap .leaflet-tile-pane");
    pane.classList.remove("tiles-heat-light", "tiles-heat-dark", "tiles-heat-sat");
    pane.classList.add("tiles-heat-" + st);
    heat.setOptions({ gradient: st === "light" ? GRAD.light : GRAD.fire, minOpacity: st === "light" ? 0.3 : 0.2 });
  }
  $("#hStyle").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setHeatStyle(b.dataset.s); });
  setHeatStyle(heatStyle);
  // интенсивность не должна тухнуть при отдалении — держим maxZoom слоя равным текущему зуму
  function tuneHeat() {
    const z = heatMap.getZoom();
    heat.setOptions({ maxZoom: z, radius: Math.round(Math.min(34, 10 + z * 1.5)), blur: Math.round(Math.min(36, 12 + z * 1.6)) });
    aggregateHeat();
  }
  // как в Strava: походы складываются по ячейкам экрана при текущем зуме, яркость — по логарифмической шкале
  // от самой жаркой ячейки: места силы горят заметно ярче, но Москва не гасит остальные города,
  // а баня с парой походов остаётся бледным, но видимым пятном
  let heatPts = [];
  function aggregateHeat() {
    if (!heatPts.length) { heat.setLatLngs([]); return; }
    const z = heatMap.getZoom(), cell = (heat.options.radius + heat.options.blur) / 2, grid = new Map();
    for (const [lat, lng, n] of heatPts) {
      const p = heatMap.project([lat, lng], z), key = Math.floor(p.x / cell) + ":" + Math.floor(p.y / cell);
      const g = grid.get(key);
      if (g) { g.x += p.x * n; g.y += p.y * n; g.n += n; } else grid.set(key, { x: p.x * n, y: p.y * n, n });
    }
    const cells = [...grid.values()], maxN = Math.max(...cells.map((c) => c.n));
    heat.setLatLngs(cells.map((c) => {
      const ll = heatMap.unproject([c.x / c.n, c.y / c.n], z);
      return [ll.lat, ll.lng, Math.pow(Math.log1p(c.n) / Math.log1p(maxN), 0.8)];
    }));
  }
  function renderHeat(fit) {
    const player = $("#hPlayer").value;
    const rows = baths.map((b) => [b, countFor(b, heatYear, player)]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    // точки «по центру страны» не рисуем — они дали бы ложное пятно посреди страны
    const pts = rows.filter(([b]) => b.ll && b.prec !== "country").map(([b, n]) => [b.ll[0], b.ll[1], n]);
    heatPts = pts;
    tuneHeat();
    const visitsN = rows.reduce((a, [, n]) => a + n, 0), ctry = new Set(rows.map(([b]) => b.country).filter(Boolean));
    $("#hKpis").innerHTML = [[visitsN, plural(visitsN, "поход", "похода", "походов")], [rows.length, plural(rows.length, "баня", "бани", "бань")], [ctry.size, plural(ctry.size, "страна", "страны", "стран")]]
      .map(([n, l]) => `<div><b>${n.toLocaleString("ru-RU")}</b><span>${l}</span></div>`).join("");
    $("#hTop").innerHTML = rows.slice(0, 7).map(([b, n], i) => `<li data-id="${b.id}"><span class="hk">${i + 1}</span><span><span class="hn">${esc(b.name)}</span><span class="hm">${esc(where(b))}</span></span><span class="hv">${n}</span></li>`).join("")
      || `<li><span></span><span class="hm">${player ? `${esc(player)} в этом году не парился` : "Пусто"}</span></li>`;
    $("#hNote").textContent = heatYear === 2026 ? `Сезон 2026 — ${DATA_NOTE}.` : "Походы прошлых лет привязаны к баням по названию, около 2% не нашли пару в справочнике.";
    const mark = $("#heatYearMark");
    mark.textContent = heatYear === "all" ? "2023–26" : heatYear;
    mark.classList.remove("flash"); void mark.offsetWidth; mark.classList.add("flash");
    // вся лига — стартуем с европейской части России, где основной жар; участник — по его баням
    // на телефоне низ карты под шторкой — центр ниже, чтобы Европа и Россия попали в видимую часть
    if (fit && !player) heatMap.setView(innerWidth > 760 ? [55.4, 32] : [43, 30], innerWidth > 760 ? 5 : 3);
    else if (fit && pts.length) heatMap.fitBounds(L.latLngBounds(pts.map((p) => [p[0], p[1]])).pad(0.1), { maxZoom: 9, paddingTopLeft: innerWidth > 760 ? [360, 0] : [0, 0] });
  }
  function setYear(y) {
    heatYear = y === "all" ? "all" : +y;
    $$("#hYear button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.y === String(y))));
    renderHeat(false);
  }
  $("#hYear").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { stopPlay(); setYear(b.dataset.y); } });
  $("#hPlayer").addEventListener("change", () => renderHeat(true));
  $("#hTop").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]"); if (!li) return;
    const b = byId.get(+li.dataset.id); if (!b?.ll) return;
    heatMap.flyTo(b.ll, b.prec === "exact" ? 14 : 11, { duration: calm ? 0 : 0.8 });
    const pop = L.popup({ closeButton: false, offset: [0, -4] }).setLatLng(b.ll)
      .setContent(`<div class="heat-pop"><b>${esc(b.name)}</b><span>${esc(where(b))} · ${b.nAll} ${plural(b.nAll, "поход", "похода", "походов")} с 2023</span><br><button type="button" data-open="${b.id}">Открыть карточку →</button></div>`);
    heatMap.once("moveend", () => pop.openOn(heatMap));
  });
  document.addEventListener("click", (e) => { const o = e.target.closest("[data-open]"); if (o) { show("map"); openBath(+o.dataset.open, true); } });
  function stopPlay() {
    if (!playTimer) return;
    clearInterval(playTimer); playTimer = null;
    $("#hPlay").innerHTML = `${icon("play")}<span>Годы</span>`;
  }
  $("#hPlay").addEventListener("click", () => {
    if (playTimer) return stopPlay();
    let i = 0;
    $("#hPlay").innerHTML = `${icon("pause")}<span>Пауза</span>`;
    const step = () => { if (i < YEARS.length) setYear(YEARS[i++]); else { stopPlay(); setYear("all"); } };
    step(); playTimer = setInterval(step, 1700);
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
  function openPlayer(name) {
    // новичка ещё нет в таблице (ни бань из таблицы, ни засчитанных походов) — карточка всё равно открывается
    const s = ranked.find((x) => x.name === name)
      || { name, total: 0, baths: 0, u: 0, uu: 0, long: 0, k: 0, pub: 0, reg: 0, weekPts: {}, weekBaths: {}, place: ranked.length + 1 };
    const weeks = Array.from({ length: curWeek }, (_, i) => i + 1);
    const maxB = Math.max(1, ...weeks.map((w) => s.weekBaths[w] ?? 0));
    const mine = baths.filter((b) => b.v26?.[name]).sort((a, b) => b.v26[name] - a.v26[name]);
    const regions = new Set(mine.filter((b) => b.region && b.country).map(placeKey));
    const ctry = new Set(mine.map((b) => b.country).filter(Boolean));
    const empty = !s.baths;
    const types = mine.reduce((a, b) => ((a[b.t] = (a[b.t] || 0) + b.v26[name]), a), {});
    const best = Math.max(...weeks.map((w) => s.weekBaths[w] ?? 0));
    // сверху — свежие походы с портала (по дате), ниже — бани из таблицы Комиссии (там дат нет); гостю журнал не виден
    const guest = D.live && !member;
    const jr = guest ? new Map() : journalOf(name);
    const lastDay = [...jr.values()].filter((r) => r.ok).reduce((a, r) => (r.last > a ? r.last : a), "");
    const onlyJournal = [...jr.keys()].filter((id) => !byId.get(id).v26?.[name]).map((id) => byId.get(id));   // ещё на проверке
    const dated = [...mine.filter((b) => jr.has(b.id)), ...onlyJournal].sort((a, b) => jr.get(b.id).last.localeCompare(jr.get(a.id).last));
    const undated = mine.filter((b) => !jr.has(b.id)).sort((a, b) => b.v26[name] - a.v26[name] || a.name.localeCompare(b.name, "ru"));
    const bRow = (b) => {
      const r = jr.get(b.id), n = b.v26?.[name] || 0;
      return `<button data-bath="${b.id}"><span>${esc(b.name)}</span><span class="bl-r">${r?.pending ? "<em>на проверке</em>" : ""}${n > 1 ? `<b>×${n}</b>` : ""}${r ? `<time datetime="${r.last.slice(0, 10)}">${dayLabel(r.last)}</time>` : ""}</span></button>`;
    };
    const blist = dated.map(bRow).join("")
      + (undated.length && !guest ? `<div class="bl-sep">${dated.length ? "Раньше — по таблице Комиссии, там без дат" : "По таблице Комиссии — там без дат"}</div>` : "")
      + undated.map(bRow).join("");
    $("#playerBody").innerHTML = `
      <div class="p-head">${ava(name, "xl")}<div>
        <div class="eyebrow">${commission.has(name) ? "Комиссия ЕБЛ · " : ""}${empty ? "участник лиги" : `${s.place} место в сезоне`}</div>
        <h2>${esc(name)}</h2>
        <div class="sub">${empty ? "В этом сезоне пока без бань" : `<b>${fmt(s.total)}</b> ${plural(s.total, "очко", "очка", "очков")} · ${s.baths} ${plural(s.baths, "баня", "бани", "бань")}${best ? ` · рекорд — ${best} ${plural(best, "баня", "бани", "бань")} за неделю` : ""}${lastDay ? ` · последняя — ${dayLabel(lastDay)}` : ""}`}</div>
      </div></div>
      ${empty ? `<div class="p-body"><div class="empty" style="padding:28px 8px">${markSvg()}<b>Сезон ещё впереди</b><p>Первая баня — сразу +1 за поход и +1 за уникальную.</p></div></div>` : `<div class="p-body">
        <div class="stats four">
          <div><b>${s.u}</b><span>уникальных</span></div><div><b>${s.uu}</b><span>ультра&shy;уникальных</span></div>
          <div><b>${s.long}</b><span>долгих</span></div><div><b>${s.k}</b><span>за компанию</span></div>
        </div>
        <section>
          <h3>Бань по неделям</h3>
          <div class="bars">${weeks.map((w) => { const v = s.weekBaths[w] ?? 0; return `<div class="${v ? "" : "zero"}" style="height:${Math.max(2, (v / maxB) * 100)}%" title="W${w}: ${v} ${plural(v, "баня", "бани", "бань")}, ${fmt(s.weekPts[w] ?? 0)} за место"></div>`; }).join("")}</div>
          <div class="axis"><span>W1</span><span>W${Math.round(curWeek / 2)}</span><span>W${curWeek}</span></div>
        </section>
        <div class="cols2">
          <section><h3>Бани сезона · ${mine.length}</h3><div class="blist">${blist || '<span class="hint">Пока пусто</span>'}</div>
            ${guest && mine.length ? '<p class="hint" style="margin:8px 0 0">Даты походов видны участникам лиги после входа.</p>' : ""}</section>
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
    $("#playerModal").hidden = false;
    $$("#playerBody [data-bath]").forEach((x) => (x.onclick = () => { $("#playerModal").hidden = true; show("map"); openBath(+x.dataset.bath, true); }));
    if ($("#pOnMap")) $("#pOnMap").onclick = () => {
      $("#playerModal").hidden = true; show("map"); closeBath();
      // остальные фильтры сбрасываем, иначе можно увидеть «Ничего не нашлось»
      $("#q").value = ""; $("#fCountry").value = "";
      $$("#fType button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.t === "")));
      $("#fPlayer").value = name; $$("#fSeason button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === "2026")));
      render(true);
    };
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
    vf.reset();
    delete $("#nbCountry").dataset.manual; delete $("#nbRegion").dataset.manual;
    $("#vPlayer").value = D.live ? me.nick : store.get("me", players[0]);
    $("#vPlayer").disabled = D.live;
    $("#vDate").value = mskNow();
    setDur(120);
    $("#vPrMore").hidden = false; $("#vPrExtra").hidden = true;
    $$("#vPrWeekend button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.w === "")));
    picked = bathId ? byId.get(bathId) : null; newPin = null; lastTotal = 0; pickedType = null;
    if (pickMarker) { pickMarker.remove(); pickMarker = null; }
    $("#nbGeoState").textContent = "Или кликни на карте. Точку можно перетащить.";
    renderComp(); renderPicked(); calc();
    $("#visitModal").hidden = false;
    if (!picked) setTimeout(() => $("#vBathQ").focus(), 50);
  }
  // на телефоне наведения нет: по нажатию сначала бросок ковша и хлопок пара, потом форма — иначе шторка
  // формы сразу закрывает кнопку и анимации не видно. На компьютере её уже показало наведение — форма сразу.
  let pouring = false;
  $("#addVisitBtn").onclick = () => {
    if (pouring) return;
    const b = $("#addVisitBtn"); b.classList.remove("pour"); void b.offsetWidth; b.classList.add("pour");
    setTimeout(() => b.classList.remove("pour"), 2600);
    const wait = calm || !matchMedia("(hover: none)").matches ? 0 : 950;
    if (!wait) return openVisit();
    pouring = true;
    setTimeout(() => { pouring = false; openVisit(); }, wait);
  };

  function setDur(m) {
    $("#vDur").value = m;
    $$("#vDurChips button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.m === m)));
  }
  $("#vDurChips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { setDur(+b.dataset.m); calc(); } });
  $("#vPrMore").addEventListener("click", () => { $("#vPrMore").hidden = true; $("#vPrExtra").hidden = false; });
  $$("#vPrWeekend button").forEach((b) => b.addEventListener("click", () => $$("#vPrWeekend button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)))));

  function renderComp() {
    const me = $("#vPlayer").value;
    const was = new Set($$("#vComp button[aria-pressed=true]").map((c) => c.dataset.p));
    // сначала те, с кем чаще ходят в бани из таблицы — просто по месту в зачёте
    // все участники лиги — и новички, которых ещё нет в таблице; частые попутчики (по месту в зачёте) — первыми
    const order = new Map(ranked.map((s, i) => [s.name, i]));
    const everyone = [...players].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9) || a.localeCompare(b, "ru"));
    $("#vComp").innerHTML = everyone.filter((p) => p !== me).map((p) => `<button type="button" data-p="${esc(p)}" aria-pressed="${was.has(p)}">${ava(p)}${esc(p)}</button>`).join("");
    compCount();
  }
  function compCount() { const n = $$("#vComp button[aria-pressed=true]").length; $("#vCompCount").textContent = n ? `· ${n + 1} в компании` : ""; }
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
      box.innerHTML = `<div class="picked"><span><b>${esc(picked.name)}</b><small>${tdot(picked.t)} ${TYPE_LABEL[picked.t]} · ${esc(where(picked))}</small></span><button type="button" class="btn sm" data-other>Другая</button></div>${ask}`;
      $("[data-other]", box).onclick = () => { picked = null; pickedType = null; renderPicked(); calc(); $("#vBathQ").focus(); };
      $$("[data-ptype]", box).forEach((b) => (b.onclick = () => { pickedType = pickedType === b.dataset.ptype ? null : b.dataset.ptype; renderPicked(); calc(); }));
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
  // точка новой бани: кликом, перетаскиванием, по ссылке/адресу или геопозиции
  function placePin(p, fly = true) {
    newPin = p;
    if (!pickMarker) {
      pickMarker = L.marker(p, { draggable: true, icon: L.divIcon({ className: "", iconSize: [22, 22], html: '<div class="pin" style="width:22px;height:22px;--c:var(--ember)"></div>' }) }).addTo(pickMap);
      pickMarker.on("dragend", () => { const ll = pickMarker.getLatLng(); placePin([ll.lat, ll.lng], false); });
    } else pickMarker.setLatLng(p);
    if (fly) pickMap.setView(p, 16);
    $("#nbGeoState").textContent = `Точка: ${p[0].toFixed(5)}, ${p[1].toFixed(5)} ✓ — можно перетащить`;
    fillRegion(p);
  }
  // страна и регион по точке (если ещё не заполнены) — от них зависят очки за новый регион и страну
  // название из OpenStreetMap — к написанию, которое уже есть у бань лиги («Кировская область» → «Кировская обл»),
  // иначе бонус «новый регион» дадут там, где участник уже был (то же делает бот: _shared/place.ts)
  function matchPlace(country, region) {
    const stem = (s) => regionKey(s).split(/[\s-]/)[0].slice(0, 7);
    const c = baths.find((b) => b.country && regionKey(b.country) === regionKey(country))?.country ?? country ?? "";
    if (!region) return { country: c, region: "" };
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
      const a = r.address || {}, p = matchPlace(a.country, a.state || a.region || a.city);
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
    const hits = baths.filter((b) => b.search.includes(q)).sort((a, b) => b.n26 - a.n26).slice(0, 7);
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
    return { ...base, lines, total: lines.reduce((a, l) => a + (l[1] || 0), 0) };
  }
  function calc() {
    const date = $("#vDate").value;
    if (date) {
      const w = weekOf(mskNow());
      $("#vWeekHint").textContent = date > mskNow() ? "это время ещё не наступило" : `отмечаешь сейчас — поход идёт в неделю W${w}`;
    }
    const r = score();
    $("#calc").innerHTML = `
      <div class="t-head"><span>Талон</span><small>W${r.week} · ${esc(r.player)}</small></div>
      ${r.empty ? `<div class="t-empty">${esc(r.empty)}</div>` :
        r.lines.map(([t, p, cls]) => `<div class="t-line ${cls || ""}"><span>${esc(t)}</span><i></i><b>${p ? "+" + p : "0"}</b></div>`).join("")}
      <div class="t-total"><span>Итого</span><b id="tTotal">+${lastTotal}</b></div>
      <div class="t-foot">Плюс очки за место в неделе — после её закрытия, в ночь на понедельник</div>`;
    countUp($("#tTotal"), lastTotal, r.total);
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
    const payload = { bathId: picked.id, newBath, date: r.date, week: r.week, dur: r.dur,
      bathType: picked !== "new" && picked.t === "unknown" ? pickedType : null,
      companions: r.comp, player: r.player, lines: r.lines.filter((l) => l[1]), total: r.total };
    vf.dataset.busy = "1"; $("#vSubmit span").textContent = "Отправляю…";
    try {
      const saved = await D.submitVisit(payload);
      const priceVal = +$("#vPrice").value;
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
      const beerVal = +$("#vPrBeer").value;
      if (beerVal > 0) {
        const currency = $("#vPrCurrency").value.trim() || null;
        try {
          const bid = await D.submitBeerPrice(payload.bathId, beerVal, currency);
          if (bid) (beerPrices[payload.bathId] ||= []).push({ id: bid, price: beerVal, currency: (currency || "RUB").toUpperCase(), price_date: new Date().toISOString().slice(0, 10) });
        } catch { /* поход важнее цены пива */ }
      }
      if (payload.createdBath) { const nb = payload.createdBath; hydrate(nb); baths.push(nb); byId.set(nb.id, nb); }
      if (payload.bathType && D.live) { const pb = byId.get(payload.bathId); if (pb && !pb.type) { pb.type = payload.bathType; pb.t = payload.bathType; } }
      if (D.live) visits.unshift({ id: saved.id, player: r.player, companions: r.comp, bathId: payload.bathId, date: r.date, posted: mskNow(), dur: r.dur,
        lines: [], total: null, preview: r.total, status: "pending" });
      leafBurst($("#vSubmit"));
      setTimeout(() => { $("#visitModal").hidden = true; }, calm ? 0 : 450);
      updateBadge(); render();
      if (!$("#view-feed").hidden) renderFeed();
      toast(`С лёгким паром! <b>+${r.total}</b> ушло на модерацию`, true);
    } catch (err) {
      toast("Поход не сохранился: " + err.message);
    } finally {
      delete vf.dataset.busy; $("#vSubmit span").textContent = "Отправить";
    }
  });

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
  // Комиссии по умолчанию — то, что ждёт решения
  let feedFilter = canModerate && D.live ? "pending" : "all";
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
    const counts = { pending: 0, ok: 0, rejected: 0, all: visits.length };
    visits.forEach((v) => counts[v.status]++);
    $$("#feedFilter button").forEach((b) => {
      const label = { pending: "На модерации", ok: "Засчитанные", rejected: "Отклонённые", all: "Все" }[b.dataset.f];
      b.innerHTML = `${label}${counts[b.dataset.f] ? `<b>${counts[b.dataset.f]}</b>` : ""}`;
    });
    const shown = visits.filter((v) => feedFilter === "all" || v.status === feedFilter);
    if (visits.length && !shown.length) { $("#feed").innerHTML = `<div class="empty"><b>Здесь пусто</b><p>В этом разделе заявок нет.</p></div>`; return; }
    $("#feed").innerHTML = visits.length ? shown.map((v) => {
      const b = byId.get(v.bathId);
      const week = v.week ?? weekOf(v.posted || v.date);
      const pts = v.total ?? v.preview;
      return `<article class="post">
        <div class="post-head">
          <span class="stack">${[v.player, ...v.companions].slice(0, 4).map((p) => ava(p)).join("")}</span>
          <div class="post-who"><b>${esc(v.player)}</b>${v.companions.length ? ` и ещё ${v.companions.length}` : ""}<small>${fmtDate(v.date)} МСК · W${week}${v.companions.length ? " · " + v.companions.map(esc).join(", ") : ""}</small></div>
          <span class="status ${v.status}">${STATUS[v.status]}</span>
        </div>
        <div><a class="post-bath" href="#map" data-bath="${v.bathId}">${esc(b?.name || "баня")}</a><div class="hint">${esc(b ? where(b) : "")}</div></div>
        <div class="post-meta">
          <span>${v.dur > 150 ? "🔥 долгая" : "⚡ экспресс"}</span>
          ${(() => { const rep = repeatOf(v), who = [v.player, ...v.companions];
            return rep.length ? `<span class="warn" title="Движок очки не срезает: баню могли кинуть за прошлый день. Решает Комиссия">⚠️ похоже на повтор бани в те же сутки${rep.length < who.length ? " у " + rep.map(esc).join(", ") : ""} — проверь дату (п. 5)</span>` : ""; })()}
          ${v.lines.map((l) => `<span>${esc(l[0].split(" · ")[0])} +${l[1]}</span>`).join("")}
        </div>
        ${/^https:\/\/t\.me\//.test(v.tgLink || "") ? `<div class="post-links"><a href="${esc(v.tgLink)}" target="_blank" rel="noopener">пост в группе ↗</a></div>` : ""}
        ${v.status === "rejected" && v.reason ? `<div class="post-reason">Причина: ${esc(v.reason)}</div>` : ""}
        <div class="post-head" style="justify-content:space-between">
          <span class="post-pts">${pts != null ? "+" + fmt(pts) : ""}${v.total == null && v.status === "pending" ? '<small class="hint"> по талону</small>' : ""}</span>
          ${sec ? `<span class="post-actions">
            ${v.status === "pending" ? `<button class="btn sm solid" data-ok="${v.id}">${icon("check")}Засчитать</button><button class="btn sm danger" data-no="${v.id}">Отклонить</button>` : ""}
            ${D.live ? `<button class="btn sm" data-edit="${v.id}">✏️ Изменить</button>` : ""}
          </span>` : ""}
        </div>
      </article>`;
    }).join("") : `<div class="empty">${markSvg()}<b>Тут пока тихо</b><p>Добавь первую баню — поход появится здесь, а Комиссия засчитает его в таблицу.</p><button class="cta" id="emptyCta">${icon("plus")}<span>Добавить баню</span></button></div>`;
    $("#emptyCta")?.addEventListener("click", () => openVisit());
  }
  $("#feed").addEventListener("click", (e) => {
    const ok = e.target.closest("[data-ok]")?.dataset.ok, no = e.target.closest("[data-no]")?.dataset.no, bl = e.target.closest("[data-bath]");
    const ed = e.target.closest("[data-edit]")?.dataset.edit;
    if (ed) return openEdit(visits.find((x) => x.id === +ed));
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
        lat: nb.lat, lng: nb.lng, precision: nb.precision, status: nb.status, isNew: nb.isNew });
      hydrate(b);
    }
    visits = fresh.visits;
    Object.keys(reviews).forEach((k) => delete reviews[k]); Object.assign(reviews, fresh.reviews);
    Object.keys(prices).forEach((k) => delete prices[k]); Object.assign(prices, fresh.prices);
    rankTable(); renderKpis(); render(); renderRace(); renderTable(); updateBadge();
    if (!$("#tWeek").hidden) renderWeek();
    if (!$("#view-feed").hidden) renderFeed();
  }

  // ---------- правка заявки Комиссией ----------
  function openEdit(v) {
    const f = $("#editForm");
    let bath = byId.get(v.bathId), people = [v.player, ...v.companions], status = v.status, long = v.dur > 150;
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
          <span class="hint">Долгая — +1 всей компании.</span></div>
        <div class="field"><span class="lab">Компания</span>
          <div id="ePeople">${people.map((n) => `<div class="erow">${ava(n, "sm")}<b>${esc(n)}</b>${n === v.player ? '<span class="hint">автор</span>' : `<button type="button" class="linkbtn" data-rm="${esc(n)}">убрать</button>`}</div>`).join("")}</div>
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
      $$("[data-rm]", f).forEach((b) => (b.onclick = () => { keep(); people = people.filter((n) => n !== b.dataset.rm); draw(); }));
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
        await D.updateVisit(v.id, patch, people);
        Object.assign(v, { bathId: bath.id, date: $("#eEntered").value, posted: $("#ePosted").value, dur, status, reason: patch.reject_reason,
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
  // формы (поход, правка заявки) не закрываем случайным тапом мимо и Esc — иначе вписанное пропадает; закрывает крестик
  const FORMS = ["visitModal", "editModal"];
  $$(".modal").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m && !FORMS.includes(m.id)) m.hidden = true; }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = $$(".modal").filter((m) => !m.hidden && !FORMS.includes(m.id));
    if (open.length) open.forEach((m) => (m.hidden = true)); else if (!$("#drawer").hidden && $$(".modal").every((m) => m.hidden)) closeBath();
  });
  let tt;
  function toast(msg, html) {
    $(".toast")?.remove(); clearTimeout(tt);
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status");
    t[html ? "innerHTML" : "textContent"] = msg; document.body.append(t);
    tt = setTimeout(() => t.remove(), 3000);
  }

  // ---------- вход через Telegram ----------
  // вход полноценной страницей Telegram (без всплывающих окон): Telegram возвращает на сайт с #tgAuthResult=…
  function openLogin() {
    if (!D.live) return;
    const cfg = window.EBL_CONFIG;
    if (!cfg.telegramBot || !cfg.telegramBotId) return toast("Вход через Telegram откроется совсем скоро");
    $("#loginBody").innerHTML = `<div class="eyebrow">Для участников лиги</div><h2>Вход в ЕБЛ</h2>
      <p class="lead">Входи через Telegram тем же аккаунтом, что в группе. Мы видим имя, username и фото профиля — телефон остаётся у Telegram.</p>
      <button class="cta big tg-btn" id="tgLogin"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M21.5 4.5 2.8 11.7c-1 .4-1 1.8.1 2.1l4.6 1.4 1.8 5.5c.3.8 1.3 1 1.9.4l2.6-2.5 4.7 3.4c.8.6 1.9.1 2.1-.9L23 5.9c.2-1.1-.8-1.9-1.5-1.4Z" style="fill:currentColor;stroke:none"/></svg><span>Войти через Telegram</span></button>
      <p class="hint">Откроется страница Telegram — подтверди вход, и тебя вернёт сюда.</p>
      <p class="hint login-err" id="loginErr"></p>`;
    $("#tgLogin").onclick = () => {
      const back = location.origin + location.pathname;
      location.href = "https://oauth.telegram.org/auth?bot_id=" + cfg.telegramBotId + "&origin=" + encodeURIComponent(location.origin)
        + "&request_access=write&return_to=" + encodeURIComponent(back);
    };
    $("#loginModal").hidden = false;
  }
  // возврат от Telegram: #tgAuthResult=<base64 JSON>
  async function finishTelegramLogin() {
    const m = location.hash.match(/tgAuthResult=([^&]+)/);
    if (!m) return false;
    history.replaceState(null, "", location.pathname);
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
      $("#loginBody").innerHTML = `<div class="p-mini">${ava(me.nick, "lg")}<div><div class="eyebrow">${me.isCommission ? "Комиссия ЕБЛ" : "Участник лиги"}</div><h2>${esc(me.nick)}</h2></div></div>
        <div class="grid2"><button class="btn" id="myProfile">${icon("trophy")}Мой сезон</button><button class="btn danger" id="logoutBtn">Выйти</button></div>`;
      $("#myProfile").onclick = () => { $("#loginModal").hidden = true; openPlayer(me.nick); };
      $("#logoutBtn").onclick = async () => { await D.logout(); location.reload(); };
      $("#loginModal").hidden = false;
    };
  }
  renderMe();
  if (D.live) finishTelegramLogin().then((back) => {
    // вошёл, но ник не выбрал — без этого шага Комиссии нечего подтверждать; раньше его пропускали, не заметив кнопку в углу
    if (!back && me && !me.nick && !me.claimedNick) openClaim();
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

  updateBadge();
  render("home");
  const h = location.hash.slice(1);
  if (["heat", "table", "feed", "rules"].includes(h)) show(h);
})();
