// Тексты кубка для чата и для лички Комиссии — общие у week-results (рассылка по расписанию) и tg-bot (кнопки).
// deno-lint-ignore no-explicit-any
type Any = any;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const PATH: Record<string, string> = { champions: "Путь чемпионов", losers: "Путь ебланов" };
const names = (a: string[]) => a.map(esc).join(", ");
// «А, Б и В» — для шуток в чате
const and = (a: string[]) => a.length < 2 ? names(a) : `${names(a.slice(0, -1))} и ${esc(a[a.length - 1])}`;

// срок тура по-московски: тур начинается в воскресенье в 23:00 — показываем с понедельника
function dates(r: Any) {
  const day = (t: number, month: boolean) => new Date(t).toLocaleDateString("ru-RU", { day: "numeric", ...(month ? { month: "long" } : {}), timeZone: "Europe/Moscow" });
  const from = new Date(r.starts_at).getTime() + 3600e3, to = new Date(r.ends_at).getTime();
  const sameMonth = day(from, true).split(" ")[1] === day(to, true).split(" ")[1];
  const till = new Date(to).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });
  return `${day(from, !sameMonth)}–${day(to, true)}, посты до ${till} МСК`;
}

// места команд, составы следующего тура, кто куда пошёл — одинаково в итогах для чата и в предложении Комиссии
// chat — версия для чата лиги (28.11): шутки про каждую команду, слепой жребий; Комиссии в личку — сухо, как было
function body(h: Any, state: Any, chat = false) {
  const out: string[] = [];
  let path = "";
  for (const t of h.results ?? []) {
    if (t.path !== path) { path = t.path; out.push("", `<i>${PATH[path] ?? path}</i>`); }
    out.push(`${t.place}. ${(t.players ?? []).map((p: Any) => `${esc(p.nick)} ${p.total}`).join(" · ")} — <b>${t.total}</b>${t.lot ? " · место по жребию" : ""}`);
  }
  const fate = (to: string) => (h.results ?? []).flatMap((t: Any) => (t.players ?? []).filter((p: Any) => p.to === to).map((p: Any) => p.nick));
  const said = new Set<string>();
  if (chat) {
    const q = quips(h, said);
    if (q.length) out.push("", ...q);
  }
  if (!(h.teams ?? []).length) {   // финал: дальше туров нет
    if (said.size) return out;
    out.push("", `👑 <b>Кубок выиграли ${names(fate("winner"))}!</b>`);
    if (fate("second").length) out.push(`🥈 Второе место: ${names(fate("second"))}`);
  } else {
    const next = (state.rounds ?? []).find((r: Any) => r.n === h.round + 1);
    out.push("", `<b>${h.round + 1 === 5 ? "Финал" : `Тур ${h.round + 1}`}</b>${next ? ` · ${dates(next)}` : ""}`);
    path = "";
    // кто сошёл с пути чемпионов — представляем перед командами пути ебланов
    const fresh = (h.results ?? []).filter((t: Any) => t.path === "champions").flatMap((t: Any) => (t.players ?? []).filter((p: Any) => p.to === "losers").map((p: Any) => p.nick));
    for (const t of h.teams) {
      if (t.path !== path && t.path === "losers" && fresh.length && h.round + 1 < 5) out.push("", `👋 Поприветствуем наших ебланов: ${names(fresh)}`);
      if (t.path !== path && h.round + 1 < 5) {
        path = t.path;
        const draw = path === "losers" && h.draw ? (chat ? " — слепой жребий, пар больше не выбирают:" : " — по жребию") : "";
        out.push(`<i>${PATH[path] ?? path}</i>${draw}`);
      }
      out.push(`• ${names(t.players)}`);
    }
    if (chat && h.draw && (h.teams ?? []).some((t: Any) => t.path === "losers")) out.push("Ебланы, не грустите: из вас тоже выйдет финалист 🏆");
    // кого шутки уже назвали — второй раз сухой строкой не повторяем
    const rest = (h.rest ?? []).filter((n: string) => !said.has(n)), gone = fate("out").filter((n) => !said.has(n));
    if (rest.length) out.push("", `Сразу в финал, тур ${h.round + 1} пропускают: ${names(rest)}`);
    if (gone.length) out.push("", `Покидают кубок: ${names(gone)}`);
  }
  return out;
}

export function roundText(h: Any, state: Any, site: string, fix = false) {
  return [`🏆 <b>Кубок ЕБЛ · итоги тура ${h.round}</b>${fix ? " — уточнение" : ""}`, ...body(h, state, true), "", `Кубок: ${site}#cup`].join("\n").slice(0, 4096);
}

