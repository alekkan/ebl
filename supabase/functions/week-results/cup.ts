// Кубок в чате лиги: по одному сообщению на итоги каждого тура — когда Комиссия их приняла
// (cup_accept на сайте). Источник — cup_state(): туры, команды, история принятых итогов. Что уже объявлено — cup_posts.
// Итоги отменили и приняли заново (другой жребий, поправили очки) — выходит «Уточнение», а не тишина со старым составом.
import { TELEGRAM_API } from "../_shared/hosts.ts";
import { askKb, askText, roundText } from "../_shared/cup-text.ts";
export { roundText };

// deno-lint-ignore no-explicit-any
type Any = any;

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

// Тур сыгран, итоги не приняты (24.11) — предложение каждому участнику Комиссии в личку, с кнопками (их разбирает tg-bot).
// Одно сообщение на человека: очки изменились — правим его, а не шлём новое. Приняли на сайте — снимаем кнопки.
// deno-lint-ignore no-explicit-any
export async function cupAsks(sb: any, token: string, dry = false) {
  const tg = (method: string, body: Any) => fetch(`${TELEGRAM_API}/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parse_mode: "HTML", disable_web_page_preview: true, ...body }) }).then((x) => x.json()).catch(() => ({ ok: false }));
  const [{ data: state }, { data: asks }] = await Promise.all([sb.rpc("cup_state"), sb.from("cup_asks").select("round, text, messages")]);
  const accepted = new Set((state?.history ?? []).map((h: Any) => h.round)), out: Any[] = [];
  if (!dry) for (const a of (asks ?? []).filter((x: Any) => accepted.has(x.round))) {
    for (const m of a.messages ?? []) await tg("editMessageText", { chat_id: m.chat, message_id: m.msg, text: `${a.text}\n\n✅ Итоги тура ${a.round} приняты.`, reply_markup: { inline_keyboard: [] } });
    await sb.from("cup_asks").delete().eq("round", a.round);
  }
  // первый непринятый тур: сыгран и с командами — значит, ждёт Комиссию
  const r = (state?.rounds ?? []).find((x: Any) => !accepted.has(x.n));
  if (!r || Date.parse(r.ends_at) > Date.now() || !(state.teams ?? []).some((t: Any) => t.round === r.n)) return out;
  const { data: p, error } = await sb.rpc("cup_propose_by", { p_round: r.n, p_redraw: false, p_by: null });
  if (error) return [{ round: r.n, error: error.message }];
  const text = askText(p, state), old = (asks ?? []).find((a: Any) => a.round === r.n);
  if (dry) return [{ round: r.n, text, fresh: !old }];
  if (old) {
    if (old.text === text) return out;
    await sb.from("cup_asks").update({ text }).eq("round", r.n);
    for (const m of old.messages ?? []) await tg("editMessageText", { chat_id: m.chat, message_id: m.msg, text, reply_markup: { inline_keyboard: askKb(p) } });
    return [{ round: r.n, updated: true }];
  }
  // вставкой забираем рассылку себе — параллельный вызов второй раз не напишет
  const claim = await sb.from("cup_asks").insert({ round: r.n, text }).select("round").maybeSingle();
  if (!claim.data) return out;
  const { data: who } = await sb.from("player_accounts").select("tg_id, players!inner(is_commission)").eq("players.is_commission", true).not("tg_id", "is", null);
  const messages: Any[] = [];
  for (const chat of [...new Set((who ?? []).map((a: Any) => a.tg_id))]) {
    const m = await tg("sendMessage", { chat_id: chat, text, reply_markup: { inline_keyboard: askKb(p) } });
    if (m.ok) messages.push({ chat, msg: m.result?.message_id });
  }
  if (!messages.length) { await sb.from("cup_asks").delete().eq("round", r.n); return [{ round: r.n, error: "не отправилось" }]; }
  await sb.from("cup_asks").update({ messages }).eq("round", r.n);
  return [{ round: r.n, asked: messages.length }];
}
