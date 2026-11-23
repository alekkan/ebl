// Четвёртый кубок ЕБЛ: очки тура по регламенту кубка (docs/cup.md).
// Считается поверх готовой разбивки чемпионата и чемпионат не трогает: отдельная таблица cup_points.
import { msk, dayKey } from "./scoring.js";

/**
 * @param {object} p
 * @param {{n,starts_at,ends_at}[]} p.rounds  тур — по времени поста, [starts_at, ends_at)
 * @param {{id,round,players:string[]}[]} p.teams  составы на каждый тур свои
 * @param {Map<number,{type,cup_ok}>} p.baths  в зачёт кубка — общественные и отмеченные Комиссией (термы, п. 22)
 * @param {{id,bath_id,entered_at,posted_at}[]} p.visits  только status = ok
 * @param {object} p.breakdown  разбивка чемпионата: в кубок идёт только то, что засчитал чемпионат
 * @returns {{round,visit_id,nick,team_id,total,lines}[]}
 */
export function computeCup({ rounds, teams, baths, visits, breakdown }) {
  const counts = (id) => { const b = baths.get(id); return b?.type === "public" || !!b?.cup_ok; };
  const roundOf = (t) => rounds.find((r) => t >= new Date(r.starts_at).getTime() && t < new Date(r.ends_at).getTime())?.n ?? null;
  const teamOf = new Map();   // «тур|ник» → команда
  for (const t of teams) for (const nick of t.players) teamOf.set(t.round + "|" + nick, t.id);

  const entries = [];
  const sorted = visits
    .map((v) => ({ ...v, t: new Date(v.posted_at).getTime() }))
    .map((v) => ({ ...v, round: roundOf(v.t), day: dayKey(msk(v.entered_at)) }))
    .filter((v) => v.round != null && breakdown[v.id])
    .sort((a, b) => a.t - b.t || a.id - b.id);
  for (const v of sorted) {
    for (const [nick, champ] of Object.entries(breakdown[v.id])) entries.push({ v, nick, champ, team: teamOf.get(v.round + "|" + nick) });
  }
  // встреча команды: двое и больше из одной команды в одной зачётной бане в одни сутки
  const met = new Map();
  for (const e of entries) {
    if (!e.team || !counts(e.v.bath_id)) continue;
    const key = e.team + "|" + e.v.bath_id + "|" + e.v.day;
    if (!met.has(key)) met.set(key, new Set());
    met.get(key).add(e.nick);
  }

  const seen = new Map();   // ник → зачётные бани с начала кубка: уникальная между турами не обнуляется
  const out = [];
  for (const e of entries) {
    const isPublic = counts(e.v.bath_id);
    const mine = seen.get(e.nick) ?? seen.set(e.nick, new Set()).get(e.nick);
    const first = isPublic && !mine.has(e.v.bath_id);
    if (isPublic) mine.add(e.v.bath_id);
    if (!e.team) continue;   // в этом туре не играет (вылетел или не участник кубка)
    const lines = [];
    if (isPublic) {   // хуитнес, частная и баня без типа в кубке — ноль, пока Комиссия не отметит «в зачёт кубка»
      const has = (k) => e.champ.lines.some((l) => l[0] === k);
      lines.push(["visit", 1], ["public", 1]);
      if (first) lines.push(["unique", 1]);
      if (has("ultra")) lines.push(["ultra", 1]);
      if (has("long")) lines.push(["long", 1]);   // уже с учётом подтверждения Комиссии
      if (met.get(e.team + "|" + e.v.bath_id + "|" + e.v.day).size >= 2) lines.push(["team", 1]);
      const company = e.champ.lines.find((l) => l[0] === "company");   // компания — как в чемпионате (решение лиги 22.11): тот же бонус К/КК/ККК
      if (company) lines.push(["company", company[1]]);
    }
    out.push({ round: e.v.round, visit_id: e.v.id, nick: e.nick, team_id: e.team, total: lines.reduce((a, l) => a + l[1], 0), lines });
  }
  return out;
}