// Шутки к итогам тура в чате лиги (28.11, тексты утвердил Женёк В): строка на команду — кто дальше, кто к ебланам, кто домой.
// Разбор идёт по судьбам участников (`to`) и составам следующего тура, а не по номеру места: так и жребий, и равенства —
// всё, что решила система. Кого назвали — в `said`, чтобы ниже не повторять сухой строкой. Не узнали случай — команду пропускаем.
function quips(h: Any, said: Set<string>) {
  const R = h.round, res: Any[] = h.results ?? [], teams: Any[] = h.teams ?? [], out: string[] = [];
  const nicks = (t: Any): string[] => (t.players ?? []).map((p: Any) => p.nick);
  const by = (t: Any, f: (to: string) => boolean): string[] => (t.players ?? []).filter((p: Any) => f(p.to)).map((p: Any) => p.nick);
  const next = (nick: string): string[] => teams.find((t) => (t.players ?? []).includes(nick))?.players ?? [];
  const from = (nick: string) => res.find((t) => nicks(t).includes(nick))?.place;
  const mark = (a: string[]) => a.forEach((n) => said.add(n));
  let alt = 0, path = "";
  const turn = (a: string[]) => a[alt++ % a.length];

  if (!teams.length) {   // финал
    const w = res.find((t) => by(t, (to) => to === "winner").length), s = res.find((t) => by(t, (to) => to === "second").length);
    if (!w) return out;
    mark(nicks(w));
    if (w.path === "losers") out.push(`👑 <b>Кубок выиграли ебланы!</b> ${and(nicks(w))} прошли весь путь снизу — справедливость существует.`);
    else out.push(`👑 <b>Кубок выиграли ${and(nicks(w))}!</b> Четвёртый кубок ЕБЛ ваш — пиво за счёт проигравших (это не по регламенту, но мы верим).`);
    if (s) {
      mark(nicks(s));
      out.push(s.path === "losers" ? `🥈 ${and(nicks(s))} — второе место. Пройти путь ебланов до финала — уже легенда.`
        : `🥈 ${and(nicks(s))} — второе место. Отдыхали в туре 4, видимо, слишком хорошо.`);
    }
    return out;
  }
  if (R === 4) {   // три команды ебланов: одна в финал, остальные домой
    const fin = res.flatMap((t) => by(t, (to) => to === "final")), gone = res.flatMap((t) => by(t, (to) => to === "out"));
    if (fin.length) out.push(`🏆 ${and(fin)} — лучшие из ебланов, выходят в финал! Путь ебланов пройден, теперь вы просто финалисты.`);
    if (gone.length) out.push(`🚪 ${and(gone)} — полные ебланы, покидают кубок. Спасибо за пар — в чемпионате вас ещё ждут.`);
    mark([...fin, ...gone]);
    return out;
  }
  for (const t of res) {
    const all = nicks(t), stay = by(t, (to) => to === t.path), fin = by(t, (to) => to === "final");
    const down = by(t, (to) => to === "losers" && t.path === "champions"), gone = by(t, (to) => to === "out");
    const pre = R === 3 && t.path === "champions" ? "" : `Команда ${t.place}: `;
    let line = "";
    if (fin.length === all.length) line = `👑 ${and(all)} выходят в финал! Тур ${R + 1} отдыхают — пиво, веники, разминка.`;
    else if (stay.length === all.length && next(all[0]).length === all.length && all.every((n) => next(all[0]).includes(n))) {
      line = t.path === "losers" ? `🥇 ${pre}${and(all)} — лучшие среди ебланов, идут дальше целиком. Еблан еблану брат.`
        : R === 1 ? `🥇 ${pre}${and(all)} — единственные, кто вышел из парилки тем же составом, каким зашёл. Поздравляем, тур 2 — целиком!`
        : `🥇 ${pre}${and(all)} — снова целиком. Это уже не везение, это пар в крови.`;
    } else if (down.length === all.length) {
      line = R === 1 ? `🫠 ${pre}${and(all)} переходят на путь ебланов в полном составе. Сплочённость — тоже результат.`
        : `🫠 ${pre}${and(all)} — к ебланам всей командой. Один тур отделял вас от финала, теперь отделяет целый путь ебланов. Выйдет даже дольше.`;
    } else if (gone.length === all.length || (t.path === "losers" && stay.length === 1 && gone.length === all.length - 1)) {
      line = `🚪 ${pre}${and(gone)} — полные ебланы, покидают кубок. Веники сдать на выходе, спасибо за пар.`;
      mark(gone);
    } else if (stay.length && stay.length === all.length - 1 && (down.length || gone.length)) {
      // двое дальше, один вниз — и к оставшимся приходит лучший из команды ниже
      const left = [...down, ...gone], comer = next(stay[0]).filter((n) => !all.includes(n));
      const src = comer.length ? from(comer[0]) : undefined;
      if (t.path === "losers") {
        line = `🔁 ${pre}${and(stay)} остаются, ${and(left)} ${left.length > 1 ? "покидают кубок как полные ебланы" : "покидает кубок как полный еблан"}.`;
        if (comer.length) line += ` Вместо него — ${and(comer)} из ${src}-й, единственный, кто не утонул.`;
      } else {
        line = `🔁 ${pre}${and(stay)} идут дальше, а ${and(left)} — к ебланам.`;
        if (comer.length) line += " " + turn([`Парни, не ссать: вместо еблана к вам переходит нормальный участник — ${and(comer)} из ${src}-й команды.`,
          `Вместо него — ${and(comer)} из ${src}-й, который в одиночку вытащил себя за веник.`]);
      }
      mark(gone);
    } else if (stay.length === 1 && down.length === all.length - 1) {
      // один наверх, двое к ебланам: после тура 1 — на жребий, после тура 2 — командой с выбывшим сверху
      const mates = next(down[0]).filter((n) => !all.includes(n));
      if (R === 1 || !mates.length) line = turn([`🪣 ${pre}${esc(stay[0])} — один за всех, идёт дальше, а ${and(down)} — к ебланам.`,
        `🪣 ${pre}${esc(stay[0])} спасся и идёт дальше, а ${and(down)} — к ебланам.`]);
      else line = `🫠 ${pre}${esc(stay[0])} ушёл наверх, а ${and(down)} вместе с ${and(mates)} из ${from(mates[0])}-й — новая команда пути ебланов, прямо в таком составе. Знакомьтесь, вам вместе ещё париться.`;
    }
    if (!line) continue;
    if (R > 1 && t.path !== path) { path = t.path; out.push(...(out.length ? [""] : []), `<i>${PATH[path] ?? path}</i>`); }
    out.push(line);
  }
  return out;
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

