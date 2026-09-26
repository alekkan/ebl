// Telegram-бот ЕБЛ (@eblsu_bot), вебхук.
//
// В общем чате: участник отмечает бота и пишет как есть — «@eblsu_bot Сандуны 3ч с Деном и @shurik».
// Бот отвечает карточкой: что понял, чего не хватает; уточняет баню (в т.ч. новая ли она — УУ), время, компанию.
// Пост в группе — документ похода (п. 5 регламента), его время определяет неделю (п. 6).
// После «В Комиссию»: на посте 👀, Комиссии в личку — поход с кнопками; после решения — 👍 или 💩 и итог в карточке.
// Через 2,5 часа после захода, если длительность не указана, бот спрашивает «Долгая была?» (п. 15, на доверии — без фото).
// В личке с ботом работает то же самое, только без отметки.
//
// Разовая настройка вебхука и команд: GET ?setup=<TELEGRAM_WEBHOOK_SECRET>. Проверка «Долгая была?»: ?tick=1 (pg_cron).
import { createClient } from "npm:@supabase/supabase-js@2";
import { hasLocationHint, locate, looksLikeAddress, parseLocation } from "../_shared/geo.ts";
import { matchPlace, reversePlace } from "../_shared/place.ts";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const BASE = Deno.env.get("SUPABASE_URL")!;
const SITE = Deno.env.get("SITE_URL") ?? "https://alekkan.github.io/ebl/";
const BOT = (Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "eblsu_bot").toLowerCase();
const LONG = 150; // минут — дольше этого поход долгий
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// deno-lint-ignore no-explicit-any
type Any = any;

// ---------- Telegram ----------
const tg = (method: string, body: Record<string, unknown>) =>
  fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const btn = (text: string, data: string) => ({ text, callback_data: data });
const LONG_KB = (vid: number) => [[btn("🔥 Да, долгая", `yl:${vid}`), btn("Нет, обычная", `nl:${vid}`)]];
const send = (chat: number, text: string, kb?: Any[][], replyTo?: number) => tg("sendMessage", {
  chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true,
  ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
  ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
});
const edit = (chat: number, msg: number, text: string, kb?: Any[][]) => tg("editMessageText", {
  chat_id: chat, message_id: msg, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: { inline_keyboard: kb ?? [] },
});
const react = (chat: number, msg: number, emoji: string) =>
  tg("setMessageReaction", { chat_id: chat, message_id: msg, reaction: [{ type: "emoji", emoji }] });
