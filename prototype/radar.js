// Радар для просмотра (01.11, Леха): «только отображает все бани потенциальные списком и на карте по категориям, никакие
// действия на нём делать нельзя». Карта на весь экран, сверху — категории с числами (нажал — спрятал/показал), снизу шторка:
// бани в кадре от самых похожих на общественную; поиск — по всем. Нажал на баню — карточка: сводка Радара, цена, ссылки на
// 2ГИС, Яндекс и сайт. На компьютере шторка — панель слева. Ключ — последняя часть адреса (ebl.su/<ключ>), в тестах — после #.
(async () => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const num = (n) => n.toLocaleString("ru-RU");
  const boot = $("#boot");
  const fail = (text) => { boot.textContent = text; boot.classList.add("err"); };

  // категории: в лиге — всё, что Комиссия завела или привязала; дальше по виду. Аренда (частные) по умолчанию спрятана —
  // её полторы тысячи, и она забивает карту
  const CAT = [["sure", "Точно общественная", "--c-sure"], ["likely", "Скорее общественная", "--c-likely"], ["doubt", "Под вопросом", "--c-doubt"],
    ["nodata", "Нет данных", "--c-nodata"], ["spa", "Хуитнес", "--c-spa"], ["rent", "Аренда", "--c-rent"], ["league", "В лиге", "--c-league"]];
  // подписи — как во вкладке «Радар» у Комиссии (radarVerdict в app.js): общественные делятся по индексу 90 / 70
  const catOf = (p) => p.status === "added" || p.status === "matched" ? "league"
    : p.kind === "public" ? (p.index >= 90 ? "sure" : p.index >= 70 ? "likely" : "doubt")
    : p.kind === "spa" ? "spa" : p.kind === "private" || p.kind === "other" ? "rent" : "nodata";
  const css = getComputedStyle(document.documentElement);
  const color = Object.fromEntries(CAT.map(([k, , v]) => [k, css.getPropertyValue(v).trim()]));
  const title = Object.fromEntries(CAT.map(([k, t]) => [k, t]));
  const on = new Set(["sure", "likely", "doubt", "nodata", "spa", "league"]);

  const seg = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  const key = seg && !seg.endsWith(".html") ? seg : decodeURIComponent(location.hash.slice(1));
  if (!key) return fail("Радар открывается по особой ссылке.");

  // тот же путь к базе, что у сайта: шлюз в Яндекс Облаке, а если он не пускает (бывает за VPN) — Supabase напрямую
  const cfg = window.EBL_CONFIG || {};
  const call = (base) => fetch(`${base}/rest/v1/rpc/radar_view`, {
    method: "POST", headers: { apikey: cfg.supabaseKey, "Content-Type": "application/json" }, body: JSON.stringify({ p_key: key }),
  }).then((r) => r.ok ? r.json() : Promise.reject(new Error(r.status)));
  let rows;
  try { rows = await call(cfg.supabaseUrl).catch(() => cfg.directUrl ? call(cfg.directUrl) : Promise.reject()); }
  catch { return fail("Не получилось загрузить Радар — проверь интернет и обнови страницу."); }
  if (!rows) return fail("Ссылка не подходит — попроси новую.");

  const all = rows.map(([id, name, city, region, address, lat, lng, kind, status, index, website, mapUrl, price, bathId, note]) => {
    const p = { id, name, city, region, address, lat, lng, kind, status, index, website, mapUrl, price, bathId, note };
    p.cat = catOf(p);
    p.hay = [name, city, region, address].filter(Boolean).join(" ").toLowerCase().replace(/ё/g, "е");
    return p;
  });
  const count = Object.fromEntries(CAT.map(([k]) => [k, all.filter((p) => p.cat === k).length]));

  const wide = matchMedia("(min-width: 900px)");
  const map = L.map("map", { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([55.75, 37.62], wide.matches ? 9 : 10);
  map.attributionControl.setPrefix(false);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(map);
  const dots = L.layerGroup().addTo(map);
  let ring = null;   // кольцо вокруг открытой бани
  let open = null, query = "";

  const shown = () => all.filter((p) => on.has(p.cat));
  function draw() {
    dots.clearLayers();
    // в лиге — сверху и крупнее, уверенные общественные — чуть крупнее остальных
    const order = { rent: 0, spa: 1, nodata: 2, doubt: 3, likely: 4, sure: 5, league: 6 };
    for (const p of shown().sort((a, b) => order[a.cat] - order[b.cat])) {
      L.circleMarker([p.lat, p.lng], { radius: p.cat === "league" ? 6 : p.cat === "sure" || p.cat === "likely" ? 5 : 4, color: "#fff", weight: 1.2,
        fillColor: color[p.cat], fillOpacity: 0.95 }).on("click", () => show(p, false)).addTo(dots);
    }
    $("#total").textContent = "· " + num(shown().length);
  }
  function chips() {
    $("#chips").innerHTML = CAT.map(([k, t, v]) => `<button class="chip" data-cat="${k}" aria-pressed="${on.has(k)}" style="--c:var(${v})"><span class="dot"></span>${t} <b>${num(count[k])}</b></button>`).join("");
  }
  $("#chips").addEventListener("click", (e) => {
    const k = e.target.closest(".chip")?.dataset.cat; if (!k) return;
    on.has(k) ? on.delete(k) : on.add(k);
    chips(); draw();
    if (open && !on.has(open.cat)) close(); else if (!open) list();
  });

  const place = (p) => [p.city, p.region].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" · ");
  // адрес без повторов: у многих мест город и регион уже внутри адреса («…, Москва, Москва, Москва»)
  const fullAddr = (p) => {
    const parts = [], seen = new Set();
    for (const x of [p.address, p.city, p.region].filter(Boolean).flatMap((s) => s.split(/,\s*/))) {
      const k = x.trim().toLowerCase(); if (k && !seen.has(k)) { seen.add(k); parts.push(x.trim()); }
    }
    return parts.join(", ");
  };
  const row = (p) => `<button class="it" data-id="${p.id}" style="--c:${color[p.cat]}"><span class="dot"></span>
    <span><b>${esc(p.name)}</b><small>${esc(place(p) || p.address || "")}</small></span>
    <span class="idx">${p.index ?? "—"}<span class="bar" style="--w:${p.index || 0}%"></span></span></button>`;
  const LIMIT = 60;
  function list() {
    open = null;
    if (ring) { ring.remove(); ring = null; }
    let items, head;
    if (query) {
      const q = query.toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean);
      items = shown().filter((p) => q.every((w) => p.hay.includes(w)));
      head = `<b>${items.length ? "Нашлось " + num(items.length) : "Ничего не нашлось"}</b>`;
    } else {
      const b = map.getBounds();
      items = shown().filter((p) => b.contains([p.lat, p.lng]))
        .sort((a, b) => (b.cat === "league") - (a.cat === "league") || (b.index ?? -1) - (a.index ?? -1));
      head = `<b>${num(items.length)} ${plural(items.length)} в кадре</b><span>по уверенности</span>`;
    }
    $("#pane").innerHTML = `<div class="head">${head}</div>
      <div class="search"><input id="q" type="search" placeholder="Баня, город, регион" value="${esc(query)}" autocomplete="off" enterkeyhint="search">${query ? '<button id="qx" aria-label="Очистить">✕</button>' : ""}</div>
      <div class="list">${items.slice(0, LIMIT).map(row).join("")}${items.length > LIMIT ? `<p class="more">Ещё ${num(items.length - LIMIT)} — ${query ? "уточни поиск" : "приблизь карту"}</p>` : ""}</div>`;
  }
  const plural = (n) => { const d = n % 10, h = n % 100; return d === 1 && h !== 11 ? "место" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "места" : "мест"; };

  function show(p, fly = true) {
    open = p;
    if (ring) ring.remove();
    ring = L.circleMarker([p.lat, p.lng], { radius: 12, color: color[p.cat], weight: 3, fill: false, interactive: false }).addTo(map);
    document.activeElement?.blur();   // после поиска шторка была во весь экран — баню должно быть видно
    if (!wide.matches) setSheet(MID);
    if (fly) {   // баня — в середине видимой части карты, а не под шторкой или панелью
      map.setView([p.lat, p.lng], Math.max(map.getZoom(), 14), { animate: false });
      map.panBy(wide.matches ? [-190, 0] : [0, MID / 2], { animate: false });
    }
    const q = encodeURIComponent([p.name, p.city].filter(Boolean).join(" ")), ll = `${p.lng},${p.lat}`;
    const ya = /yandex|yango/.test(p.mapUrl || "") ? p.mapUrl : `https://yandex.ru/maps/?text=${q}&ll=${ll}&z=16`;
    const dg = /2gis/.test(p.mapUrl || "") ? p.mapUrl : `https://2gis.ru/search/${q}?m=${ll}/16`;
    const a = (href, text, cls = "") => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    $("#pane").innerHTML = `<div class="card" style="--c:${color[p.cat]}">
      <button class="back" id="back">← К списку</button>
      <span class="kind"><span class="dot"></span>${title[p.cat]}</span>
      <h2>${esc(p.name)}</h2>
      ${fullAddr(p) ? `<p class="addr">${esc(fullAddr(p))}</p>` : ""}
      ${p.index != null ? `<div class="meter">Похоже на общественную <span class="bar" style="--w:${p.index}%"></span><b>${p.index}</b></div>` : ""}
      ${p.note ? `<p class="note">${esc(p.note)}</p>` : ""}
      ${p.price ? `<p class="price">Цена: ${esc(p.price)}</p>` : ""}
      <div class="links">${p.bathId ? a(`./#bath=${p.bathId}`, "Открыть в ЕБЛ", "main") : ""}${a(dg, "2ГИС")}${a(ya, "Яндекс Карты")}${p.website ? a(p.website, "Сайт") : ""}</div>
    </div>`;
  }
  function close() { list(); }

  $("#pane").addEventListener("click", (e) => {
    const it = e.target.closest(".it");
    if (it) return show(all.find((p) => p.id === +it.dataset.id));
    if (e.target.closest("#back")) return close();
    if (e.target.closest("#qx")) { query = ""; list(); }
  });
  let typing;
  $("#pane").addEventListener("input", (e) => {
    if (e.target.id !== "q") return;
    clearTimeout(typing);
    typing = setTimeout(() => {
      query = e.target.value.trim();
      const pos = e.target.selectionStart;
      list();
      const inp = $("#q"); inp.focus(); inp.setSelectionRange(pos, pos);
    }, 200);
  });
  $("#pane").addEventListener("focusin", (e) => { if (e.target.id === "q" && !wide.matches) setSheet(HIGH); });
  map.on("moveend", () => { if (!open && !query) list(); });
  map.on("click", () => { if (open) close(); });

  // шторка на телефоне: три высоты — низко (видно поиск), середина, почти весь экран; тянуть за ручку или заголовок, нажатие —
  // следующая высота
  const sheet = $("#sheet");
  const LOW = 128, MID = Math.round(innerHeight * 0.42), HIGH = Math.round(innerHeight * 0.88);
  const sheetH = () => sheet.getBoundingClientRect().height;
  const setSheet = (h) => sheet.style.setProperty("--h", h + "px");
  let drag = null;
  sheet.addEventListener("pointerdown", (e) => {
    if (wide.matches || !e.target.closest(".grab, .head")) return;
    drag = { y: e.clientY, h: sheetH(), moved: false };
    sheet.classList.add("drag"); sheet.setPointerCapture(e.pointerId);
  });
  sheet.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = drag.y - e.clientY; if (Math.abs(dy) > 4) drag.moved = true;
    setSheet(Math.min(HIGH, Math.max(LOW, drag.h + dy)));
  });
  const drop = () => {
    if (!drag) return;
    sheet.classList.remove("drag");
    const h = sheetH();
    if (!drag.moved) setSheet(drag.h < MID - 10 ? MID : drag.h < HIGH - 10 ? HIGH : LOW);
    else setSheet([LOW, MID, HIGH].reduce((a, b) => Math.abs(b - h) < Math.abs(a - h) ? b : a));
    drag = null;
  };
  sheet.addEventListener("pointerup", drop);
  sheet.addEventListener("pointercancel", drop);
  if (!wide.matches) setSheet(MID);

  chips(); draw(); list();
  boot.remove();
})();
