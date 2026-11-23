// Кубок в чате лиги: по одному сообщению на итоги каждого тура — когда Комиссия их приняла
// (cup_accept на сайте). Источник — cup_state(): туры, команды, история принятых итогов. Что уже объявлено — cup_posts.
// Итоги отменили и приняли заново (другой жребий, поправили очки) — выходит «Уточнение», а не тишина со старым составом.
import { TELEGRAM_API } from "../_shared/hosts.ts";

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

export function roundText(h: Any, state: Any, site: string, fix = false) {
  const out: string[] = [`🏆 <b>Кубок ЕБЛ · итоги тура ${h.round}</b>${fix ? " — уточнение" : ""}`];
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
  out.push("", `Кубок: ${site}#cup`);
  return out.join("\n").slice(0, 4096);
}

// что объявить сейчас: принятые итоги, о которых чат ещё не знает. Старт кубка объявлен 22.11 (в cup_posts — тур 0)
export function cupDue(state: Any, posts: Any[]) {
  const posted = new Map(posts.map((p) => [p.round, p])), due: { round: number; accepted_at: string; fix: boolean; h: Any }[] = [];
  for (const h of state?.history ?? []) {
    const p = posted.get(h.round);
    if (!p || Date.parse(p.accepted_at) !== Date.parse(h.accepted_at)) due.push({ round: h.round, accepted_at: h.accepted_at, fix: !!p, h });
  }
  return due;
}

// deno-lint-ignore no-explicit-any
export async function cupPosts(sb: any, chat: number, token: string, site: string, dry = false) {
  const [{ data: state }, { data: posts }] = await Promise.all([sb.rpc("cup_state"), sb.from("cup_posts").select("round, accepted_at")]);
  const due = cupDue(state, posts ?? []);
  const text = (d: Any) => roundText(d.h, state, site, d.fix);
  if (dry) return due.map((d) => ({ round: d.round, fix: d.fix, text: text(d) }));
  if (!chat) return [];
  const done = [];
  for (const d of due) {
    // забираем объявление себе: вставкой (первое) или правкой отметки (уточнение) — параллельный вызов второе не пошлёт
    const old = (posts ?? []).find((p: Any) => p.round === d.round)?.accepted_at ?? null;
    const claim = d.fix
      ? await sb.from("cup_posts").update({ accepted_at: d.accepted_at, posted_at: new Date().toISOString() }).eq("round", d.round).eq("accepted_at", old).select("round").maybeSingle()
      : await sb.from("cup_posts").insert({ round: d.round, accepted_at: d.accepted_at, chat_id: chat }).select("round").maybeSingle();
    if (!claim.data) continue;
    const r = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: text(d), parse_mode: "HTML", disable_web_page_preview: true }) }).then((x) => x.json()).catch(() => ({ ok: false }));
    if (!r.ok) {   // не отправилось — отдаём обратно, следующий вызов повторит
      if (d.fix) await sb.from("cup_posts").update({ accepted_at: old }).eq("round", d.round);
      else await sb.from("cup_posts").delete().eq("round", d.round);
      done.push({ round: d.round, error: r.description ?? "не отправилось" });
      continue;
    }
    await sb.from("cup_posts").update({ message_id: r.result?.message_id ?? null, chat_id: chat }).eq("round", d.round);
    done.push({ round: d.round, posted: true, fix: d.fix });
  }
  return done;
}