const answer = (id: string, text?: string, alert = false) => tg("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });
const postLink = (chat: Any, msg: number) =>
  chat.username ? `https://t.me/${chat.username}/${msg}` : String(chat.id).startsWith("-100") ? `https://t.me/c/${String(chat.id).slice(4)}/${msg}` : null;

// по регламенту важно одно: долгий поход (больше 150 минут) или обычный
const TYPE_RU: Record<string, string> = { public: "Общественная", spa: "Хуитнес", private: "Частная" };
const TYPE_BTN: Record<string, string> = { public: "🏛 Общественная", spa: "🏋️ Хуитнес", private: "🪵 Частная" };
const durLabel = (m: number | null) => (m == null ? "от часа" : m > 150 ? "🔥 долгая, больше 2,5 ч" : "обычная, до 2,5 ч");

// ---------- справочники ----------
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
async function league() {
  const [{ data: players }, { data: accounts }] = await Promise.all([
    sb.from("players").select("id, nick, is_commission"),
    sb.from("player_accounts").select("player_id, tg_id, tg_username").not("player_id", "is", null),
  ]);
  return { players: players ?? [], accounts: accounts ?? [] };
}
async function whoIs(tgId: number) {
  const { data } = await sb.from("player_accounts").select("player_id, claimed_nick, players(id, nick, is_commission)").eq("tg_id", tgId).maybeSingle();
  return data;
}
const getState = async (tgId: number) => ((await sb.from("bot_sessions").select("state").eq("tg_id", tgId).maybeSingle()).data?.state ?? null) as Any;
const setState = (tgId: number, state: Any) => sb.from("bot_sessions").upsert({ tg_id: tgId, state: { ...state, ts: Date.now() }, updated_at: new Date().toISOString() });
const DRAFT_TTL = 6 * 3600e3; // черновик старше 6 часов не подхватываем — новый пост начинает новый
const clearState = (tgId: number) => sb.from("bot_sessions").delete().eq("tg_id", tgId);

// ---------- разбор свободного текста ----------
const STOP = new Set(("был была были было сходил сходила сходили зашел зашли зашёл пошли парился парились попарились " +
  "в во на с со и а у к по за из от до мы я ты он сегодня вчера утром днем днём вечером ночью час часа часов ч мин минут минуты " +
  "баня бане бани баню фото фотка отметка отметки уу ультра ультрауникальная ультрауникальную новая новую новой компанией один одни " +
  "частная частной частную общественная общественной общественную хуитнес хуитнесе фитнес фитнесе спа " +
  "мной мною нами вместе тоже ещё еще всё все").split(" "));
// слова, по которым одним баню не опознать — в поиске «хотя бы одно слово» не участвуют
const GENERIC = new Set("банька баньку баньке банный банные сауна сауну сауне спа spa sauna отель отеле hotel частная частной парная комплекс термы".split(" "));
// «Дружбе» → «друж», «Сандунах» → «сандун»: грубое отсечение окончаний для поиска по справочнику
const stemOf = (w: string) => (w.length >= 6 ? w.slice(0, -2) : w.length === 5 ? w.slice(0, -1) : w);

function parseDuration(text: string): { dur: number; start?: number; span: string } | null {
  let m = text.match(/(\d{1,2})[:.](\d{2})\s*(?:-|–|—|до)\s*(\d{1,2})[:.](\d{2})/);
  if (m) {
    const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
    return { dur: (b - a + 1440) % 1440 || 1440, start: a, span: m[0] };
  }
  // «с 19 до 22», «с 19:30 до 22» — часы без минут тоже пишут
  if ((m = text.match(/(?:^|[^\p{L}\d])с\s*(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|—|до)\s*(\d{1,2})(?:[:.](\d{2}))?(?!\s*(?:ч|час|мин))(?![\d])/iu)) && +m[1] < 24 && +m[3] < 24) {
    const a = +m[1] * 60 + (+m[2] || 0), b = +m[3] * 60 + (+m[4] || 0);
    const dur = (b - a + 1440) % 1440;
    if (dur >= 30 && dur <= 12 * 60) return { dur, start: a, span: m[0].trim() };
  }
  if ((m = text.match(/полтора\s*час\p{L}*/iu))) return { dur: 90, span: m[0] };
  const words: Record<string, number> = { один: 1, два: 2, три: 3, четыре: 4, пять: 5 };
  if ((m = text.match(/(один|два|три|четыре|пять)\s+час\p{L}*/iu))) return { dur: words[m[1].toLowerCase()] * 60, span: m[0] };
  if ((m = text.match(/(\d+(?:[.,]\d+)?)\s*(?:ч(?![\p{L}])|час\p{L}*|h(?![\p{L}]))(?:\s*(\d{1,2})\s*мин\p{L}*)?/iu))) {
    return { dur: Math.round(parseFloat(m[1].replace(",", ".")) * 60) + (m[2] ? +m[2] : 0), span: m[0] };
  }
  if ((m = text.match(/(\d{2,3})\s*мин\p{L}*/iu))) return { dur: +m[1], span: m[0] };
  return null;
}

// ник в тексте — сам ник или его настоящие падежные формы: Ден→Деном, Леха→Лехой, Король→Королём, Витёк→Витьком.
// «Начинается с ника» не годится: «день» становился Деном, «данные» — Даней, «Виталий» — Витьком, «фильм» — Филом.
// Токен и ник уже приведены norm(): нижний регистр, ё → е.
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function nickForms(nick: string): RegExp | null {
  let stem = nick, ends = "";
  if (/(ек|ок)$/.test(nick) && nick.length >= 4) {             // Витёк → Витька, Витьком; Пашок → Пашка, Пашкой
    stem = nick.slice(0, -2); ends = `(?:${nick.slice(-2)}|ька|ьку|ьком|ьке|ка|ки|ку|ком|кой|ке)`;
  } else if (/а$/.test(nick) && nick.length >= 3) {            // Леха → Лехи, Лехе, Леху, Лехой
    stem = nick.slice(0, -1); ends = "(?:а|ы|и|е|у|ой|ою)";
  } else if (/я$/.test(nick) && nick.length >= 3) {            // Даня → Дани, Дане, Даню, Даней
    stem = nick.slice(0, -1); ends = "(?:я|и|е|ю|ей|ею)";
  } else if (/[ьй]$/.test(nick) && nick.length >= 3) {         // Король → Короля, Королю, Королём, Короле
    stem = nick.slice(0, -1); ends = "(?:ь|й|я|ю|ем|е)";
  } else if (/[бвгджзклмнпрстфхцчшщ]$/.test(nick)) {           // Ден → Дена, Дену, Деном, Дене
    ends = "(?:а|у|ом|е|ы)?";
  } else return null;                                          // латиница и прочее — только как есть
  return new RegExp(`^${escRe(stem)}${ends}$`, "u");
}
function nickMatches(token: string, nick: string) {
  return token === nick || !!nickForms(nick)?.test(token);
}

function parseCompany(text: string, entities: Any[], lg: Any, authorId: string) {
  const ids = new Set<string>(), used = new Set<string>();
  // @username из текста — на случай, если Telegram не прислал разметку
  for (const m of text.matchAll(/@(\w{4,32})/g)) {
    const u = m[1].toLowerCase();
    used.add("@" + u);
    const acc = u !== BOT && lg.accounts.find((a: Any) => a.tg_username?.toLowerCase() === u);
    if (acc && acc.player_id !== authorId) ids.add(acc.player_id);
  }
  // автор в свою компанию не попадает никак: его строку submit() добавляет сам, повтор ломал вставку всей компании
  for (const e of entities ?? []) {
    if (e.type === "mention") {
      const u = text.substr(e.offset + 1, e.length - 1).toLowerCase();
      used.add("@" + u);
      if (u === BOT) continue;
      const acc = lg.accounts.find((a: Any) => a.tg_username?.toLowerCase() === u);
      if (acc && acc.player_id !== authorId) ids.add(acc.player_id);
    } else if (e.type === "text_mention" && e.user) {
      const acc = lg.accounts.find((a: Any) => a.tg_id === e.user.id);
      if (acc && acc.player_id !== authorId) ids.add(acc.player_id);
    }
  }
  const t = norm(text);
  const tokens = t.split(/[^\p{L}\p{N}_@]+/u).filter(Boolean);
  const single = lg.players.filter((p: Any) => !p.nick.includes(" "));
  for (const tok of tokens) {
    if (tok.startsWith("@")) continue;
    // самый длинный подходящий ник: «Денисом» — это Денис, а не Ден
    const best = single.filter((p: Any) => nickMatches(tok, norm(p.nick))).sort((a: Any, b: Any) => b.nick.length - a.nick.length)[0];
    if (best) { used.add(tok); if (best.id !== authorId) ids.add(best.id); }
  }
  for (const p of lg.players.filter((p: Any) => p.nick.includes(" "))) {
    const n = escRe(norm(p.nick));
    if (new RegExp(`(^|[\\s,])${n}(?=$|[\\s,.!])`, "u").test(t)) {
      n.split(" ").forEach((w) => used.add(w));
      if (p.id !== authorId) ids.add(p.id);
    }
  }
  return { ids: [...ids], used };
}

// что осталось от поста после времени, компании, отметок и служебных слов — это и есть баня (регистр сохраняем)
function bathQuery(text: string, durSpan: string | null, used: Set<string>) {
  let t = text.replace(/https?:\/\/\S+/g, " ").replace(/-?\d{1,3}\.\d{3,}/g, " ").replace(/@\w+/g, " ").replace(/\/banya(@\w+)?/gi, " ");
  if (durSpan) t = t.replace(durSpan, " ");
  return t.split(/[^\p{L}\p{N}-]+/u)
    .filter((w) => { const n = norm(w); return n.length > 1 && !STOP.has(n) && !used.has(n) && !/^\d+$/.test(n); })
    .join(" ");
}

async function findBaths(q: string) {
  const words = norm(q).split(" ").filter((w) => w.length > 1).map(stemOf);
  if (!words.length) return [];
  const cols = "id, name, region, country, type";
  let query = sb.from("baths").select(cols).neq("status", "rejected").limit(60);
  for (const w of words) query = query.ilike("name", `%${w}%`);
  let { data } = await query;
  let score: Record<number, number> = {};
  if (!data?.length) {
    // хотя бы одно отличительное слово из названия
    const found = new Map<number, Any>();
    for (const w of words.filter((w) => w.length > 2 && !GENERIC.has(w) && ![...GENERIC].some((g) => g.startsWith(w)))) {
      const { data: part } = await sb.from("baths").select(cols).neq("status", "rejected").ilike("name", `%${w}%`).limit(40);
      for (const b of part ?? []) { found.set(b.id, b); score[b.id] = (score[b.id] ?? 0) + 1; }
    }
    data = [...found.values()];
  } else score = Object.fromEntries(data.map((b: Any) => [b.id, words.length]));
  if (!data.length) return [];
  const { data: counts } = await sb.from("bath_counts").select("bath_id, n").in("bath_id", data.map((b: Any) => b.id));
  const pop: Record<number, number> = {};
  for (const c of counts ?? []) pop[c.bath_id] = (pop[c.bath_id] ?? 0) + c.n;
  return data.map((b: Any) => ({ ...b, visits: pop[b.id] ?? 0 }))
    .sort((a: Any, b: Any) => (score[b.id] - score[a.id]) || (b.visits - a.visits)).slice(0, 6);
}

const ULTRA = /(^|[^\p{L}])(уу|ультра\p{L}*|новая баня|новую баню|нигде не были|никто не был)(?![\p{L}])/iu;
// тип бани словами в посте — «частная», «общественная», «хуитнес»: пригодится, если в справочнике тип не размечен
function typeFromText(text: string): string | null {
  if (/(^|[^\p{L}])частн\p{L}*/iu.test(text)) return "private";
  if (/(^|[^\p{L}])общественн\p{L}*/iu.test(text)) return "public";
  if (/(^|[^\p{L}])(хуитнес\p{L}*|фитнес\p{L}*|спа)(?![\p{L}])/iu.test(text)) return "spa";
  return null;
}

// ---------- черновик и карточка ----------
async function renderCard(st: Any, lg: Any) {
  const nicks = (st.company ?? []).map((id: string) => lg.players.find((p: Any) => p.id === id)?.nick).filter(Boolean);
  const who = `<b>${esc(st.authorNick)}</b>`;
  if (!st.bathId && !st.newBath) {
    const rows: Any[][] = (st.candidates ?? []).map((b: Any) => [btn(`${b.name}${b.region ? " · " + b.region : ""}`.slice(0, 58), `b:${b.id}`)]);
    let text: string;
    if (st.ultra && rows.length) {
      text = `${who}, похоже, это одна из этих — в них лига уже была. Или точно новая?`;
      rows.push([btn("🆕 Точно новая — УУ", "nb")]);
    } else if (rows.length) {
      text = `${who}, в какой бане? Выбери или ответь на это сообщение названием.`;
      if (st.query) rows.push([btn(`🆕 Нет в списке — новая «${st.query.slice(0, 24)}»`, "nb")]);
    } else if (st.query) {
      text = `${who}, не нашёл «${esc(st.query)}» в справочнике. Это новая баня — ультрауникальная? Или ответь на это сообщение названием по-другому.`;
      rows.push([btn("🆕 Да, новая — УУ", "nb")]);
    } else {
      text = `${who}, в какой бане парились? Ответь на это сообщение названием.`;
    }
    rows.push([btn("✖️ Отмена", "x")]);
    return { text, kb: rows };
  }
  const lines = [
    `🧖 <b>${esc(st.bathName)}</b>${st.newBath ? " · 🆕 новая, кандидат в УУ" : ""}`,
    `⏱ ${durLabel(st.dur)}${st.dur == null ? " — через 2,5 часа спрошу, была ли долгая" : ""}`,
    `👥 ${nicks.length ? esc(nicks.join(", ")) : "один"}`,
  ];
  if (st.geo) lines.push("📍 точка на карте есть");
  // тип не размечен (или баня новая) — спрашиваем: от него зависит +1 за общественную (п. 4); ответ необязательный
  const askType = st.newBath || (st.bathId && !st.bathType);
  if (askType && st.type) lines.push(`🏷 ${TYPE_RU[st.type]}`);
  else if (askType) lines.push("🏷 Какая это баня? Выбери ниже — за общественную +1");
  if (st.awaiting === "company") lines.push("\nКто был? Ответь на это сообщение: ники через запятую или @username, «один» — если один.");
  if (st.awaiting === "dur") lines.push("\nСколько парились? По регламенту важно только, была ли долгая — больше 2,5 часа.");
  const kb: Any[][] = st.awaiting === "dur"
    ? [[btn("🧖 Обычная — до 2,5 ч", "d:120")], [btn("🔥 Долгая — больше 2,5 ч", "d:180")], [btn("Ещё паримся", "d:0")]]
    : [...(askType ? [Object.entries(TYPE_BTN).map(([t, l]) => btn(`${st.type === t ? "✓ " : ""}${l}`, `t:${t}`))] : []),
      [btn("✅ В Комиссию", "send")], [btn("🏠 Баня", "eb"), btn("⏱ Время", "ed"), btn("👥 Компания", "ec")], [btn("✖️ Отмена", "x")]];
  return { text: `${who}, всё верно?\n\n${lines.join("\n")}`, kb };
}

async function showCard(st: Any, lg: Any, tgId: number) {
  const { text, kb } = await renderCard(st, lg);
  if (st.card) await edit(st.chat, st.card, text, kb);
  else {
    const r = await send(st.chat, text, kb, st.chatType === "private" ? undefined : st.source);
    if (r.ok) st.card = r.result.message_id;
  }
  await setState(tgId, st);
}

async function resolveBath(st: Any) {
  if (!st.query) { st.candidates = []; return; }
  const found = await findBaths(st.query);
  // одна уверенная находка без «УУ» — берём сразу; иначе уточняем
  if (!st.ultra && found.length === 1) { st.bathId = found[0].id; st.bathName = found[0].name; st.bathType = found[0].type ?? null; st.candidates = []; return; }
  if (st.ultra && !found.length) { st.newBath = st.query; st.bathName = st.query; st.candidates = []; return; }
  st.candidates = found.map((b: Any) => ({ id: b.id, name: b.name, region: b.region, type: b.type ?? null }));
}

// новый пост с отметкой бота — новый черновик
async function startDraft(msg: Any, me: Any, lg: Any) {
  const text: string = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const d = parseDuration(text);
  const comp = parseCompany(text, entities, lg, me.id);
  const st: Any = {
    chat: msg.chat.id, chatType: msg.chat.type, chatUsername: msg.chat.username ?? null, source: msg.message_id, posted: msg.date,
    author: msg.from.id, authorId: me.id, authorNick: me.nick,
    dur: d && d.dur >= 60 ? d.dur : null, start: d?.start ?? null, company: comp.ids,
    ultra: ULTRA.test(text), type: typeFromText(text), query: bathQuery(text.replace(/\/banya(@\w+)?/i, " "), d?.span ?? null, comp.used),
  };
  st.geo = await pointFromMessage(msg);
  await resolveBath(st);
  await showCard(st, lg, msg.from.id);
}

// геопозиция из Telegram или ссылка на карту/координаты в тексте
async function pointFromMessage(msg: Any) {
  const loc = msg.location ?? msg.venue?.location;
  if (loc) return { lat: loc.latitude, lng: loc.longitude };
  const text = msg.text ?? msg.caption ?? "";
  return hasLocationHint(text) ? await parseLocation(text) : null;
}

// точка бани: новую ставим всегда, существующую — только если сейчас она примерная (или ставит Комиссия)
async function setBathPoint(bathId: number, p: { lat: number; lng: number }, byCommission = false) {
  const { data: b } = await sb.from("baths").select("precision, lat, country, region").eq("id", bathId).single();
  if (!byCommission && b?.precision === "exact" && b?.lat != null) return false;
  // страну и регион не знали (новая баня) — берём по точке: без них не посчитать бонусы за регион и страну (п. 14)
  const place = b?.country && b?.region ? {} : await placeFor(p, b);
  await sb.from("baths").update({ lat: p.lat, lng: p.lng, precision: "exact", ...place }).eq("id", bathId);
  return true;
}

// страна и регион по точке — в написании Комиссии («Кировская обл»); уже заполненное не трогаем
async function placeFor(p: { lat: number; lng: number }, have: Any = {}) {
  const { data: known } = await sb.from("bath_places").select("country, region, n").limit(5000);
  const pl = matchPlace(await reversePlace(p.lat, p.lng), known ?? []);
  return { ...(!have?.country && pl.country ? { country: pl.country } : {}), ...(!have?.region && pl.region ? { region: pl.region } : {}) };
}

// ответ на карточку — дополняем черновик
async function continueDraft(msg: Any, st: Any, me: Any, lg: Any) {
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  const geo = await pointFromMessage(msg);
  if (geo) st.geo = geo;
  if (text) {
    if (st.awaiting === "company") {
      st.company = /^(один|одна|одни|сам|сама|никого)$/i.test(text) ? [] : parseCompany(text, msg.entities ?? [], lg, me.id).ids;
      st.awaiting = null;
    } else if (!st.bathId && !st.newBath && !hasLocationHint(text)) {
      st.query = bathQuery(text, null, new Set()); st.ultra = st.ultra || ULTRA.test(text);
      await resolveBath(st);
    } else {
      const d = parseDuration(text);
      // время написали словами вместо кнопок — вопрос «Сколько парились?» закрыт
      if (d && d.dur >= 60) { st.dur = d.dur; st.start = d.start ?? st.start; if (st.awaiting === "dur") st.awaiting = null; }
      const c = parseCompany(text, msg.entities ?? [], lg, me.id);
      if (c.ids.length) st.company = [...new Set([...(st.company ?? []), ...c.ids])];
    }
  }
  await showCard(st, lg, msg.from.id);
}

// не получилось — черновик возвращаем (его забрала кнопка «В Комиссию»), карточка с ошибкой и теми же кнопками
async function submitFailed(st: Any, lg: Any, tgId: number, why: string) {
  await setState(tgId, st);
  const { text, kb } = await renderCard(st, lg);
  return edit(st.chat, st.card, `⚠️ ${esc(why)}\n\n${text}`, kb);
}

async function submit(st: Any, lg: Any, tgId: number) {
  // newBathId — баня, заведённая прошлой неудачной попыткой: повтор не плодит вторую такую же
  let bathId = st.bathId ?? st.newBathId;
  if (!bathId) {
    const { data: nb, error } = await sb.from("baths").insert({
      name: st.newBath, status: "pending", created_by: st.authorId, type: st.type ?? null,
      ...(st.geo ? { lat: st.geo.lat, lng: st.geo.lng, precision: "exact", ...(await placeFor(st.geo)) } : {}),
    }).select().single();
    if (error) return submitFailed(st, lg, tgId, `Не получилось добавить баню: ${error.message}`);
    bathId = st.newBathId = nb.id;
  }
  const posted = new Date(st.posted * 1000);
  let entered: Date;
  if (st.start != null) {
    // «с 18:00 до 21:00» — заход сегодня по Москве в 18:00 (если это время ещё не наступило — вчера)
    const msk = new Date(posted.getTime() + 3 * 3600e3);
    entered = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate(), 0, st.start) - 3 * 3600e3);
    if (entered > posted) entered = new Date(entered.getTime() - 864e5);
  } else entered = st.dur != null ? new Date(posted.getTime() - st.dur * 60e3) : posted;
  const link = st.chatType === "private" ? null : postLink({ id: st.chat, username: st.chatUsername }, st.source);
  const { data: visit, error } = await sb.from("visits").insert({
    bath_id: bathId, entered_at: entered.toISOString(), posted_at: posted.toISOString(), duration_min: st.dur ?? 60,
    created_by: st.authorId, source: "bot", tg_link: link, long_asked_at: st.dur != null ? new Date().toISOString() : null,
  }).select().single();
  if (error) return submitFailed(st, lg, tgId, `Не получилось сохранить поход: ${error.message}`);
  // автор и компания без повторов: один дубль ключа отменял вставку всех строк, и поход оставался без людей
  const people = [...new Set([st.authorId, ...(st.company ?? [])])];
  const { error: pErr } = await sb.from("visit_players").insert(people.map((id: string) => ({ visit_id: visit.id, player_id: id })));
  if (pErr) {
    await sb.from("visits").delete().eq("id", visit.id);
    return submitFailed(st, lg, tgId, `Не получилось записать компанию: ${pErr.message}`);
  }
  if (st.geo && st.bathId) await setBathPoint(st.bathId, st.geo, lg.players.find((p: Any) => p.id === st.authorId)?.is_commission);
  // тип бани со слов автора — только если он не был размечен; ошибся — Комиссия поправит в карточке бани
  if (st.bathId && st.type) await sb.from("baths").update({ type: st.type }).eq("id", st.bathId).is("type", null);
  await sb.from("bot_posts").insert({ visit_id: visit.id, chat_id: st.chat, source_msg: st.source, card_msg: st.card, bath_id: bathId });

  const nicks = (st.company ?? []).map((id: string) => lg.players.find((p: Any) => p.id === id)?.nick).filter(Boolean);
  const summary = `🧖 <b>${esc(st.bathName)}</b>${st.newBath ? " · 🆕 кандидат в УУ" : ""}\n⏱ ${durLabel(st.dur)}\n👥 ${nicks.length ? esc(nicks.join(", ")) : "один"}`
    + (st.type && !st.bathType ? `\n🏷 ${TYPE_RU[st.type]} — со слов автора` : "");
  await edit(st.chat, st.card, `Ушло в Комиссию ✅ <b>${esc(st.authorNick)}</b>\n\n${summary}`);
  // 👀 — и на пост, и на карточку «Ушло в Комиссию»
  if (st.chatType !== "private") { await react(st.chat, st.source, "👀"); await react(st.chat, st.card, "👀"); }

  // точка на карте: у новой бани её может не быть, у старой — стоять по центру города или региона
  // необязательно: попросить точку, если бани нет на карте или она стоит примерно
  const { data: bath } = await sb.from("baths").select("lat, precision").eq("id", bathId).single();
  if (bath?.lat == null || bath?.precision !== "exact") {
    const r = await send(st.chat, `📍 «${esc(st.bathName)}» ${bath?.lat == null ? "ещё нет на карте" : "стоит на карте примерно"}. `
      + "Скинь следующим сообщением ссылку на баню в Яндекс/Google Картах, адрес или геопозицию (📎 → Геопозиция) — поставлю точную точку.",
      [[btn("🙅 Отстань", `gx:${visit.id}`)]], st.chatType === "private" ? undefined : st.card);
    if (r.ok) await sb.from("bot_posts").update({ geo_msg: r.result.message_id, geo_at: new Date().toISOString() }).eq("visit_id", visit.id);
  }

  const commission = lg.accounts.filter((a: Any) => a.tg_id && lg.players.find((p: Any) => p.id === a.player_id)?.is_commission);
  const note = `🔔 Поход от <b>${esc(st.authorNick)}</b>${link ? ` · <a href="${link}">пост</a>` : ""}\n\n${summary}`;
  for (const c of commission) {
    const r = await send(c.tg_id, note, [[btn("✅ Засчитать", `ok:${visit.id}`), btn("❌ Отклонить", `no:${visit.id}`)]]);
    if (r.ok) await sb.from("bot_notifications").upsert({ visit_id: visit.id, chat_id: c.tg_id, message_id: r.result.message_id, text: note });
  }
}

