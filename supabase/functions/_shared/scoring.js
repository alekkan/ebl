// Движок подсчёта очков ЕБЛ по регламенту четвёртого чемпионата (2026).
// Вход — «входящий остаток» из таблицы Комиссии (всё до cutoverWeek) и журнал подтверждённых походов.
// Выход — итоговая таблица и разбивка очков по каждому походу.

export const PLACE_PTS = [15, 12, 10, 8, 6, 4, 2, 1];

// Date, у которой UTC-поля показывают московское время
export const msk = (d) => new Date(new Date(d).getTime() + 3 * 3600e3);
const dayKey = (m) => m.toISOString().slice(0, 10);

// Неделя сезона по московскому времени (п. 6, 18): W1 — от 1 января до первого воскресенья,
// дальше пн–вс; после 22:59 МСК воскресенья — уже следующая неделя.
export function weekOf(date, season) {
  const m = msk(date);
  const d = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()));
  if (d.getUTCDay() === 0 && (m.getUTCHours() > 22 || (m.getUTCHours() === 22 && m.getUTCMinutes() > 59))) d.setUTCDate(d.getUTCDate() + 1);
  const jan1 = new Date(Date.UTC(season, 0, 1));
  const firstMon = new Date(jan1);
  firstMon.setUTCDate(1 + ((8 - jan1.getUTCDay()) % 7));
  if (d < firstMon) return 1;
  return Math.floor((d - firstMon) / 864e5 / 7) + (firstMon.getTime() === jan1.getTime() ? 1 : 2);
}

// Очки за места с делёжкой (п. 7): rows — [[ник, число бань]] по убыванию, только с банями > 0
export function placePoints(rows) {
  const out = {};
  for (let i = 0; i < rows.length;) {
    let j = i;
    while (j + 1 < rows.length && rows[j + 1][1] === rows[i][1]) j++;
    const pts = rows.slice(i, j + 1).map((_, k) => PLACE_PTS[i + k] ?? 0);
    const avg = Math.round((pts.reduce((a, x) => a + x, 0) / pts.length) * 10) / 10;
    for (let k = i; k <= j; k++) out[rows[k][0]] = avg;
    i = j + 1;
  }
  return out;
}

const companyPts = (n) => (n >= 9 ? 3 : n >= 6 ? 2 : n >= 3 ? 1 : 0);

// Ключ страны/региона для сравнения (п. 14): в таблице встречается и «Московская обл», и «Московская обл.»,
// а OpenStreetMap пишет «Кировская область», «Республика Татарстан» — это один и тот же регион
export function regionKey(s) {
  return ` ${String(s ?? "").toLowerCase().replace(/ё/g, "е").replace(/[.,«»"()]/g, " ")} `
    .replace(/ область /g, " обл ").replace(/ (республика|респ|город|г) /g, " ")
    .replace(/ автономный округ /g, " ао ").replace(/\s+/g, " ").trim();
}

/**
 * @param {object} p
 * @param {number} p.season
 * @param {number} p.cutoverWeek   первая неделя, которую считает портал
 * @param {Date}   p.now
 * @param {Map<number,{type,country,region}>} p.baths
 * @param {{bath_id,year,nick,n}[]} p.legacyVisits
 * @param {{nick,total,baths,u,uu,long,k,pub,reg,week_pts,week_baths}[]} p.legacyStandings
 * @param {{id,bath_id,entered_at,posted_at,duration_min,players:{nick}[]}[]} p.visits  только status = ok
 */
