// Оценка бани — отдельная лёгкая страница (01.11, Леха: мини-приложение грузилось долго; «всё на один экран, без прокрутки»).
// Ссылку rate.html?t=<ключ> присылает бот после «засчитано»: ключ входит на сайт под тем, кого пригласили (tg-login ?rate),
// и страница сразу показывает оценку похода — без карты и без загрузки всей лиги. Без ключа (rate.html?v=<поход>) — для
// того, кто уже вошёл на сайте. Восемь пунктов «градусником» (вариант Б2): полоска жара и ручка с цифрой 1–5; сверху общая
// листьями, как в рейтинге на карте. После оценки — по желанию цена входа, отзыв и фото.
(async () => {
  const D = window.EBLData;
  const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n) => String(Math.round(n * 100) / 100).replace(".", ",");
  const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
  const fanSvg = (v) => `<svg class="fan" viewBox="-15 -19 30 26" aria-hidden="true">${[-62, -31, 0, 31, 62].map((a, i) => ({ a, i }))
    .sort((x, y) => Math.abs(y.a) - Math.abs(x.a)).map(({ a, i }) => `<use href="#oak-leaf" class="${i < Math.floor(v + 0.25) ? "on" : i < Math.ceil(v) ? "half" : ""}" transform="rotate(${a}) scale(${i === 2 ? 1.1 : i % 2 ? 0.98 : 0.84})"/>`).join("")}<rect x="-1.6" y="-.5" width="3.2" height="7" rx="1.6"/></svg>`;
  const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
  const mskDay = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
  const dayLabel = (iso) => {
    const d = mskDay(Date.parse(iso)), now = Date.now();
    if (d === mskDay(now)) return "сегодня";
    if (d === mskDay(now - 864e5)) return "вчера";
    const [, m, dd] = d.split("-").map(Number);
    return `${dd} ${MONTHS[m - 1]}`;
  };
  let tt;
  const toast = (msg) => {
    $(".toast")?.remove(); clearTimeout(tt);
    const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.append(t); tt = setTimeout(() => t.remove(), 3500);
  };
  const body = $("#rateBody");
  // «Закрыть» (03.11, Витёк): назад туда, откуда пришёл оценивать (список бань, карточка); пришёл из бота — на карту
  const back = () => { if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) history.back(); else location.href = "./"; };
  // link — вторая, тихая ссылка под «Закрыть» (например, «Открыть баню на карте»): в тексте она рвала строку посередине
  const say = (title, text, close, link) => {
    body.innerHTML = `<div class="rate-done"><h2 class="rate-title">${esc(title)}</h2><p class="lead">${text}</p>${close ? '<button type="button" class="cta big" id="rateClose">Закрыть</button>' : ""}`
      + `${link ? `<a class="linkbtn" href="${link[0]}">${esc(link[1])}</a>` : ""}</div>`;
    $("#rateClose", body)?.addEventListener("click", back);
  };

  const CRIT = [["stove", "Печь"], ["steam", "Пар"], ["aqua", "Аквазона"], ["outdoor", "Выход на улицу"], ["kitchen", "Кухня"],
    ["atmosphere", "Атмосфера"], ["service", "Сервис"], ["prices", "Цены"]];
  const WORD = ["", "плохо", "так себе", "норм", "хорошо", "огонь"];
  // цена входа — валюта по стране бани
  const CUR = ["RUB", "EUR", "USD", "KZT", "BYN", "GEL", "AMD", "TRY", "AED", "JPY", "THB", "CNY"];
  const curOf = (country) => ({ "Россия": "RUB", "Казахстан": "KZT", "Беларусь": "BYN", "Грузия": "GEL", "Армения": "AMD", "Турция": "TRY",
    "ОАЭ": "AED", "Япония": "JPY", "Таиланд": "THB", "Китай": "CNY", "США": "USD" })[country] || (country ? "EUR" : "RUB");

  if (!D?.live) return say("Оценка бани", "Не загрузилась связь с базой — проверь интернет и открой ссылку ещё раз.");
  // ключ из ссылки — вход; сам ключ из адреса убираем, чтобы его не переслали дальше вместе со ссылкой
  const qs = new URLSearchParams(location.search);
  let visit = Number(qs.get("v")) || null;
  if (qs.get("t")) {
    try { visit = await D.loginRate(qs.get("t")); }
    catch (e) { return say("Ссылка не открылась", `${esc(e.message)}. Самая свежая — в личке у бота ЕБЛ.`); }
    history.replaceState(null, "", `rate.html?v=${visit}`);
  }
  // из карточки бани (01.11): rate.html?b=<баня> — оценка по бане, где был (любой поход, с портала или из таблицы)
  const bathId = Number(qs.get("b")) || null;
  if (!visit && !bathId) return say("Оценка бани", "Открой ссылку «⭐ Оценить» из личных сообщений бота ЕБЛ.");
  let f;
  try { f = bathId ? await D.ratingFormBath(bathId) : await D.ratingForm(visit); } catch (e) { return say("Не открылось", esc(e.message)); }
  if (!f) return say("Поход не найден", "Возможно, его удалили. Самые свежие ссылки — в личке у бота ЕБЛ.");
  if (!f.allowed) {
    const why = { login: bathId ? 'Оценивают участники лиги — <a href="./">войди на сайте</a> и открой баню ещё раз.' : "Открой ссылку «⭐ Оценить» из личных сообщений бота ЕБЛ — она сама тебя впустит.",
      stranger: "Оценивает тот, кто был в этом походе.", rejected: "Комиссия отклонила этот поход — оценить его нельзя.",
      old: "Рейтинг собираем с недавних походов." }[f.why] || "";
    return say(f.name, why);
  }

  const s = { ...(f.scores || {}) };
  const filled = () => CRIT.filter(([k]) => s[k]).length;
  const avg = () => { const v = CRIT.map(([k]) => s[k]).filter(Boolean); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : 0; };
  const full = () => filled() === CRIT.length;
  body.innerHTML = `<header class="rate-head">
      <div><div class="eyebrow">Оценка бани · ${f.entered_at ? dayLabel(f.entered_at) : f.year ? `был в ${f.year}` : ""}</div><h1 class="rate-title">${esc(f.name)}</h1></div>
      <div class="rate-score"><b id="rScore">—</b><span id="rLeaves"></span></div>
    </header>
    <div class="rate-form">${CRIT.map(([k, t]) => `<div class="rate-line" data-line="${k}">
        <div class="rl-t"><b>${t}</b><em class="rl-w"></em></div>
        <div class="heat" role="slider" tabindex="0" aria-label="${t}" aria-valuemin="1" aria-valuemax="5" data-heat="${k}">
          <span class="heat-fill"></span><span class="heat-dots"><i></i><i></i><i></i><i></i><i></i></span><span class="heat-knob"></span></div>
      </div>`).join("")}</div>
    <div class="rate-foot"><button class="cta" type="button" id="rateSave">${icon("check")}<span></span></button></div>`;
  const save = $("#rateSave", body);
  const paint = () => {
    for (const [k] of CRIT) {
      const v = s[k] || 0, h = $(`[data-heat="${k}"]`, body);
      h.style.setProperty("--p", v ? (v - 1) / 4 : 0); h.dataset.v = v;
      $(".heat-knob", h).textContent = v || "";
      h.setAttribute("aria-valuenow", v || 1); h.setAttribute("aria-valuetext", v ? `${v} — ${WORD[v]}` : "не оценено");
      const w = $(`[data-line="${k}"] .rl-w`, body);
      w.textContent = v ? WORD[v] : "проведи"; w.dataset.v = v;
    }
    const a = avg(), n = filled();
    $("#rScore", body).textContent = n ? fmt(Math.round(a * 10) / 10) : "—";
    $("#rLeaves", body).innerHTML = n ? fanSvg(a) : "<small>0 из 8</small>";
    $("span", save).textContent = full() ? `${f.scores ? "Сохранить" : "Оценить"} · ${fmt(a)}` : `Осталось ${CRIT.length - n} из 8`;
    save.disabled = !full();
  };
  const buzz = () => { try { navigator.vibrate?.(8); } catch { /* нет вибрации */ } };
  const set = (k, n) => { if (s[k] === n) return; s[k] = n; buzz(); paint(); };
  $$("[data-heat]", body).forEach((h) => {
    const k = h.dataset.heat;
    // деления — по центрам пяти точек: ручка шириной 30 px ходит от края до края
    const at = (x) => { const r = h.getBoundingClientRect(); return Math.min(5, Math.max(1, Math.round(((x - r.left - 15) / (r.width - 30)) * 4) + 1)); };
    let drag = false;
    h.addEventListener("pointerdown", (e) => { drag = true; h.setPointerCapture?.(e.pointerId); h.classList.add("drag"); set(k, at(e.clientX)); });
    h.addEventListener("pointermove", (e) => { if (drag) set(k, at(e.clientX)); });
    const up = () => { drag = false; h.classList.remove("drag"); };
    h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
    h.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (d) { e.preventDefault(); set(k, Math.min(5, Math.max(1, (s[k] || (d > 0 ? 0 : 2)) + d))); }
    });
  });
  save.onclick = async () => {
    if (!full() || save.dataset.busy) return;
    save.dataset.busy = "1"; save.disabled = true;
    let overall;
    try { overall = +(bathId ? await D.rateBath(bathId, s) : await D.rateVisit(visit, s)); }
    catch (e) { delete save.dataset.busy; save.disabled = false; return toast("Не сохранилось: " + e.message); }
    buzz(); thanks(overall);
  };
  paint();

  // фото — как на сайте: уменьшаем в браузере (большое и превью) и кладём в хранилище по одноразовой ссылке
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
  // экран после оценки (01.11, макет Лехи): компактная шапка, цены как на сайте — вход и пиво рядом, валюта одна на обе;
  // «ещё» раскрывает будни/выходной, сеанс и скидку до часа; ниже отзыв и фото. «Готово» сохраняет всё разом
  const curSign = (c) => ({ RUB: "₽", EUR: "€", USD: "$" })[c] || c;
  const money = (n) => Number(n).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  const num = (raw) => { const t = raw.trim(); return t ? Number(t.replace(/[\s\u00a0]/g, "").replace(",", ".")) : null; };
  async function lastPrice() {
    try {
      const { data } = await D.sb.from("bath_prices").select("price, currency").eq("bath_id", f.bath).order("price_date", { ascending: false }).limit(1);
      return data?.[0] ?? null;
    } catch { return null; }
  }
  function thanks(overall) {
    const photos = [];
    let weekend = null;   // null — любой день, false — будни, true — выходной
    const cur0 = curOf(f.country);
    body.innerHTML = `<header class="thx-head"><b>${fmt(overall)}</b>
        <div><h1>${esc(f.name)}</h1><p>${fanSvg(overall)}Спасибо! Уже в рейтинге</p></div></header>
      <form class="rate-rv" id="rateRv">
        <div class="thx-sec"><span>Цены <small id="ratePrev"></small></span>
          <div class="thx-prices">
            <label class="thx-inp"><svg class="ic" aria-hidden="true"><use href="#i-steam"/></svg><input id="ratePrice" inputmode="decimal" placeholder="Вход" autocomplete="off" aria-label="Цена входа"></label>
            <label class="thx-inp"><svg class="ic" aria-hidden="true"><use href="#i-beer"/></svg><input id="rateBeer" inputmode="decimal" placeholder="Пиво" autocomplete="off" aria-label="Цена пива"></label>
            <select class="sel" id="rateCur" aria-label="Валюта">${CUR.map((c) => `<option value="${c}" ${c === cur0 ? "selected" : ""}>${curSign(c)}</option>`).join("")}</select>
          </div>
          <button type="button" class="linkbtn" id="rateMore" aria-expanded="false">ещё: сеанс · будни/выходной · скидка до часа</button>
          <div class="thx-more" id="rateExtra" hidden>
            <div class="seg" id="rateWeekend" role="radiogroup" aria-label="Будни или выходной">
              <button type="button" data-w="" aria-pressed="true">Любой день</button><button type="button" data-w="0" aria-pressed="false">Будни</button><button type="button" data-w="1" aria-pressed="false">Выходной</button>
            </div>
            <div class="thx-two">
              <label class="thx-inp"><svg class="ic" aria-hidden="true"><use href="#i-clock"/></svg><input id="rateDur" inputmode="numeric" placeholder="Сеанс, мин" autocomplete="off"></label>
              <label class="thx-inp"><span class="thx-lbl">Скидка до</span><input id="rateBefore" type="time" aria-label="Скидка до часа"></label>
            </div>
          </div>
        </div>
        <div class="thx-sec"><span>Отзыв <small id="rateRvNote">по желанию</small></span>
          <textarea id="rateText" class="inp" rows="3" placeholder="Какой пар, веники, купель, кухня…" aria-label="Отзыв"></textarea></div>
        ${visit ? `<div class="thx-photos"><span class="rate-photos" id="ratePhotoPrev"></span>
          <label class="btn rate-add"><input type="file" id="ratePhotos" accept="image/*" multiple hidden>${icon("plus")}<span>Фото</span></label></div>` : ""}
        <div class="rate-foot"><button class="cta" type="submit">${icon("check")}<span>Готово</span></button></div>
      </form>`;
    // уже писал отзыв об этой бане (02.11) — он в поле, сохранение его правит, а не добавляет второй
    let myRv = null;
    D.myReview?.(f.bath, f.player).then((r) => {
      if (!r || $("#rateText", body).value) return;
      myRv = r; $("#rateText", body).value = r.text || ""; $("#rateRvNote", body).textContent = "твой прошлый — можно поправить";
    }).catch(() => {});
    lastPrice().then((p) => { if (p) $("#ratePrev", body).textContent = `по желанию · в прошлый раз ${money(p.price)} ${curSign(p.currency)}`; else $("#ratePrev", body).textContent = "по желанию"; });
    // поход ещё на проверке (08.11) — оценка и отзыв ждут «засчитано», до этого их видит только автор
    const done = () => say("Готово, спасибо!", f.held ? `Оценка и отзыв появятся у бани <b class="nw">«${esc(f.name)}»</b>, когда Комиссия засчитает поход.`
      : `Оценка уже в рейтинге бани <b class="nw">«${esc(f.name)}»</b>.`, true, [`./#bath=${f.bath}`, "Открыть баню на карте"]);
    $("#rateMore", body).onclick = (e) => { const x = $("#rateExtra", body); x.hidden = !x.hidden; e.currentTarget.setAttribute("aria-expanded", String(!x.hidden)); };
    $$("#rateWeekend [data-w]", body).forEach((b) => (b.onclick = () => {
      weekend = b.dataset.w === "" ? null : b.dataset.w === "1";
      $$("#rateWeekend [data-w]", body).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    if (visit) $("#ratePhotos", body).onchange = (e) => {
      for (const file of e.target.files) { photos.push(file); $("#ratePhotoPrev", body).insertAdjacentHTML("beforeend", `<img alt="" src="${URL.createObjectURL(file)}">`); }
    };
    $("#rateRv", body).onsubmit = async (e) => {
      e.preventDefault();
      const btn = $("#rateRv button[type=submit]", body);
      const text = $("#rateText", body).value.trim(), cur = $("#rateCur", body).value;
      const price = num($("#ratePrice", body).value), beer = num($("#rateBeer", body).value), dur = num($("#rateDur", body).value);
      const before = $("#rateBefore", body).value || null;
      if ((price !== null && !(price > 0)) || (beer !== null && !(beer > 0))) return toast("Цены — числом, например 1500 или 14,5");
      if (dur !== null && !(dur > 0 && Number.isInteger(dur))) return toast("Сеанс — в минутах, целым числом");
      const round = (n) => (cur === "RUB" ? Math.round(n) : Math.round(n * 100) / 100);
      btn.disabled = true;
      try {
        if (price) await D.submitBathPrice(f.bath, round(price), cur, dur || null, weekend, before);
        if (beer) await D.submitBeerPrice(f.bath, round(beer), cur);
        const stars = Math.min(5, Math.max(1, Math.round(overall)));
        // на проверке прежний (уже видный всем) отзыв не правим — новый текст ждёт решения Комиссии отдельным отзывом
        const own = myRv && (!f.held || myRv.visit_id === visit);
        if (own && text && text !== myRv.text) await D.updateReview(myRv.id, stars, text);
        else if (text && (!myRv || text !== myRv.text)) await D.addReview(f.bath, f.player, stars, text, f.held ? visit : null);
        if (photos.length) {
          const items = [];
          for (const p of photos.slice(0, 10)) { try { items.push({ big: await shrink(p, 1600), small: await shrink(p, 400) }); } catch { /* не открылось */ } }
          if (items.length) { toast(`📷 Загружаю фото: 0 из ${items.length}…`); await D.uploadPhotos(visit, items, (i) => toast(`📷 Загружаю фото: ${i} из ${items.length}…`)); }
        }
      } catch (err) { btn.disabled = false; return toast("Не сохранилось: " + err.message); }
      buzz(); done();
    };
  }
})();