async function moderate(cq: Any, me: Any, visitId: number, ok: boolean) {
  if (!me?.is_commission) return answer(cq.id, "Это кнопка для Комиссии", true);
  const { data: v } = await sb.from("visits").select("id, status, baths(name)").eq("id", visitId).maybeSingle();
  if (!v) return answer(cq.id, "Поход не найден — возможно, его удалили");
  if (v.status !== "pending") return answer(cq.id, `Уже ${v.status === "ok" ? "засчитан" : "отклонён"}`);
  // только если всё ещё ждёт: двое из Комиссии могли нажать одновременно (или решили на сайте)
  const { data: done } = await sb.from("visits").update({ status: ok ? "ok" : "rejected", moderated_by: me.id, moderated_at: new Date().toISOString() })
    .eq("id", visitId).eq("status", "pending").select("id");
  if (!done?.length) return answer(cq.id, "Уже решено");
  await answer(cq.id, ok ? "Засчитано" : "Отклонено");
  await announce(visitId);   // триггер в базе тоже позовёт — второй вызов ничего не сделает
}

const setting = async (key: string) => (await sb.from("settings").select("value").eq("key", key).maybeSingle()).data?.value ?? null;

// поход отметили на сайте (зовёт триггер: ?new=<id>): бот сам пишет о нём в чат лиги — это и есть пост похода,
// вердикт потом придёт ответом на него; Комиссии в личку — то же уведомление с кнопками, что для походов из чата
async function siteVisit(visitId: number): Promise<boolean> {
  // сайт пишет поход и компанию одной транзакцией (submit_visit), а pg_net зовёт нас после коммита —
  // короткая пауза на случай старой страницы, которая дописывает компанию отдельным запросом
  await new Promise((r) => setTimeout(r, 800));
  const { data: v } = await sb.from("visits")
    .select("status, source, bath_id, duration_min, created_at, baths(name, type), author:players!visits_created_by_fkey(nick), visit_players(players(nick))")
    .eq("id", visitId).maybeSingle();
  // только свежий поход с сайта, который ждёт решения
  if (!v || v.source !== "site" || v.status !== "pending" || Date.now() - new Date(v.created_at).getTime() > 15 * 60e3) return false;
  // защита от повтора — строка поста: вставляет только первый вызов
  const chat = Number(await setting("league_chat")) || 0;
  const { data: claim } = await sb.from("bot_posts").insert({ visit_id: visitId, chat_id: chat, source_msg: 0, bath_id: v.bath_id })
    .select("visit_id").maybeSingle();
  if (!claim) return false;
  const vv = v as Any, author = vv.author?.nick;
  const company = (vv.visit_players ?? []).map((x: Any) => x.players?.nick).filter((n: string) => n && n !== author);
  const summary = `🧖 <b>${esc(vv.baths?.name)}</b>\n⏱ ${durLabel(v.duration_min)}\n👥 ${company.length ? esc(company.join(", ")) : "один"}`
    + (vv.baths?.type ? `\n🏷 ${TYPE_RU[vv.baths.type]}` : "");
  if (chat) {
    const r = await send(chat, `🌐 <b>${esc(author)}</b> отметил баню на сайте\n\n${summary}\n\nЖдёт Комиссию 👀`);
    if (r.ok) {
      await sb.from("bot_posts").update({ source_msg: r.result.message_id }).eq("visit_id", visitId);
      await react(chat, r.result.message_id, "👀");
    }
  }
  const note = `🔔 Поход с сайта от <b>${esc(author)}</b>\n\n${summary}`;
  const lg = await league();
  const commission = lg.accounts.filter((a: Any) => a.tg_id && lg.players.find((p: Any) => p.id === a.player_id)?.is_commission);
  for (const c of commission) {
    const r = await send(c.tg_id, note, [[btn("✅ Засчитать", `ok:${visitId}`), btn("❌ Отклонить", `no:${visitId}`)]]);
    if (r.ok) await sb.from("bot_notifications").upsert({ visit_id: visitId, chat_id: c.tg_id, message_id: r.result.message_id, text: note });
  }
  return true;
}

