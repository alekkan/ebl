/* Слой данных ЕБЛ. Боевой режим — Supabase (config.js задаёт адрес и публичный ключ),
   иначе витрина: выгрузка таблицы из data/*.json, походы и отзывы — в localStorage браузера. */
window.EBLData = (() => {
  const cfg = window.EBL_CONFIG || {};
  const live = !!(cfg.supabaseUrl && cfg.supabaseKey && window.supabase);
  const sb = live ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;
  const YEARS_HIST = [2023, 2024, 2025];
  const LINE_LABEL = { visit: "Поход в баню", public: "Общественная", company: "Компания", unique: "Уникальная",
    ultra: "Ультрауникальная", region: "Новый регион", country: "Новая страна", long: "Долгий поход" };

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("ebl:" + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ebl:" + k, JSON.stringify(v)); } catch {} },
  };
  // «2026-09-26T11:42» по Москве
  const mskLocal = (iso) => new Date(new Date(iso).getTime() + 3 * 3600e3).toISOString().slice(0, 16);
  const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };

  async function all(table, select, filter) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select(select).range(from, from + 999);
      if (filter) q = filter(q);
      const rows = check(await q);
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  // ---------- витрина ----------
  async function loadStatic() {
    const get = (f) => fetch("data/" + f, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [baths, standings, coords] = await Promise.all([get("baths.json"), get("standings.json"), get("coords.json")]);
    for (const b of baths) {
      const c = coords?.[b.id];
      if (c) [b.lat, b.lng, b.precision] = c;
    }
    const newBaths = store.get("newBaths", []);
    return {
      baths: [...baths, ...newBaths], standings, reviews: store.get("reviews", {}), visits: store.get("visits", []),
      players: standings.map((s) => s.name), me: null,
      commission: ["Витёк", "Леха"],   // в витрине — как в scripts/seed.py
    };
  }

  // ---------- боевой режим ----------
  async function whoami() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const acc = check(await sb.from("player_accounts").select("id, player_id, claimed_nick, tg_username, players(nick, is_commission)").eq("auth_user", session.user.id).maybeSingle());
    if (!acc) return { accountId: null, nick: null };
    return { accountId: acc.id, playerId: acc.player_id, nick: acc.players?.nick ?? null, isCommission: !!acc.players?.is_commission,
      claimedNick: acc.claimed_nick, tgUsername: acc.tg_username };
  }

  async function loadVisits(playersById) {
    const rows = check(await sb.from("visits")
      .select("id, bath_id, entered_at, posted_at, duration_min, status, created_by, reject_reason, tg_link, visit_players(player_id)")
      .order("posted_at", { ascending: false }).limit(300));
    const pts = await all("visit_points", "visit_id, nick, total, lines", (q) => q.in("visit_id", rows.map((r) => r.id)));
    const ptsBy = {};
    for (const p of pts) (ptsBy[p.visit_id] ||= {})[p.nick] = p;
    return rows.map((v) => {
      const author = playersById[v.created_by];
      const vp = v.visit_players.map((x) => ({ ...x, nick: playersById[x.player_id] }));
      const p = ptsBy[v.id]?.[author];
      return {
        id: v.id, bathId: v.bath_id, player: author, companions: vp.filter((x) => x.nick !== author).map((x) => x.nick),
        date: mskLocal(v.entered_at), posted: mskLocal(v.posted_at), dur: v.duration_min, status: v.status, reason: v.reject_reason,
        total: p ? +p.total : null, lines: p ? p.lines.map(([k, n]) => [LINE_LABEL[k] || k, n]) : [], tgLink: v.tg_link,
      };
    });
  }

  async function loadLive() {
    const [baths, counts, standings, reviews, players, me] = await Promise.all([
      all("baths", "id, name, type, country, region, lat, lng, precision, status, created_by"),
      all("bath_counts", "bath_id, year, nick, n"),
      all("standings", "*"),
      all("reviews", "bath_id, rating, text, created_at, players(nick)"),
      all("players", "id, nick, is_commission, photo_url"),
      whoami(),
    ]);
    const byId = new Map(baths.map((b) => [b.id, Object.assign(b, { v26: {}, hist: {}, histBy: {}, isNew: b.status === "pending" })]));
    for (const c of counts) {
      const b = byId.get(c.bath_id); if (!b) continue;
      if (c.year === 2026) b.v26[c.nick] = (b.v26[c.nick] || 0) + c.n;
      else if (YEARS_HIST.includes(c.year)) {
        b.hist[c.year] = (b.hist[c.year] || 0) + c.n;
        (b.histBy[c.year] ||= {})[c.nick] = (b.histBy[c.year][c.nick] || 0) + c.n;
      }
    }
    const rv = {};
    for (const r of reviews.sort((a, b) => b.created_at.localeCompare(a.created_at))) {
      (rv[r.bath_id] ||= []).push({ author: r.players?.nick ?? "участник", rate: r.rating, text: r.text, at: r.created_at });
    }
    const playersById = Object.fromEntries(players.map((p) => [p.id, p.nick]));
    const visits = me?.playerId ? await loadVisits(playersById) : [];
    return {
      baths,
      standings: standings.map((s) => ({ name: s.nick, total: +s.total, baths: s.baths, u: s.u, uu: s.uu, long: s.long, k: s.k, pub: s.pub, reg: s.reg,
        weekPts: s.week_pts, weekBaths: s.week_baths, updatedAt: s.updated_at })),
      reviews: rv, visits, players: players.map((p) => p.nick), playerIds: Object.fromEntries(players.map((p) => [p.nick, p.id])), me,
      commission: players.filter((p) => p.is_commission).map((p) => p.nick),
      photos: Object.fromEntries(players.filter((p) => p.photo_url).map((p) => [p.nick, p.photo_url])),
    };
  }

  let cache = null;
  const api = {
    live, sb, LINE_LABEL,
    async load() { cache = live ? await loadLive() : await loadStatic(); return cache; },

    // вход: данные Telegram Login Widget → edge-функция → сессия Supabase
    async login(tgUser) {
      const r = await fetch(cfg.supabaseUrl + "/functions/v1/tg-login", {
        method: "POST", headers: { "Content-Type": "application/json", apikey: cfg.supabaseKey }, body: JSON.stringify(tgUser),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Не получилось войти");
      check(await sb.auth.verifyOtp({ token_hash: body.token_hash, type: "magiclink" }));
      return body;
    },
    async logout() { await sb.auth.signOut(); },
    async claim(nick) { check(await sb.rpc("claim_nick", { p_nick: nick })); },

    async submitReview(bathId, me, rate, text) {
      if (!live) {
        (cache.reviews[bathId] ||= []).unshift({ author: me, rate, text, at: Date.now() });
        store.set("reviews", cache.reviews); return;
      }
      check(await sb.from("reviews").upsert({ bath_id: bathId, player_id: cache.me.playerId, rating: rate, text }, { onConflict: "bath_id,player_id" }));
    },

    // поход: v = { bathId | newBath, bathType (тип не размеченной бани со слов автора), date (МСК), dur, companions, lines, total, player, week }
    async submitVisit(v) {
      if (!live) {
        if (v.newBath) {
          const nb = { id: 100000 + store.get("newBaths", []).length + 1, ...v.newBath, v26: {}, hist: {}, isNew: true };
          store.set("newBaths", [...store.get("newBaths", []), nb]); v.bathId = nb.id; v.createdBath = nb;
        }
        const rec = { id: Date.now(), player: v.player, companions: v.companions, bathId: v.bathId, date: v.date, week: v.week, dur: v.dur,
          lines: v.lines, total: v.total, status: "pending", at: Date.now() };
        cache.visits.unshift(rec); store.set("visits", cache.visits);
        return rec;
      }
      const me = cache.me.playerId;
      let bathId = v.bathId;
      if (v.newBath) {
        const nb = check(await sb.from("baths").insert({ ...v.newBath, status: "pending", created_by: me }).select().single());
        bathId = nb.id; v.createdBath = { ...nb, v26: {}, hist: {}, histBy: {}, isNew: true };
      }
      // тип — до похода: уведомление Комиссии (триггер на новый поход) уже покажет его
      if (v.bathType && !v.newBath) {
        check(await sb.rpc("suggest_bath_type", { p_bath: bathId, p_type: v.bathType }));
      }
      const visit = check(await sb.from("visits").insert({ bath_id: bathId, entered_at: v.date + ":00+03:00", duration_min: v.dur, created_by: me }).select().single());
      const rows = [me, ...v.companions.map((nick) => cache.playerIds[nick])].map((id) => ({ visit_id: visit.id, player_id: id }));
      check(await sb.from("visit_players").insert(rows));
      v.bathId = bathId;
      return { id: visit.id };
    },

    async moderate(visitId, status, reason) {
      if (!live) {
        const v = cache.visits.find((x) => x.id === visitId); v.status = status; store.set("visits", cache.visits); return;
      }
      check(await sb.from("visits").update({ status, moderated_by: cache.me.playerId, moderated_at: new Date().toISOString(), reject_reason: reason || null }).eq("id", visitId));
    },
    // Комиссия правит заявку: поля похода и состав компании people = [ник, …] (вместе с автором)
    async updateVisit(visitId, patch, people) {
      if (!live) {
        const v = cache.visits.find((x) => x.id === visitId);
        Object.assign(v, { bathId: patch.bath_id, date: patch.entered_at.slice(0, 16), dur: patch.duration_min, status: patch.status,
          companions: people.filter((n) => n !== v.player) });
        store.set("visits", cache.visits); return;
      }
      check(await sb.from("visits").update(patch).eq("id", visitId));
      const have = new Set(check(await sb.from("visit_players").select("player_id").eq("visit_id", visitId)).map((c) => c.player_id));
      const want = new Set(people.map((n) => cache.playerIds[n]));
      const gone = [...have].filter((id) => !want.has(id));
      if (gone.length) check(await sb.from("visit_players").delete().eq("visit_id", visitId).in("player_id", gone));
      const fresh = [...want].filter((id) => !have.has(id)).map((id) => ({ visit_id: visitId, player_id: id }));
      if (fresh.length) check(await sb.from("visit_players").insert(fresh));
    },
    async recompute() {
      if (!live) return;
      const r = await fetch(cfg.supabaseUrl + "/functions/v1/recompute", { method: "POST", headers: { apikey: cfg.supabaseKey } });
      if (!r.ok) throw new Error("Таблица не пересчиталась");
    },

    // Комиссия: заявки «это я» и новые бани
    async pendingAccounts() {
      if (!live) return [];
      return check(await sb.from("player_accounts").select("id, tg_username, tg_name, claimed_nick").is("player_id", null).not("claimed_nick", "is", null));
    },
    async linkAccount(accountId, nick) {
      check(await sb.from("player_accounts").update({ player_id: cache.playerIds[nick], claimed_nick: null }).eq("id", accountId));
    },
    // точка бани по ссылке на карту или координатам — разбирает edge-функция (короткие ссылки раскрываются там)
    async findLocation(input) { return api.setBathLocation(null, input); },
    async setBathLocation(bathId, input) {
      const { data: { session } } = await sb.auth.getSession();
      const r = await fetch(cfg.supabaseUrl + "/functions/v1/bath-location", {
        method: "POST", headers: { "Content-Type": "application/json", apikey: cfg.supabaseKey, Authorization: "Bearer " + (session?.access_token ?? "") },
        body: JSON.stringify({ bath_id: bathId, input }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Точка не сохранилась");
      return body;
    },
    async moderateBath(bathId, patch) { check(await sb.from("baths").update(patch).eq("id", bathId)); },
    store,
  };
  return api;
})();
