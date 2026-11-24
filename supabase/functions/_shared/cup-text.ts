// Тексты кубка для чата и для лички Комиссии — общие у week-results (рассылка по расписанию) и tg-bot (кнопки).
// deno-lint-ignore no-explicit-any
type Any = any;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const PATH: Record<string, string> = { champions: "Путь чемпионов", losers: "Путь ебланов" };
const names = (a: string[]) => a.map(esc).join(", ");

// срок тура по-московски: тур начинается в воскресенье в 23:00 — показываем с понедельника
function dates(r: Any) {
  const day = (t: number, month: boolean) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", ...(month ? { month: "long" } : {}), timeZone: "Europe/Moscow" });
  const from = new Date(r.starts_at).getTime() + 3600e3, to = new Date(r.ends_at).getTime();
  const sameMonth = day(from, true).split(" ")[1] === day(to, true).split(" ")[1];
  const till = new Date(to).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
  return `${day(from, !sameMonth)}–${day(to, true)}, посты до ${till} МСК`;
}

// места команд, составы следующего тура, кто куда пошёл — одинаково в итогах для чата и в предложении Комиссии
function body(h: Any, state: Any) {
  const out: string[] = [];
  let path = "";
  for (const t of h.results ?? []) {
    if (t.path !== path) { path = t.path; out.push("", `<i>${PATH[path] ?? path}</i>`); }
    out.push(`${t.place}. ${(t.players ?? []).map((p: Any) => `${esc(p.nick)} ${p.total}`).join(" · ")} — <b>${t.total}</b>${t.lot ? " · место по жребию" : ""}`);
  }
  const fate = (to: string) => (h.results ?? []).flatMap((t: Any) => (t.players ?? []).filter((p: Any) => p.to === to).map((p: Any) => p.nick));
  if (!(h.teams ?? []).length) {   // финал: дальше туров нет
    out.push("", `👑 <b>Кубок выиграли ${names(fate("winner"))}!</b>`);
    if (fate("second").length) out.push(`🥈 Второе место: ${names(fate("second"))}`);
  } else {
    const next = (state.rounds ?? []).find((r: Any) => r.n === h.round + 1);
    out.push("", `<b>${h.round + 1 === 5 ? "Финал" : `Тур ${h.round + 1}`}</b>${next ? ` · ${dates(next)}` : ""}`);
    path = "";
    // кто сошёл с пути чемпионов — представляем перед командами пути ебланов
    const fresh = (h.results ?? []).filter((t: Any) => t.path === "champions").flatMap((t: Any) => (t.players ?? []).filter((p: Any) => p.to === "losers").map((p: Any) => p.nick));
    for (const t of h.teams) {
      if (t.path !== path && t.path === "losers" && fresh.length && h.round + 1 < 5) out.push("", `👋 Поприветствуем новых ебланов: ${names(fresh)}`);
      if (t.path !== path && h.round + 1 < 5) { path = t.path; out.push(`<i>${PATH[path] ?? path}</i>${path === "losers" && h.draw ? " — по жребию" : ""}`); }
      out.push(`• ${names(t.players)}`);
    }
    if ((h.rest ?? []).length) out.push("", `Сразу в финал, тур ${h.round + 1} пропускают: ${names(h.rest)}`);
    if (fate("out").length) out.push("", `Покидают кубок: ${names(fate("out"))}`);
  }
  return out;
}

export function roundText(h: Any, state: Any, site: string, fix = false) {
  return [`🏆 <b>Кубок ЕБЛ · итоги тура ${h.round}</b>${fix ? " — уточнение" : ""}`, ...body(h, state), "", `Кубок: ${site}#cup`].join("\n").slice(0, 4096);
}

// предложение итогов тура — Комиссии в личку (24.11): принять или перетянуть жребий можно кнопками под сообщением
export function askText(p: Any, state: Any) {
  const out = [`🏆 <b>Кубок ЕБЛ · тур ${p.round} сыгран</b> — итоги на проверку`, ...body(p, state), ""];
  if (p.pending) out.push(`⚠️ На проверке ещё заявки этого тура: ${p.pending}. Сначала разбери их — очки изменятся, сообщение обновится.`);
  if (p.draw) out.push("Команды пути ебланов развёл жребий. Не устраивает — «Другой жребий».");
  if (p.lot) out.push("Равенство по всем показателям — места развёл жребий.");
  out.push((p.teams ?? []).length ? `«Принять» — откроется ${p.round + 1 === 5 ? "финал" : `тур ${p.round + 1}`}, итоги уйдут в чат лиги.` : "«Принять» — итоги кубка уйдут в чат лиги.");
  return out.join("\n").slice(0, 3900);
}
export const askKb = (p: Any) => [[{ text: "✅ Принять", callback_data: `cupy:${p.round}` }],
  ...(p.draw || p.lot ? [[{ text: "🎲 Другой жребий", callback_data: `cupr:${p.round}` }]] : [])];