// Решение Комиссии — в Telegram, одинаково для кнопок бота, сайта и правки заявки (оттуда зовёт триггер: ?verdict=<id>):
// 👍/💩 на пост и карточку, итог отдельным сообщением в ответ на пост, в личке Комиссии — кто решил, кнопки убираем.
async function announce(visitId: number): Promise<boolean> {
  const { data: v } = await sb.from("visits")
    .select("status, source, bath_id, reject_reason, moderated_at, baths(name), author:players!visits_created_by_fkey(nick), judge:players!visits_moderated_by_fkey(nick)")
    .eq("id", visitId).maybeSingle();
  if (!v || !["ok", "rejected"].includes(v.status)) return false;
  const freshVerdict = !!v.moderated_at && Date.now() - new Date(v.moderated_at).getTime() < 15 * 60e3;
  // объявляет тот, кто первым отметил статус объявленным: кнопка и триггер могут прийти одновременно
  const { data: won } = await sb.from("bot_posts").update({ announced: v.status })
    .eq("visit_id", visitId).or(`announced.is.null,announced.neq.${v.status}`).select("chat_id, source_msg, card_msg");
  let post = won?.[0];
  if (!post && v.source === "site" && freshVerdict) {
    // поход с сайта: поста в группе нет — объявим отдельным сообщением в чате лиги (вставка строки — та же защита от повтора).
    // Только свежее решение: ?verdict=<id> открыт всем, и старые походы иначе можно было «переобъявить» в чат
    const chat = Number(await setting("league_chat"));
    if (!chat) return false;
    const { data: fresh } = await sb.from("bot_posts").insert({ visit_id: visitId, chat_id: chat, source_msg: 0, bath_id: v.bath_id, announced: v.status })
      .select("chat_id, source_msg, card_msg").maybeSingle();
    post = fresh ?? undefined;
  }
  if (!post) return false;
  const ok = v.status === "ok", vv = v as Any;
  if (ok) await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);

  const verdict = `${ok ? "✅ Засчитано" : "❌ Отклонено"}${vv.judge?.nick ? ` — ${esc(vv.judge.nick)}` : ""}`
    + (!ok && v.reject_reason ? `\nПричина: ${esc(v.reject_reason)}` : "");
  const { data: notes } = await sb.from("bot_notifications").select("chat_id, message_id, text").eq("visit_id", visitId);
  for (const n of notes ?? []) {
    if (n.text) await edit(n.chat_id, n.message_id, `${n.text}\n\n${verdict}`);
    else await tg("editMessageReplyMarkup", { chat_id: n.chat_id, message_id: n.message_id, reply_markup: { inline_keyboard: [] } });
  }

  // в группе: реакция на пост и итог отдельным сообщением в ответ на пост (прошлые сообщения бота не трогаем)
  if (post.chat_id < 0) {
    const { data: pts } = await sb.from("visit_points").select("nick, total").eq("visit_id", visitId);
    const who = vv.author?.nick, bath = esc(vv.baths?.name);
    const ptsLine = ok && pts?.length ? ": " + pts.map((p: Any) => `${esc(p.nick)} +${p.total}`).join(" · ") : "";
    // ответом на пост видно, о каком походе речь; отдельному сообщению (старые походы с сайта) — пометка
    const where = v.source === "site" && !post.source_msg ? " (отмечен на сайте)" : "";
    if (post.source_msg) await react(post.chat_id, post.source_msg, ok ? "👍" : "💩");
    if (post.card_msg) await react(post.chat_id, post.card_msg, ok ? "👍" : "💩");
    const r = await send(post.chat_id, ok
      ? `👍 Комиссия засчитала поход${who ? " " + esc(who) : ""} в «${bath}»${where}${ptsLine}`
      : `💩 Комиссия не засчитала поход${who ? " " + esc(who) : ""} в «${bath}»${where}.`
        + (v.reject_reason ? ` Причина: ${esc(v.reject_reason)}.` : "") + " Если это ошибка — напишите Комиссии.",
      undefined, post.source_msg || undefined);
    // у похода с сайта первое объявление и есть его пост: следующие решения — ответом на него
    if (!post.source_msg && r.ok) await sb.from("bot_posts").update({ source_msg: r.result.message_id }).eq("visit_id", visitId);
  }
  return true;
}