export function computeStandings({ season, cutoverWeek, now, baths, legacyVisits, legacyStandings, visits }) {
  const S = new Map();
  const row = (nick) => {
    if (!S.has(nick)) S.set(nick, { nick, total: 0, baths: 0, u: 0, uu: 0, long: 0, k: 0, pub: 0, reg: 0, week_pts: {}, week_baths: {} });
    return S.get(nick);
  };
  for (const l of legacyStandings) {
    Object.assign(row(l.nick), {
      total: +l.total, baths: l.baths, u: l.u, uu: l.uu, long: l.long, k: l.k, pub: l.pub, reg: l.reg,
      week_pts: { ...l.week_pts }, week_baths: { ...l.week_baths },
    });
  }

  // что у участника уже есть в сезоне (для уникальных, регионов, стран) и где лига вообще была (для ультрауникальных)
  const seen = new Map(), regions = new Map(), countries = new Map(), everVisited = new Set();
  const setOf = (m, nick) => (m.has(nick) ? m.get(nick) : m.set(nick, new Set()).get(nick));
  const remember = (nick, bathId) => {
    const b = baths.get(bathId);
    setOf(seen, nick).add(bathId);
    if (b?.region && b?.country) setOf(regions, nick).add(regionKey(b.country) + "/" + regionKey(b.region));
    if (b?.country) setOf(countries, nick).add(regionKey(b.country));
  };
  for (const lv of legacyVisits) {
    everVisited.add(lv.bath_id);
    if (lv.year === season) remember(lv.nick, lv.bath_id);
  }

  // журнал: только походы этого сезона начиная с cutoverWeek. Повтор бани в те же сутки (п. 5) движок сам не срезает:
  // бани часто кидают за прошлый день, и «те же сутки» по дате захода бывают мнимыми — Комиссия видит предупреждение
  // и решает сама; засчитала — очки идут (решение лиги 27.09.2026)
  const entries = [];
  const sorted = visits
    .map((v) => ({ ...v, week: weekOf(v.posted_at, season), day: dayKey(msk(v.entered_at)) }))
    .filter((v) => v.week >= cutoverWeek && msk(v.entered_at).getUTCFullYear() === season && v.duration_min >= 60)
    .sort((a, b) => new Date(a.entered_at) - new Date(b.entered_at) || a.id - b.id);
  for (const v of sorted) {
    for (const p of v.players) entries.push({ v, nick: p.nick });
  }
  // компания — все участники в этой бане в эти сутки (п. 11)
  const company = new Map();
  for (const e of entries) {
    const key = e.v.bath_id + "|" + e.v.day;
    setOf(company, key).add(e.nick);
  }
  // ультрауникальная — первый день, когда кто-то из лиги дошёл до бани, где с 2023 года никого не было (п. 13)
  const ultraDay = new Map();
  for (const e of entries) {
    if (!everVisited.has(e.v.bath_id) && !ultraDay.has(e.v.bath_id)) ultraDay.set(e.v.bath_id, e.v.day);
  }

  const breakdown = {};
  for (const e of entries) {
    const r = row(e.nick), b = baths.get(e.v.bath_id) || {}, lines = [];
    lines.push(["visit", 1]);
    if (b.type === "public") { lines.push(["public", 1]); r.pub += 1; }
    const kp = companyPts(company.get(e.v.bath_id + "|" + e.v.day).size);
    if (kp) { lines.push(["company", kp]); r.k += kp; }
    if (!setOf(seen, e.nick).has(e.v.bath_id)) { lines.push(["unique", 1]); r.u += 1; }
    if (ultraDay.get(e.v.bath_id) === e.v.day) { lines.push(["ultra", 1]); r.uu += 1; }
    if (b.region && b.country && !setOf(regions, e.nick).has(regionKey(b.country) + "/" + regionKey(b.region))) { lines.push(["region", 1]); r.reg += 1; }
    if (b.country && !setOf(countries, e.nick).has(regionKey(b.country))) { lines.push(["country", 1]); r.reg += 1; }
    if (e.v.duration_min > 150) { lines.push(["long", 1]); r.long += 1; }
    remember(e.nick, e.v.bath_id);
    const pts = lines.reduce((a, l) => a + l[1], 0);
    r.total += pts;
    r.baths += 1;
    r.week_baths[e.v.week] = (r.week_baths[e.v.week] || 0) + 1;
    (breakdown[e.v.id] ||= {})[e.nick] = { total: pts, lines };
  }
  for (const b of ultraDay.keys()) everVisited.add(b);

  // очки за места — только за закрытые недели (п. 7, 8)
  const current = weekOf(now, season);
  for (let w = cutoverWeek; w < current; w++) {
    const rows = [...S.values()].map((r) => [r.nick, r.week_baths[w] || 0]).filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]);
    if (!rows.length) continue;
    const pts = placePoints(rows);
    for (const [nick, p] of Object.entries(pts)) {
      const r = row(nick);
      r.week_pts[w] = p;
      r.total += p;
    }
  }
  for (const r of S.values()) r.total = Math.round(r.total * 100) / 100;
  return { standings: [...S.values()], breakdown, currentWeek: current };
}