// ответ на вопрос про точку: геопозиция, ссылка с точкой, адрес или ссылка на карточку организации
async function geoAnswer(msg: Any, post: Any, me: Any) {
  const { data: b } = await sb.from("baths").select("id, name, lat, lng, precision").eq("id", post.bath_id).single();
  const loc = msg.location ?? msg.venue?.location;
  // найденный адрес сверяем с примерной точкой бани, чтобы не поставить точку в другом городе
  const near = b?.lat != null && b.precision !== "exact" ? { lat: b.lat, lng: b.lng } : null;
  const maxKm = { city: 80, region: 400, country: 1500 }[b?.precision as string] ?? 400;
  const p = loc ? { lat: loc.latitude, lng: loc.longitude } : await locate(msg.text ?? msg.caption ?? "", near, maxKm);
  if (!p) {
    return send(msg.chat.id, "Не нашёл, где это. Пришли ссылку, где на карте видна точка, адрес с номером дома или геопозицию (📎 → Геопозиция).",
      [[btn("🙅 Отстань", `gx:${post.visit_id}`)]], msg.message_id);
  }
  const done = await setBathPoint(post.bath_id, p, me.is_commission);
  await sb.from("bot_posts").update({ geo_msg: null }).eq("visit_id", post.visit_id);
  if (done) await react(msg.chat.id, msg.message_id, "👍");
  return send(msg.chat.id, done ? `📍 «${esc(b?.name)}» теперь на карте точно — спасибо!` : "У этой бани уже стоит точная точка — поменять её может Комиссия.", undefined, msg.message_id);
}

// ответ без «Ответить»: следующее сообщение автора после вопроса про точку (15 мин)
async function implicitAnswer(msg: Any): Promise<boolean> {
  const chat = msg.chat.id, hasGeo = !!(msg.location || msg.venue), text = msg.text ?? msg.caption ?? "";
  if (!hasGeo && !/https?:\/\//.test(text) && !looksLikeAddress(text) && !hasLocationHint(text)) return false;
  const acc = await whoIs(msg.from.id);
  const me = acc?.players as Any;
  if (!me) return false;
  const { data: posts } = await sb.from("bot_posts").select("visit_id, bath_id, visits!inner(created_by)")
    .eq("chat_id", chat).not("geo_msg", "is", null).gte("geo_at", new Date(Date.now() - 15 * 60e3).toISOString())
    .eq("visits.created_by", me.id).order("geo_at", { ascending: false }).limit(1);
  if (!posts?.length) return false;
  await geoAnswer(msg, posts[0], me);
  return true;
}

// «Долгая была?» — на доверии: один ответ «да» от участника делает поход долгим, ошибки правит Комиссия.
// Спустя сутки после захода кнопка уже не работает: старый вопрос в чате не должен менять давно решённые походы.
const LONG_STRANGER = "Это вопрос для тех, кто был в походе";
const LONG_LATE = "Прошло больше суток — долгую теперь отмечает только Комиссия";
async function markLong(visitId: number, me: Any): Promise<"ok" | "stranger" | "late"> {
  const { data: vp } = await sb.from("visit_players").select("player_id").eq("visit_id", visitId).eq("player_id", me?.id ?? "").maybeSingle();
  if (!vp) return "stranger";
  const { data: v } = await sb.from("visits").select("duration_min, status, entered_at").eq("id", visitId).single();
  if (Date.now() - new Date(v.entered_at).getTime() > 864e5) return "late";
  if (v.duration_min <= LONG) await sb.from("visits").update({ duration_min: LONG + 1 }).eq("id", visitId);
  if (v.status === "ok") await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);
  return "ok";
}

// ответ участника под вопросом «Долгая была?» — по строке на ответ; повторное нажатие ничего не дописывает (null)
function withLongAnswer(text: string, line: string): string | null {
  const lines = text.split("\n");
  if (lines.includes(line)) return null;
  const answered = lines.some((l) => /: (долгая 🔥|обычная)$/u.test(l));
  return `${text}${answered ? "\n" : "\n\n"}${line}`;
}

// ответ текстом на «Долгая была?» — кнопки удобнее, но «да»/«нет» тоже понимаем
async function longAnswer(msg: Any, post: Any, me: Any) {
  const text = (msg.text ?? "").trim();
  if (/^(да|ага|угу|конечно|долгая|yes|\+)(?![\p{L}\p{N}])/iu.test(text)) {
    const res = await markLong(post.visit_id, me);
    if (res !== "ok") return send(msg.chat.id, res === "late" ? LONG_LATE : `${LONG_STRANGER} 🙂`, undefined, msg.message_id);
    await react(msg.chat.id, msg.message_id, "🔥");
    return send(msg.chat.id, `🔥 ${esc(me.nick)}: долгая — +1 всей компании.`, undefined, msg.message_id);
  }
  if (/^(нет|не|обычная|no|-)(?![\p{L}\p{N}])/iu.test(text)) return react(msg.chat.id, msg.message_id, "👌");
  return send(msg.chat.id, "Нажми кнопку под вопросом: долгая или обычная.", undefined, msg.message_id);
}

async function tick() {
  const now = Date.now();
  const { data } = await sb.from("visits")
    .select("id, entered_at, status, bot_posts!inner(chat_id, source_msg), visit_players(player_id)")
    .is("long_asked_at", null).eq("source", "bot").neq("status", "rejected").lte("duration_min", LONG)   // на сайте длительность выбирают сразу
    .lte("entered_at", new Date(now - LONG * 60e3).toISOString()).gte("entered_at", new Date(now - 864e5).toISOString());
  const lg = await league();
  let asked = 0;
  const claimed: number[] = [];
  for (const v of data ?? []) {
    // сначала забираем поход себе, потом спрашиваем: параллельные ?tick=1 не должны спросить дважды
    const { data: mine } = await sb.from("visits").update({ long_asked_at: new Date().toISOString() })
      .eq("id", v.id).is("long_asked_at", null).select("id");
    if (!mine?.length) continue;
    claimed.push(v.id);
    const post = (v as Any).bot_posts;
    const people = v.visit_players.map((x: Any) => {
      const acc = lg.accounts.find((a: Any) => a.player_id === x.player_id);
      return acc?.tg_username ? "@" + acc.tg_username : esc(lg.players.find((p: Any) => p.id === x.player_id)?.nick);
    });
    const r = await send(post.chat_id,
      `⏳ ${people.join(", ")}, прошло 2,5 часа. Долгая была — больше 2,5 ч?`,
      LONG_KB(v.id), post.source_msg);
    if (r.ok) { await sb.from("bot_posts").update({ ask_msg: r.result.message_id }).eq("visit_id", v.id); asked++; }
  }
  return { asked, claimed };
}

// ---------- обработчики ----------
const mentionsBot = (msg: Any) => {
  const text: string = msg.text ?? msg.caption ?? "";
  const ents = msg.entities ?? msg.caption_entities ?? [];
  return ents.some((e: Any) => (e.type === "mention" && text.substr(e.offset + 1, e.length - 1).toLowerCase() === BOT)
    || (e.type === "bot_command" && /^\/banya/i.test(text.substr(e.offset, e.length))));
};

const HOWTO = `Отмечайте походы прямо здесь — отметьте меня и напишите как есть:\n<i>@${BOT} Сандуны 3ч с Деном</i>\n\n`
  + "Не хватит чего-то — переспрошу. Не указали время — через 2,5 часа спрошу, была ли долгая. "
  + `Поход уйдёт в Комиссию, после решения на посте появится 👍 или 💩.\nТаблица и карта: ${SITE}`;

async function onMessage(msg: Any) {
  const chat = msg.chat.id, tgId = msg.from?.id, isPrivate = msg.chat.type === "private";
  // бота добавили в группу — здороваемся и показываем, как отмечать походы
  if (msg.new_chat_members?.some((u: Any) => u.is_bot && u.username?.toLowerCase() === BOT)) {
    return send(chat, `Привет, ЕБЛ! 🧖\n\n${HOWTO}`);
  }
  if (!tgId || msg.from.is_bot) return;
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  const replyTo = msg.reply_to_message?.message_id;

  // ответ на «Долгая была?» или на просьбу прислать точку
  if (replyTo && msg.reply_to_message.from?.username?.toLowerCase() === BOT) {
    const { data: post } = await sb.from("bot_posts").select("visit_id, chat_id").eq("chat_id", chat).eq("ask_msg", replyTo).maybeSingle();
    if (post) { const acc = await whoIs(tgId); return acc?.players ? longAnswer(msg, post, acc.players) : undefined; }
    const { data: geoPost } = await sb.from("bot_posts").select("visit_id, bath_id").eq("chat_id", chat).eq("geo_msg", replyTo).maybeSingle();
    if (geoPost?.bath_id) {
      const acc = await whoIs(tgId);
      return acc?.players ? geoAnswer(msg, geoPost, acc.players) : undefined;
    }
  }

  const saved = await getState(tgId);
  const st = saved && Date.now() - (saved.ts ?? 0) < DRAFT_TTL ? saved : null;
  const replyToCard = st && st.chat === chat && (isPrivate || (replyTo && replyTo === st.card));
  if (!isPrivate && !mentionsBot(msg) && !replyToCard) {
    await implicitAnswer(msg);   // вдруг это ответ на вопрос бота без «Ответить»
    return;                      // остальное в группе — не нам
  }

  const acc = await whoIs(tgId);
  const me = acc?.players as Any;
  if (!me) {
    return send(chat, acc?.claimed_nick
      ? `Заявка «это ${esc(acc.claimed_nick)}» ждёт Комиссию — как подтвердят, можно отмечать походы.`
      : `Чтобы отмечать походы, войди на сайте через Telegram и выбери свой ник: ${SITE}`, undefined, isPrivate ? undefined : msg.message_id);
  }
  const greeting = /^(\/start|\/help|start|старт|привет|хай|hi|hello)(?![\p{L}\p{N}])/iu.test(text);
  if (isPrivate && greeting) {
    await clearState(tgId);
    return send(chat, `Привет, ${esc(me.nick)}! ${HOWTO}\n\nЗдесь, в личке, тоже можно — просто напиши, где парился.`);
  }
  if (text === "/cancel" || text === `/cancel@${BOT}`) { await clearState(tgId); return send(chat, "Черновик отменён."); }
  if (text.startsWith("/") && !/^\/banya/i.test(text)) return;   // прочие команды — не походы

  const lg = await league();
  if (replyToCard && !mentionsBot(msg)) return continueDraft(msg, st, me, lg);
  return startDraft(msg, me, lg);
}

// дописываем ответ под вопросом «Долгая была?», если этот участник так ещё не отвечал
function noteLongAnswer(cq: Any, vid: number, line: string) {
  const next = withLongAnswer(cq.message?.text ?? "", line);
  return next ? edit(cq.message.chat.id, cq.message.message_id, esc(next), LONG_KB(vid)) : undefined;
}

// «✅ В Комиссию»: черновик забираем удалением — второе нажатие (двойной тап, повтор вебхука) его уже не найдёт
// и второй поход не создаст; если отправка сорвётся, submit() вернёт черновик
async function sendDraft(cq: Any, tgId: number) {
  const { data: taken } = await sb.from("bot_sessions").delete().eq("tg_id", tgId).select("state");
  if (!taken?.length) return answer(cq.id, "Уже отправлено");
  await answer(cq.id);
  return submit(taken[0].state, await league(), tgId);
}

async function onCallback(cq: Any) {
  const data: string = cq.data ?? "", tgId = cq.from.id;
  const acc = await whoIs(tgId);
  const me = acc?.players as Any;
  if (data.startsWith("ok:") || data.startsWith("no:")) return moderate(cq, me, Number(data.slice(3)), data.startsWith("ok:"));
  if (data.startsWith("gx:")) {
    if (!me) return answer(cq.id, "Кнопка для участников лиги");
    // просто закрываем этот вопрос: больше не ждём ответа на него
    await sb.from("bot_posts").update({ geo_msg: null }).eq("visit_id", Number(data.slice(3)));
    await answer(cq.id, "Ок");
    return edit(cq.message.chat.id, cq.message.message_id, `🙅 Ок, без точки. Её можно поставить потом на сайте: ${SITE}`);
  }
  if (data.startsWith("yl:")) {
    const vid = Number(data.slice(3));
    const res = await markLong(vid, me);
    if (res !== "ok") return answer(cq.id, res === "late" ? LONG_LATE : LONG_STRANGER, res === "late");
    await answer(cq.id, "🔥 Долгая — +1 всей компании");
    return noteLongAnswer(cq, vid, `${me.nick}: долгая 🔥`);
  }
  if (data.startsWith("nl:")) {
    const vid = Number(data.slice(3));
    const { data: vp } = await sb.from("visit_players").select("player_id").eq("visit_id", vid).eq("player_id", me?.id ?? "").maybeSingle();
    if (!vp) return answer(cq.id, LONG_STRANGER);
    await answer(cq.id, "Ок, обычная");
    return noteLongAnswer(cq, vid, `${me.nick}: обычная`);
  }
  const st = await getState(tgId);
  if (!st && data === "send") return answer(cq.id, "Уже отправлено");
  if (!st || st.card !== cq.message?.message_id || st.chat !== cq.message?.chat?.id) {
    return answer(cq.id, "Это черновик другого участника — отметь бота в своём посте", true);
  }
  if (data === "send") return sendDraft(cq, tgId);
  await answer(cq.id);
  const lg = await league();
  if (data === "x") { await clearState(tgId); return edit(st.chat, st.card, "Черновик отменён."); }
  if (data.startsWith("b:")) {
    const b = (st.candidates ?? []).find((c: Any) => c.id === Number(data.slice(2)));
    if (b) { st.bathId = b.id; st.bathName = b.name; st.bathType = b.type ?? null; st.type = null; st.newBath = null; st.newBathId = null; st.candidates = []; }
  } else if (data === "nb") {
    st.newBath = st.query; st.bathName = st.query; st.bathId = null; st.newBathId = null; st.bathType = null; st.type = null; st.candidates = [];
  } else if (data === "eb") {
    st.bathId = null; st.newBath = null; st.newBathId = null; st.bathName = null; st.bathType = null; st.type = null; await resolveBath(st);
  } else if (data.startsWith("t:") && TYPE_RU[data.slice(2)]) {
    st.type = data.slice(2);
  } else if (data === "ed") st.awaiting = "dur";
  else if (data === "ec") st.awaiting = "company";
  else if (data.startsWith("d:")) { const m = Number(data.slice(2)); st.dur = m || null; st.start = null; st.awaiting = null; }
  return showCard(st, lg, tgId);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (url.searchParams.get("tick") === "1") return new Response(JSON.stringify(await tick()), { headers: { "Content-Type": "application/json" } });
  // решение Комиссии принято не кнопкой бота — зовёт триггер в базе; объявляет только настоящий статус и только один раз
  if (url.searchParams.get("new")) {
    return new Response(JSON.stringify({ notified: await siteVisit(Number(url.searchParams.get("new"))) }), { headers: { "Content-Type": "application/json" } });
  }
  if (url.searchParams.get("verdict")) {
    return new Response(JSON.stringify({ announced: await announce(Number(url.searchParams.get("verdict"))) }), { headers: { "Content-Type": "application/json" } });
  }
  // диагностика без секретов: состояние вебхука у Telegram и последние записи журнала — только время и тип,
  // detail (данные кнопок, стек ошибки) наружу не отдаём: по нему видно, кто что решал
  if (url.searchParams.get("diag") === "1") {
    const info = await tg("getWebhookInfo", {});
    const { data: log } = await sb.from("bot_log").select("at, kind").order("id", { ascending: false }).limit(10);
    const r = info.result ?? {};
    return new Response(JSON.stringify({ pending: r.pending_update_count, last_error: r.last_error_message, last_error_at: r.last_error_date,
      allowed: r.allowed_updates, url_ok: r.url === `${BASE}/functions/v1/tg-bot`, log }), { headers: { "Content-Type": "application/json" } });
  }
  if (SECRET && url.searchParams.get("setup") === SECRET) {
    const hook = await tg("setWebhook", { url: `${BASE}/functions/v1/tg-bot`, secret_token: SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
    const cmds = await tg("setMyCommands", { commands: [
      { command: "banya", description: "Отметить поход: /banya Сандуны 3ч с Деном" },
      { command: "cancel", description: "Отменить черновик" },
    ] });
    const me = await tg("getMe", {});
    return new Response(JSON.stringify({ webhook: hook.ok, commands: cmds.ok, bot: me.result?.username, note: hook.description }), { headers: { "Content-Type": "application/json" } });
  }
  if (!SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) return new Response("forbidden", { status: 403 });
  const update = await req.json().catch(() => ({}));
  // В группе бот получает все сообщения (режим приватности выключен, иначе Telegram не присылает отметки @бота),
  // но обрабатывает и пишет в журнал только адресованные ему: отметку, ответ ему, команду, добавление в группу.
  const m = update.message;
  const addressed = !m || m.chat?.type === "private" || mentionsBot(m) || m.new_chat_members
    || m.reply_to_message?.from?.username?.toLowerCase() === BOT;
  const text = m?.text ?? m?.caption ?? "";
  const maybeAnswer = m && (m.location || m.venue || /https?:\/\//.test(text) || looksLikeAddress(text));
  if (!addressed) {
    if (maybeAnswer) { try { await onMessage(m); } catch (e) { console.error("tg-bot", e); } }
    return new Response("ok");
  }
  await sb.from("bot_log").insert({ kind: m ? `message:${m.chat?.type}` : update.callback_query ? "callback" : "other",
    detail: m ? `ents=${JSON.stringify((m.entities ?? m.caption_entities ?? []).map((e: Any) => e.type))}` : update.callback_query?.data ?? null });
  try {
    if (update.message) await onMessage(update.message);
    else if (update.callback_query) await onCallback(update.callback_query);
  } catch (e) {
    console.error("tg-bot", e);
    await sb.from("bot_log").insert({ kind: "error", detail: String((e as Error)?.stack ?? e).slice(0, 1500) });
  }
  return new Response("ok");
});
