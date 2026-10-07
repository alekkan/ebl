// Telegram-бот ЕБЛ (@eblsu_bot), вебхук.
//
// В общем чате: участник отмечает бота и пишет как есть — «@eblsu_bot Сандуны 3ч с Деном и @shurik».
// Бот отвечает карточкой: что понял, чего не хватает; уточняет баню (в т.ч. новая ли она — УУ), время, компанию.
// Пост в группе — документ похода (п. 5 регламента), его время определяет неделю (п. 6).
// После «В Комиссию»: на посте 👀, Комиссии в личку — поход с кнопками; после решения — 👍 или 💩 и итог в карточке.
// Баню отмечают сразу после входа; долгую (п. 15, на доверии — без фото) участник отмечает сам: в течение 8 часов
// после захода отмечает бота и пишет «долгая». Сам бот ничего не спрашивает — чат не захламляется.
// В личке с ботом работает то же самое, только без отметки.
// «@eblany текст» в группе — бот отвечает на сообщение отметками всех участников чата (позвать всех).
// Фото из поста (и из альбома, и досланные ответом на карточку) прикрепляются к походу — docs/photos.md.
//
// Разовая настройка вебхука и команд: GET ?setup=<TELEGRAM_WEBHOOK_SECRET>.
import { createClient } from "npm:@supabase/supabase-js@2";
import { hasLocationHint, locate, looksLikeAddress, parseLocation, useDbGeocoder } from "../_shared/geo.ts";
import { placeByPoint } from "../_shared/place.ts";
import { greetLine } from "../_shared/greetings.ts";
import { TELEGRAM_API } from "../_shared/hosts.ts";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const BASE = Deno.env.get("SUPABASE_URL")!;
const SITE = Deno.env.get("SITE_URL") ?? "https://alekkan.github.io/ebl/";
const BOT = (Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "eblsu_bot").toLowerCase();
const LONG = 150; // минут — дольше этого поход долгий
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
useDbGeocoder(sb);   // геокодер edge-функциям не отвечает — запасной путь через сервер базы (_shared/geo.ts)

// deno-lint-ignore no-explicit-any
type Any = any;

// ---------- Telegram ----------
const tg = (method: string, body: Record<string, unknown>) =>
  fetch(`${TELEGRAM_API}/bot${TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ ok: false }));
const esc = (s: unknown) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const btn = (text: string, data: string) => ({ text, callback_data: data });
const LONG_KB = (vid: number) => [[btn("🔥 Да, долгая", `yl:${vid}`), btn("Нет, экспресс", `nl:${vid}`)]];
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
// пасхалки лиги: реакция на дорогой вход и на хуитнесы — вторым сообщением после «Ушло в Комиссию», не в самой карточке
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const RICH_JOKES = ["Хуя себе пижон 🤑", "Наши люди в такие бани не ходят"];
const SPA_JOKES = ["Бля, заебали хуитнесы 😩", "Может нахуй хуитнесы заблочим? 🤔"];
// на настоящих данных бани, а не на догадке из этого конкретного поста: свежую баню или свежедогаданный тип этот
// самый пост и делает «правдой» (см. запись типа/цены ниже), шутка про это — как будто мы уже давно знали
function jokesFor(st: Any, confirmedPrice: number | null): string[] {
  const jokes: string[] = [];
  if (confirmedPrice != null && confirmedPrice > 5500) jokes.push(pick(RICH_JOKES));
  if (st.bathType === "spa") jokes.push(pick(SPA_JOKES));
  return jokes;
}
// время не указали — считаем экспресс (до 2,5 ч), через 2,5 часа спросим, не была ли долгая
const durLabel = (m: number | null) => (m != null && m > 150 ? "🔥 долгая, больше 2,5 ч" : "⚡ экспресс, до 2,5 ч");

// ---------- справочники ----------
const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
async function league() {
  const [{ data: players }, { data: accounts }, { data: aliases }] = await Promise.all([
    sb.from("players").select("id, nick, is_commission"),
    sb.from("player_accounts").select("player_id, tg_id, tg_username").not("player_id", "is", null),
    sb.from("player_aliases").select("alias, player_id"),
  ]);
  return { players: players ?? [], accounts: accounts ?? [], aliases: aliases ?? [] };
}
async function whoIs(tgId: number) {
  const { data } = await sb.from("player_accounts").select("id, player_id, claimed_nick, players(id, nick, is_commission)").eq("tg_id", tgId).maybeSingle();
  return data;
}
const getState = async (tgId: number) => ((await sb.from("bot_sessions").select("state").eq("tg_id", tgId).maybeSingle()).data?.state ?? null) as Any;
const setState = (tgId: number, state: Any) => sb.from("bot_sessions").upsert({ tg_id: tgId, state: { ...state, ts: Date.now() }, updated_at: new Date().toISOString() });
const DRAFT_TTL = 6 * 3600e3; // черновик старше 6 часов не подхватываем — новый пост начинает новый
const STASH_TTL = 3 * 864e5;  // пост, отложенный до подтверждения ника, ждёт Комиссию до трёх дней
// ответы на карточку словами: «один» — без компании, «да» на «всё верно?» — то же, что «✅ В Комиссию»
const ALONE = /^(один|одна|одни|сам|сама|никого|без никого|соло)[!.]*$/iu;
const CONFIRM = /^(да|ага|угу|верно|всё верно|все верно|всё так|все так|ок|окей|ok|отправляй|отправь|в комиссию|го|\+|👍)[!.]*$/iu;
// черновик выбросили — его фото тоже (отправленный черновик забирают удалением строки напрямую, фото уходят в поход)
const clearState = (tgId: number) => Promise.all([sb.from("bot_sessions").delete().eq("tg_id", tgId), dropDraftPhotos(tgId)]);

// ---------- разбор свободного текста ----------
const STOP = new Set(("был была были было сходил сходила сходили зашел зашли зашёл пошли парился парились попарились " +
  "в во на с со и а у к по за из от до мы я ты он сегодня вчера утром днем днём вечером ночью час часа часов ч мин минут минуты " +
  "баня бане бани баню фото фотка отметка отметки уу ультра ультрауникальная ультрауникальную новая новую новой компанией один одни " +
  "полундра здорово всем ребята пацаны братва " +   // приветствия лиги — не часть названия («Полундра! Легкий пар», 01.10)
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
  // словами: «долгая» — больше 2,5 ч, «экспресс» — до 2,5 ч
  if ((m = text.match(/долг(?:ая|ий|ую|ой|о)(?![\p{L}])/iu))) return { dur: 180, span: m[0] };
  if ((m = text.match(/экспресс\p{L}*/iu))) return { dur: 120, span: m[0] };
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
// клички склоняем грубее ников: «Мамонтов» → «Мамонтовым», «Уважаемый» → «Уважаемым», «Демон» → «Демоном»;
// выученную из поста «Мамонтовым» узнаём и в других падежах
function aliasMatches(token: string, alias: string) {
  if (nickMatches(token, alias)) return true;
  const base = alias.replace(/(ый|ий|ой|ым|им|ом|ем|ою|ей|ого|его|ому|ему|а|я|у|ю|е|ы|и|о)$/u, "");
  return base.length >= 4 && token.startsWith(base) && token.length - base.length <= 3;
}

function parseCompany(text: string, entities: Any[], lg: Any, authorId: string) {
  const ids = new Set<string>(), used = new Set<string>(), unknown: string[] = [];
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
      // упоминание по имени («с Мамонтов» — синей ссылкой): слова из него — не баня; не знаем такого — спросим кнопками
      const shown = text.substr(e.offset, e.length);
      norm(shown).split(/[^\p{L}\p{N}_]+/u).filter(Boolean).forEach((w) => used.add(w));
      const acc = lg.accounts.find((a: Any) => a.tg_id === e.user.id);
      if (acc && acc.player_id !== authorId) ids.add(acc.player_id);
      else if (!acc) unknown.push(shown);
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
  for (const p of [...lg.players.filter((p: Any) => p.nick.includes(" ")), ...(lg.aliases ?? []).filter((a: Any) => a.alias.includes(" ")).map((a: Any) => ({ id: a.player_id, nick: a.alias }))]) {
    const n = escRe(norm(p.nick));
    if (new RegExp(`(^|[\\s,])${n}(?=$|[\\s,.!])`, "u").test(t)) {
      n.split(" ").forEach((w) => used.add(w));
      if (p.id !== authorId) ids.add(p.id);
    }
  }
  // клички — только как имя: с большой буквы или сразу после «с/со/и» («уважаемый» в обычной фразе — не Шурик)
  const words = [...text.matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
  words.forEach((w, i) => {
    const tok = norm(w);
    if (used.has(tok) || !(/^\p{Lu}/u.test(w) || ["с", "со", "и"].includes(norm(words[i - 1] ?? "")))) return;
    const al = (lg.aliases ?? []).find((a: Any) => !a.alias.includes(" ") && aliasMatches(tok, norm(a.alias)));
    if (al) { used.add(tok); if (al.player_id !== authorId) ids.add(al.player_id); }
  });
  // «с Мамонтовым» — имя с большой буквы после «с/со» (и дальше через запятую или «и»), которого нет ни среди ников,
  // ни среди кличек: в название бани не берём, спросим кнопкой и предложим запомнить
  for (const m of text.matchAll(/(?:^|[\s,])(?:с|со)\s+(\p{Lu}[\p{L}-]+(?:\s*(?:,|\sи\s)\s*\p{Lu}[\p{L}-]+)*)/gu)) {
    for (const w of m[1].split(/\s*(?:,|\sи\s)\s*/u)) {
      const tok = norm(w);
      if (tok.length > 2 && !used.has(tok) && !STOP.has(tok)) { used.add(tok); unknown.push(w); }
    }
  }
  // незнакомый Telegram упоминание по имени может оказаться кличкой («Мамонтов» синей ссылкой)
  for (const u of [...unknown]) {
    const al = (lg.aliases ?? []).find((a: Any) => norm(u) === norm(a.alias) || norm(u).split(/\s+/).some((w) => aliasMatches(w, norm(a.alias))));
    if (al) { unknown.splice(unknown.indexOf(u), 1); if (al.player_id !== authorId) ids.add(al.player_id); }
  }
  return { ids: [...ids], used, unknown };
}

// что осталось от поста после времени, компании, отметок и служебных слов — это и есть баня (регистр сохраняем)
function bathQuery(text: string, durSpan: string | null, used: Set<string>) {
  let t = text.replace(/https?:\/\/\S+/g, " ").replace(/-?\d{1,3}\.\d{3,}/g, " ").replace(/@\w+/g, " ").replace(/\/banya(@\w+)?/gi, " ").replace(/#бан(я|ька)/giu, " ");
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
  // name_search — название в нижнем регистре и «ё» как «е» (слова запроса уже так приведены norm)
  for (const w of words) query = query.ilike("name_search", `%${w}%`);
  let { data } = await query;
  let score: Record<number, number> = {};
  if (!data?.length) {
    // хотя бы одно отличительное слово из названия
    const found = new Map<number, Any>();
    for (const w of words.filter((w) => w.length > 2 && !GENERIC.has(w) && ![...GENERIC].some((g) => g.startsWith(w)))) {
      const { data: part } = await sb.from("baths").select(cols).neq("status", "rejected").ilike("name_search", `%${w}%`).limit(40);
      for (const b of part ?? []) { found.set(b.id, b); score[b.id] = (score[b.id] ?? 0) + 1; }
    }
    data = [...found.values()];
  } else score = Object.fromEntries(data.map((b: Any) => [b.id, words.length]));
  if (!data.length) return [];
  const { data: counts } = await sb.from("bath_counts").select("bath_id, n").in("bath_id", data.map((b: Any) => b.id));
  const pop: Record<number, number> = {};
  for (const c of counts ?? []) pop[c.bath_id] = (pop[c.bath_id] ?? 0) + c.n;
  // full — в названии нашлись все слова запроса (а не одно из них: «Гостиница Къуанч, Чегет» ≠ «поляна Чегет, Поворот»)
  return data.map((b: Any) => ({ ...b, visits: pop[b.id] ?? 0, full: score[b.id] === words.length }))
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

// цена входа и пиво — только через карточку (кнопками), в тексте поста и в свободных ответах не ищем: слишком легко
// перепутать с чем угодно (длительность, номер дома). Порядок вопросов в карточке (renderCard/onCallback): будни/
// выходной/скидка до часа/одна цена → (если «скидка до» — час) → валюта → отдельное сообщение с принудительным
// ответом (force_reply), в него участник печатает цифру. Участнику верим — цену showCard/submit пишут в
// bath_prices/bath_beer_prices как обычную запись истории (recordPrice), отдельно не проверяя: так же, как если бы
// её занесли на сайте.
const curLabel = (code: string | null) => code ?? "₽";
const CUR_BTNS: [string, string][] = [["RUB", "₽ Рубль"], ["USD", "USD"], ["EUR", "EUR"], ["JPY", "JPY"], ["AED", "AED"]];
const BEFORE_HOURS = [12, 14, 16, 18, 20, 22];
// будни/выходной словами — только подсказка для кнопок в карточке (как догадка типа бани), окончательный выбор — кнопкой;
// «скидка до 18:00» — только рядом со словом «скидка», иначе легко перепутать с временем захода/окончания
const WEEKEND_RE = /(?:^|[^\p{L}])выходн\p{L}*(?![\p{L}])/iu;
const WEEKDAY_RE = /(?:^|[^\p{L}])будн\p{L}*(?![\p{L}])/iu;
function scheduleFromText(text: string): string | null {
  if (WEEKEND_RE.test(text)) return "weekend";
  if (WEEKDAY_RE.test(text)) return "weekday";
  return null;
}
const BEFORE_RE = /скидк\p{L}*[^\d]{0,15}до\s*(\d{1,2})[:.](\d{2})/iu;
function beforeTimeFromText(text: string): string | null {
  const m = BEFORE_RE.exec(text);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}
const SCHED_RU: Record<string, string> = { weekday: "будни", weekend: "выходной", any: "любой день" };
function schedLabel(st: Any): string {
  const parts: string[] = [];
  if (st.priceWeekend && st.priceWeekend !== "any") parts.push(SCHED_RU[st.priceWeekend]);
  if (st.priceBefore) parts.push(`скидка до ${st.priceBefore}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}
// цены этой бани (с сайта или от бота) — подставляем сразу, чтобы не набирать вручную то, что уже известно. У бани
// бывает несколько одновременно действующих цен (будни/выходной/скидка до часа) — берём последнюю запись на каждое
// сочетание измерений, а не одну последнюю по времени вообще (иначе будняя цена, занесённая раньше выходной, выглядела бы устаревшей)
const PRICE_DIMS: Record<string, string[]> = { bath_prices: ["is_weekend", "before_time"], bath_beer_prices: [] };
async function allKnownPrices(table: string, bathId: number): Promise<Any[]> {
  const dims = PRICE_DIMS[table] ?? [];
  const { data } = await sb.from(table).select(["price", "currency", ...dims].join(", ")).eq("bath_id", bathId)
    .order("price_date", { ascending: false }).order("id", { ascending: false });
  const seen = new Set<string>();
  const out: Any[] = [];
  for (const row of (data ?? []) as Any[]) {
    const key = [row.currency ?? "RUB", ...dims.map((d) => row[d] ?? "")].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ price: Math.round(row.price), currency: row.currency === "RUB" ? null : row.currency, is_weekend: row.is_weekend ?? null, before_time: row.before_time ?? null });
  }
  return out;
}
function priceDimLabel(p: Any): string {
  const parts: string[] = [];
  if (p.is_weekend === true) parts.push("выходной");
  else if (p.is_weekend === false) parts.push("будни");
  if (p.before_time) parts.push(`скидка до ${p.before_time}`);
  return parts.length ? ` · ${parts.join(", ")}` : "";
}
// цена со слов автора — участнику верим, пишем как обычную запись истории (как с сайта); повтор той же цены новую строку не плодит
async function recordPrice(table: string, bathId: number, price: number, currency: string | null, extra: Record<string, unknown>, createdBy: string) {
  let q = sb.from(table).select("price").eq("bath_id", bathId).eq("currency", currency ?? "RUB");
  for (const [k, v] of Object.entries(extra)) q = v == null ? q.is(k, null) : q.eq(k, v as Any);
  const { data: last } = await q.order("price_date", { ascending: false }).order("id", { ascending: false }).limit(1).maybeSingle();
  if (last && Number(last.price) === price) return;
  await sb.from(table).insert({ bath_id: bathId, price, currency: currency ?? "RUB", created_by: createdBy, ...extra });
}

// ---------- черновик и карточка ----------
// ---------- компания ----------
// Раньше без компании в посте карточка молча писала «👥 один» — её не замечали, и попутчики терялись (Alex B с Деном, 27.09).
// Теперь компания — явный выбор: кнопки с вероятными попутчиками или «🙋 Один»; без выбора «В Комиссию» нет.
const ALONE_IN_POST = /(?<![\p{L}\p{N}])(один|одна|одни|сам|сама|соло|в одиночку)(?![\p{L}\p{N}])/iu;
const RECENT = 36 * 3600e3;   // «тот же поход»: за последние полтора дня — бани часто кидают за вчера

// кого предложить кнопками: кто отметил эту баню за последние полтора дня (скорее всего, были вместе),
// с кем автор парился последние два месяца, дальше — самые активные в сезоне
async function companySuggestions(st: Any, lg: Any): Promise<string[]> {
  const score = new Map<string, number>();
  const bump = (id: string, n: number) => score.set(id, (score.get(id) ?? 0) + n);
  if (st.bathId) {
    const { data } = await sb.from("visits").select("visit_players(player_id)").eq("bath_id", st.bathId).neq("status", "rejected")
      .gte("entered_at", new Date(Date.now() - RECENT).toISOString());
    for (const v of data ?? []) for (const p of (v as Any).visit_players ?? []) bump(p.player_id, 100);
  }
  const { data: mine } = await sb.from("visit_players").select("visit_id, visits!inner(entered_at, status)").eq("player_id", st.authorId)
    .gte("visits.entered_at", new Date(Date.now() - 60 * 864e5).toISOString()).neq("visits.status", "rejected");
  const ids = (mine ?? []).map((x: Any) => x.visit_id);
  if (ids.length) {
    const { data: co } = await sb.from("visit_players").select("player_id").in("visit_id", ids);
    for (const c of co ?? []) bump(c.player_id, 10);
  }
  if (score.size < 7) {
    const { data: top } = await sb.from("standings").select("nick").order("baths", { ascending: false }).limit(12);
    for (const t of top ?? []) { const p = lg.players.find((x: Any) => x.nick === t.nick); if (p) bump(p.id, 1); }
  }
  score.delete(st.authorId);
  return [...score].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
}

// этот поход уже есть: кто-то отметил эту баню за последние полтора дня и указал автора — или автор отметил её сам
async function alreadyMarked(st: Any) {
  if (!st.bathId) return null;
  const { data } = await sb.from("visits").select("id, created_by, author:players!visits_created_by_fkey(nick), visit_players!inner(player_id)")
    .eq("bath_id", st.bathId).neq("status", "rejected").gte("entered_at", new Date(Date.now() - RECENT).toISOString())
    .eq("visit_players.player_id", st.authorId).order("id", { ascending: false }).limit(1);
  const v = data?.[0] as Any;
  return v ? { id: v.id, by: v.author?.nick ?? "", mine: v.created_by === st.authorId } : null;
}
// цена — от бани: сменили баню — сбрасываем и подставленную по истории, и уже введённую, иначе после смены бани
// осталась бы висеть цена совсем другого места
const bathChanged = (st: Any) => {
  st.dup = undefined; st.dupOk = false; st.suggest = undefined; st.choosing = false;
  st.knownPrices = undefined; st.knownBeerPrices = undefined;
  st.price = null; st.currency = null; st.priceFromHistory = false; st.priceWeekend = null; st.priceBefore = null;
  st.beerPrice = null; st.beerFromHistory = false;
  st.priceStep = null; st.awaitPriceFor = null; st.awaitPriceMsg = null;
};
const chunk = <T,>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

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
    return { text: st.hint ? `${st.hint}\n\n${text}` : text, kb: rows };
  }
  // этот поход уже кто-то отметил вместе с автором — второй раз не нужен (или автор сам уже отметил эту баню)
  if (st.dup && !st.dupOk) {
    const text = st.dup.mine
      ? `${who}, у тебя уже есть поход в «${esc(st.bathName)}» за эти сутки. Это ещё один? Повтор в те же сутки Комиссия может не засчитать (п. 5).`
      : `${who}, поход в «${esc(st.bathName)}» у тебя уже есть: в посте <b>${esc(st.dup.by)}</b> ты в компании — очки придут и так. Второй раз отмечать не нужно.`;
    return { text, kb: [[btn("👌 Не отмечаю", "dx"), btn("➕ Это другой поход", "do")]] };
  }
  const known = st.companyOk !== false;   // старые черновики (до выбора компании) — как раньше
  if (!known) {
    // никого ещё не выбрали: кнопки с никами и «Один». Нажатие на ник — сразу выбор (карточка «всё верно?» с этими же кнопками)
    const rows = companyButtons(st, lg, 9);
    rows.push([btn("🙋 Один", "c1")]);
    rows.push([btn("✖️ Отмена", "x")]);
    const text = `${who}, кто был в бане?\n\n🧖 <b>${esc(st.bathName)}</b>\n⏱ ${durLabel(st.dur)}\n👥 ${nicks.length ? esc(nicks.join(", ")) : "—"}`
      + (st.unknown?.length ? `\n❓ Не знаю, кто это: ${esc(st.unknown.join(", "))} — выбери кнопкой` : "")
      + `\n\nОтметь всех, кто был с тобой, — поход запишется каждому, им отдельно отмечать не нужно. Кого нет в кнопках — ответь никами на это сообщение.`
      + (st.hint ? `\n\n${st.hint}` : "");
    return { text, kb: rows };
  }
  const lines = [
    `🧖 <b>${esc(st.bathName)}</b>${st.newBath ? " · 🆕 новая, кандидат в УУ" : ""}`,
    `⏱ ${durLabel(st.dur)}${st.dur == null ? " — выйдет дольше 2,5 ч: отметь меня и напиши «долгая»" : ""}`,
    `👥 ${nicks.length ? `${esc(nicks.join(", "))} — поход запишется всем, отдельно отмечать не нужно` : "один"}`,
  ];
  if (st.geo) lines.push("📍 точка на карте есть");
  if (st.photos) lines.push(`📷 ${st.photos} фото — приложу к походу`);
  // тип не размечен (или баня новая) — спрашиваем: от него зависит +1 за общественную (п. 4); ответ необязательный
  const askType = st.newBath || (st.bathId && !st.bathType);
  if (askType && st.type) lines.push(`🏷 ${TYPE_RU[st.type]}`);
  else if (askType) lines.push("🏷 Какая это баня? Выбери ниже — за общественную +1");
  // цену без истории спрашиваем по шагам кнопками (см. onCallback): будни/выходной/скидка до часа/одна цена →
  // (скидка — до какого часа) → валюта → цифра ответом на карточку. С историей — цена уже стоит, «✏️ Изменить» её сбрасывает и заводит тот же мастер.
  // Цифру спрашиваем строкой в карточке, а не отдельным сообщением: «Сколько стоил вход?» в чате — мусор (30.09, 🤡 от Комиссии)
  const priceStep = st.priceStep;
  const askSched = st.price != null && st.priceWeekend == null && st.priceBefore == null;
  if (priceStep === "sched") lines.push("💰 Цена входа — будни, выходной, скидка до часа или одна на все дни?");
  else if (priceStep === "before") lines.push("💰 Скидка — до какого часа?");
  else if (priceStep === "currency") lines.push(`💰 Цена входа${schedLabel(st)} — в какой валюте?`);
  else if (st.awaitPriceFor === "price") lines.push(priceAskLine(st, "💰 Цена входа"));
  else if (st.priceFromHistory) {
    const list = (st.knownPrices ?? []).map((p: Any) => `${p.price} ${curLabel(p.currency)}${priceDimLabel(p)}`).join(" / ");
    lines.push(`💰 ${list} — как в прошлый раз, ✏️ можно поменять`);
  }
  else if (st.price) lines.push(`💰 ${st.price} ${curLabel(st.currency)}${schedLabel(st)} — со слов автора`);
  else lines.push("💰 Цена входа? Кнопкой ниже.");
  if (st.awaitPriceFor === "beer") lines.push(priceAskLine(st, "🍺 Цена пива"));
  else if (st.beerFromHistory) {
    const list = (st.knownBeerPrices ?? []).map((p: Any) => `${p.price} ${curLabel(p.currency)}`).join(" / ");
    lines.push(`🍺 ${list} — как в прошлый раз, ✏️ можно поменять`);
  }
  else if (st.beerPrice) lines.push(`🍺 ${st.beerPrice} ${curLabel(st.currency)} — со слов автора`);
  else if (st.price != null || st.priceFromHistory) lines.push("🍺 Цена пива? Кнопкой ниже.");
  if (st.hint) lines.push(`\n${st.hint}`);
  if (st.awaiting === "company") lines.push("\nКто был? Отметь кнопками или ответь на это сообщение: ники через запятую или @username, «один» — если один.");
  if (st.awaiting === "dur") lines.push("\nДолгая или экспресс? По регламенту важно только, была ли дольше 2,5 часа.");
  // компанию выбирали кнопками (или правят) — кнопки с никами остаются: добавить или убрать ещё кого-то, без «Готово»
  const pick = st.picking || (st.picked ?? []).length ? companyButtons(st, lg, 6) : [];
  const kb: Any[][] = st.awaiting === "dur"
    ? [[btn("⚡ Экспресс — до 2,5 ч", "d:120")], [btn("🔥 Долгая — больше 2,5 ч", "d:180")], [btn("Ещё паримся", "d:0")]]
    // цену спрашиваем по шагам — своя клавиатура на каждый шаг, без остальных кнопок карточки
    : priceStep === "sched"
    ? [[btn("Будни", "pw:weekday"), btn("Выходной", "pw:weekend")], [btn("Скидка до часа…", "pkb")], [btn("Одна цена", "pw:any")], [btn("Пропустить", "pz")]]
    : priceStep === "before"
    ? [...chunk(BEFORE_HOURS.map((h) => btn(`${h}:00`, `pb:${h}`)), 3), [btn("Пропустить", "pz")]]
    : priceStep === "currency"
    ? [...chunk(CUR_BTNS.map(([c, l]) => btn(l, `pc:${c}`)), 2), [btn("Пропустить", "pz")]]
    : [...pick, ...(askType ? [Object.entries(TYPE_BTN).map(([t, l]) => btn(`${st.type === t ? "✓ " : ""}${l}`, `t:${t}`))] : []),
      // цена этой бани уже стоит по истории — кнопка только чтобы поменять, если в этот раз другая
      ...(st.priceFromHistory ? [[btn("✏️ Изменить цену входа", "pe")]] : []),
      // истории нет — спрашиваем по шагам (будни/выходной/скидка/валюта), потом цифру ответом на карточку
      ...(st.price == null && !st.priceFromHistory ? [[btn("💰 Цена", "ap")]] : []),
      ...(st.beerFromHistory ? [[btn("✏️ Изменить цену пива", "be")]] : []),
      ...((st.price != null || st.priceFromHistory) && st.beerPrice == null && !st.beerFromHistory && st.awaitPriceFor !== "beer" ? [[btn("🍺 Пиво", "ab")]] : []),
      // будни/выходной у цены — необязательная кнопка, как и тип бани (если уже пришли по шагам — не переспрашиваем)
      ...(askSched ? [Object.entries(SCHED_RU).map(([s, l]) => btn(`${st.priceWeekend === s ? "✓ " : ""}${l}`, `pw:${s}`))] : []),
      // экспресс или долгая — выбор виден прямо на кнопках (галочка), как у типа бани
      [btn(`${st.dur == null || st.dur <= LONG ? "✓ " : ""}⚡ Экспресс`, "d:120"), btn(`${st.dur != null && st.dur > LONG ? "✓ " : ""}🔥 Долгая`, "d:180")],
      [btn("✅ В Комиссию", "send")], pick.length ? [btn("🏠 Баня", "eb")] : [btn("🏠 Баня", "eb"), btn("👥 Компания", "ec")], [btn("✖️ Отмена", "x")]];
  return { text: `${who}, всё верно?\n\n${lines.join("\n")}`, kb };
}

// кнопки с никами (✓ — уже в компании): выбранные и подсказанные; одно незнакомое имя и один выбранный кнопкой —
// предлагаем запомнить кличку
function companyButtons(st: Any, lg: Any, max: number): Any[][] {
  const name = (id: string) => lg.players.find((p: Any) => p.id === id)?.nick;
  const ids = [...new Set([...(st.company ?? []), ...(st.suggest ?? [])])].filter(name).slice(0, max);
  const rows: Any[][] = chunk(ids.map((id) => btn(`${(st.company ?? []).includes(id) ? "✓ " : ""}${name(id)}`, `cp:${id}`)), 3);
  if (st.unknown?.length === 1 && st.picked?.length === 1 && name(st.picked[0])) {
    rows.push([btn(`💾 «${st.unknown[0]}» — это ${name(st.picked[0])}, запомнить`.slice(0, 60), "al")]);
  }
  return rows;
}

async function showCard(st: Any, lg: Any, tgId: number) {
  if ((st.bathId || st.newBath) && st.dup === undefined) st.dup = await alreadyMarked(st);
  if ((st.bathId || st.newBath) && (st.companyOk === false || st.picking) && !st.suggest) st.suggest = await companySuggestions(st, lg);
  // цена этой бани уже известна (с сайта или от бота) — ставим сразу, а не спрашиваем: как в прошлый раз. Если в этот
  // раз другая — «✏️ Изменить», без этого набирать цену вручную каждый поход было бы лишним трением. Цен может быть
  // несколько сразу (будни/выходной/скидка до часа) — тогда st.price не выбираем за автора, показываем все
  if (st.bathId && st.price == null && st.knownPrices === undefined) {
    st.knownPrices = await allKnownPrices("bath_prices", st.bathId);
    if (st.knownPrices.length) {
      st.priceFromHistory = true;
      if (st.knownPrices.length === 1) { st.price = st.knownPrices[0].price; st.currency = st.knownPrices[0].currency; }
    }
  }
  const priceKnown = st.price != null || st.priceFromHistory;
  if (st.bathId && priceKnown && st.beerPrice == null && st.knownBeerPrices === undefined) {
    st.knownBeerPrices = await allKnownPrices("bath_beer_prices", st.bathId);
    if (st.knownBeerPrices.length) {
      st.beerFromHistory = true;
      if (st.knownBeerPrices.length === 1) { st.beerPrice = st.knownBeerPrices[0].price; if (st.currency == null) st.currency = st.knownBeerPrices[0].currency; }
    }
  }
  if (st.hasPhotos) st.photos = await draftPhotos(tgId, st.source);
  const { text, kb } = await renderCard(st, lg);
  st.hint = null;   // подсказка — только к этому ответу
  if (st.card) await edit(st.chat, st.card, text, kb);
  else {
    const r = await send(st.chat, text, kb, st.chatType === "private" ? undefined : st.source);
    if (r.ok) st.card = r.result.message_id;
  }
  await setState(tgId, st);
}

// ---------- цифра цены: в личке у автора ----------
// Кнопки мастера цены — правки карточки; а цифру (вход, пиво) спрашиваем у автора в личке, чтобы не грузить чат.
// Писать первым бот может тем, кто разрешил (вход на сайте просит это разрешение) или сам ему писал; не вышло —
// спрашиваем в чате ответом на карточку («личка закрыта — спрашиваю тут») и после ответа этот вопрос удаляем.
// Черновик и так в личке — цифру просим строкой в карточке.
async function askPrice(st: Any, what: "price" | "beer") {
  st.awaitPriceFor = what;
  st.priceInDm = false;
  if (st.chatType === "private") return;
  const q = what === "price" ? `сколько стоил вход в «${esc(st.bathName ?? "баню")}»${esc(schedLabel(st))}?` : `сколько стоило пиво в «${esc(st.bathName ?? "бане")}»?`;
  const dm = await send(st.author, `${what === "price" ? "💰" : "🍺"} ${q[0].toUpperCase()}${q.slice(1)} Напиши цифру — поставлю в карточку поста в чате.`);
  if (dm.ok) { st.priceInDm = true; return; }
  await dropPriceAsk(st, false);
  const g = await tg("sendMessage", {
    chat_id: st.chat, text: `Личка закрыта — спрашиваю тут: ${q} Ответь цифрой.`, parse_mode: "HTML",
    reply_markup: { force_reply: true, selective: true }, reply_parameters: { message_id: st.card, allow_sending_without_reply: true },
  });
  if (g.ok) st.awaitPriceMsg = g.result.message_id;
}
// вопрос о цене закрыт: убираем его из чата (если спрашивали там)
async function dropPriceAsk(st: Any, clear = true) {
  if (st?.awaitPriceMsg && st.chatType !== "private") await tg("deleteMessage", { chat_id: st.chat, message_id: st.awaitPriceMsg });
  st.awaitPriceMsg = null;
  if (clear) { st.awaitPriceFor = null; st.priceInDm = false; }
}
function priceAskLine(st: Any, label: string) {
  if (st.chatType === "private") return `${label}? Напиши цифру.`;
  return st.priceInDm ? `${label} — спросил в личке, ответь там цифрой.` : `${label} — ответь цифрой на вопрос ниже.`;
}
// цифра пришла в личку, а черновик — в чате: ставим её в черновик и правим карточку там
async function priceFromDm(msg: Any, st: Any, lg: Any) {
  const n = Number((msg.text ?? "").trim());
  if (st.awaitPriceFor === "price") st.price = n; else st.beerPrice = n;
  await dropPriceAsk(st);
  await react(msg.chat.id, msg.message_id, "👍");
  return showCard(st, lg, msg.from.id);
}

// черновик закрыли, не отправив: в группе карточку удаляем совсем — «Черновик отменён.» оставался в чате мусором (30.09);
// в личке (и если удалить не вышло: Telegram даёт боту удалять свои сообщения 48 часов) — правим карточку этой строкой
async function dropCard(st: Any, text: string) {
  await dropPriceAsk(st);
  if (!st?.card) return;
  if (st.chatType !== "private" && (await tg("deleteMessage", { chat_id: st.chat, message_id: st.card })).ok) return;
  return edit(st.chat, st.card, text);
}

async function resolveBath(st: Any) {
  if (!st.query) { st.candidates = []; return; }
  const found = await findBaths(st.query);
  // одна уверенная находка без «УУ» — берём сразу: в названии все слова из поста и баню не выбирают заново кнопкой «🏠 Баня»;
  // иначе показываем найденное и «новая» (30.09 «Гостиница Къуанч, Чегет» сама стала «поляной Чегет, Поворот»)
  if (!st.ultra && !st.choosing && found.length === 1 && found[0].full) { st.bathId = found[0].id; st.bathName = found[0].name; st.bathType = found[0].type ?? null; st.candidates = []; return; }
  if (st.ultra && !found.length) { st.newBath = st.query; st.bathName = st.query; st.candidates = []; return; }
  st.candidates = found.map((b: Any) => ({ id: b.id, name: b.name, region: b.region, type: b.type ?? null }));
}

// новый пост с отметкой бота — новый черновик
async function startDraft(msg: Any, me: Any, lg: Any, note?: string) {
  const text: string = msg.text ?? msg.caption ?? "";
  const entities = msg.entities ?? msg.caption_entities ?? [];
  const d = parseDuration(text);
  const comp = parseCompany(text, entities, lg, me.id);
  const st: Any = {
    chat: msg.chat.id, chatType: msg.chat.type, chatUsername: msg.chat.username ?? null, source: msg.message_id, posted: msg.date,
    author: msg.from.id, authorId: me.id, authorNick: me.nick,
    dur: d && d.dur >= 60 ? d.dur : null, start: d?.start ?? null, company: comp.ids,
    // компания известна, если в посте есть попутчики или «один»; иначе спросим кнопками (не пишем молча «один»)
    companyOk: comp.ids.length > 0 || ALONE_IN_POST.test(text), unknown: comp.unknown,
    ultra: ULTRA.test(text), type: typeFromText(text), query: bathQuery(text.replace(/\/banya(@\w+)?/i, " "), d?.span ?? null, comp.used),
  };
  // цену и пиво в посте не ищем — бот спрашивает их сам в карточке (кнопками)
  st.priceWeekend = scheduleFromText(text);
  st.priceBefore = beforeTimeFromText(text);
  st.geo = await pointFromMessage(msg);
  if (note) st.hint = note;
  await dropDraftPhotos(msg.from.id);   // новый пост — новый черновик: фото прошлого, неотправленного, не нужны
  if (msg.photo) {
    st.hasPhotos = !!(await addPhoto(msg, me.id, { draft: msg.message_id }));
    // остальные фото альбома идут отдельными сообщениями следом — даём им лечь, чтобы карточка показала все
    if (msg.media_group_id) await sleep(2000);
  }
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

// страна и регион по точке — в написании Комиссии («Кировская обл»); уже заполненное не трогаем (см. _shared/place.ts)
const placeFor = (p: { lat: number; lng: number }, have: Any = {}) => placeByPoint(sb, p, have);

// Дозаполнить страну и регион у бань с точной точкой, где их тогда не узнали (геокодер не ответил): pg_cron
// ebl-fill-places каждые 5 минут берёт тех, кого пора спросить (bath_place_tries: через 5 мин, 30 мин, 2 ч, 6 ч, дальше раз
// в сутки), и вручную — ?fillplaces=dry показывает, что проставится, ничего не записывая; &id=<баня> — одну, без очереди.
// Примерные точки (город/область из таблицы Комиссии) не трогаем: регион у старых бань — решение Комиссии.
async function fillPlaces(dry: boolean, id?: number) {
  let q = sb.from("baths").select("id, name, lat, lng, country, region").neq("status", "rejected")
    .eq("precision", "exact").not("lat", "is", null).or("country.is.null,region.is.null");
  if (id) q = q.eq("id", id);
  const { data: all } = await q.order("id").limit(200);
  // по расписанию — только те, кого пора спросить; вручную (dry или id) — все
  const { data: tries } = await sb.from("bath_place_tries").select("bath_id, tries, next_at");
  const tr = new Map((tries ?? []).map((t: Any) => [t.bath_id, t]));
  const due = (b: Any) => dry || id || !tr.get(b.id) || new Date((tr.get(b.id) as Any).next_at).getTime() <= Date.now();
  const rows = (all ?? []).filter(due).slice(0, id || dry ? 20 : 5);   // по расписанию — по 5 за раз: геокодер не чаще раза в секунду
  const out: Any[] = [];
  for (const b of rows) {
    const place = await placeFor({ lat: b.lat, lng: b.lng }, b);
    const done = !!(b.country || place.country) && !!(b.region || place.region);
    if (!dry) {
      const n = ((tr.get(b.id) as Any)?.tries ?? 0) + 1;
      if (done) await sb.from("bath_place_tries").delete().eq("bath_id", b.id);
      else await sb.from("bath_place_tries").upsert({ bath_id: b.id, tries: n, next_at: new Date(Date.now() + placeBackoff(n)).toISOString() });
    }
    if (Object.keys(place).length) {
      out.push({ id: b.id, name: b.name, ...place });
      if (!dry) {
        await sb.from("baths").update(place).eq("id", b.id);
        // регион появился — пометка «не определён» у Комиссии больше не нужна: обновляем её уведомления по этой бане
        const { data: vs } = await sb.from("bot_notifications").select("visit_id, visits!inner(bath_id)").eq("visits.bath_id", b.id);
        for (const vid of new Set((vs ?? []).map((x: Any) => x.visit_id as number))) await refreshVisit(vid);
      }
    }
    await sleep(1100);   // геокодер OpenStreetMap — не чаще раза в секунду
  }
  // регион или страна появились — очки за новый регион/страну (п. 14) пересчитываем сразу
  if (!dry && out.length) await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);
  return { dry, filled: out, left: rows.length - out.length };
}
// через сколько спросить геокодер снова после n-й неудачной попытки по расписанию: первая — в ≤ 5 минут после точки,
// дальше ~30 минут, ~2 часа, ~6 часов после неё и потом раз в сутки
function placeBackoff(n: number) {
  return [25 * 60e3, 90 * 60e3, 4 * 3600e3][n - 1] ?? 24 * 3600e3;
}

// ответ на карточку — дополняем черновик
async function continueDraft(msg: Any, st: Any, me: Any, lg: Any) {
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  if (msg.photo) {
    const id = await addPhoto(msg, me.id, { draft: st.source });
    if (id) st.hasPhotos = true;
    if (isPhotoOnly(text)) {
      // альбом — пачка сообщений: карточку перерисовывает последнее фото пачки и по свежему черновику
      if (msg.media_group_id) {
        await sleep(1500);
        const { data: last } = await sb.from("visit_photos").select("id").eq("tg_from", msg.from.id).eq("draft_msg", st.source)
          .is("visit_id", null).order("id", { ascending: false }).limit(1).maybeSingle();
        const fresh = await getState(msg.from.id);
        if (!id || last?.id !== id || fresh?.source !== st.source) return;
        st = { ...fresh, hasPhotos: true };
      }
      st.hint = "📷 Фото приложу к походу — на сайте они будут в карточке бани.";
      return showCard(st, lg, msg.from.id);
    }
  }
  const hasBath = !!(st.bathId || st.newBath);
  const needsCompany = st.companyOk === false || !!st.picking;
  const dupOpen = !!(st.dup && !st.dupOk);
  // «да» на «всё верно?» — отправляем, как кнопкой; черновик забираем удалением, как в sendDraft
  if (CONFIRM.test(text)) {
    if (hasBath && !st.awaiting && !needsCompany && !dupOpen) {
      const { data: taken } = await sb.from("bot_sessions").delete().eq("tg_id", msg.from.id).select("state");
      return taken?.length ? submit(taken[0].state, lg, msg.from.id) : undefined;
    }
    st.hint = !hasBath ? "👉 Сначала баня — выбери из списка или напиши название."
      : dupOpen ? "👉 Сначала ответь кнопкой: это другой поход или тот же."
      : st.awaiting === "dur" ? "👉 Долгая или экспресс? Выбери кнопкой ниже."
      : "👉 Сначала отметь, кто был в бане, — или «🙋 Один».";
    return showCard(st, lg, msg.from.id);
  }
  const snap = () => JSON.stringify([st.bathId, st.newBath, st.query, st.dur, st.company, st.geo, st.awaiting, st.companyOk]);
  const before = snap();
  const geo = await pointFromMessage(msg);
  if (geo) st.geo = geo;
  if (text) {
    // ответ про компанию: бот спрашивал «кто был?» (кнопками или «👥 Компания») или прямо «один»
    if (ALONE.test(text) || st.awaiting === "company" || (hasBath && needsCompany)) {
      const c = ALONE.test(text) ? null : parseCompany(text, msg.entities ?? [], lg, me.id);
      // пока бот ждёт компанию, время тоже могут дописать словами
      const d = c ? parseDuration(text) : null;
      if (d && d.dur >= 60) { st.dur = d.dur; st.start = d.start ?? st.start; if (st.awaiting === "dur") st.awaiting = null; }
      if (!c) { st.company = []; if (hasBath) st.hint = "👌 Понял — один. Если всё верно, жми «✅ В Комиссию» или ответь «да»."; }
      else if (c.ids.length) st.company = [...new Set([...(st.company ?? []), ...c.ids])];
      if (c?.unknown.length) st.unknown = c.unknown;
      if (!c || c.ids.length) { st.companyOk = true; st.picking = false; st.awaiting = null; }
      else if (!d) st.hint = "🤔 Не нашёл таких участников — выбери кнопкой или напиши ник как в таблице.";
    } else if (!hasBath && !hasLocationHint(text)) {
      st.query = bathQuery(text, null, new Set()); st.ultra = st.ultra || ULTRA.test(text);
      bathChanged(st);
      await resolveBath(st);
    } else {
      const d = parseDuration(text);
      // время написали словами вместо кнопок — вопрос «Сколько парились?» закрыт
      if (d && d.dur >= 60) { st.dur = d.dur; st.start = d.start ?? st.start; if (st.awaiting === "dur") st.awaiting = null; }
      const c = parseCompany(text, msg.entities ?? [], lg, me.id);
      if (c.ids.length) { st.company = [...new Set([...(st.company ?? []), ...c.ids])]; st.companyOk = true; st.picking = false; }
      // ответ на явный вопрос о цене — просто цифра; бот знает, чего именно ждёт (awaitPriceFor — после шагов
      // будни/скидка/валюта или кнопки «Пиво»), иначе это другая цифра взамен «как в прошлый раз»
      if (/^\d{2,5}$/.test(text)) {
        if (st.awaitPriceFor === "price" && st.price == null) { st.price = Number(text); await dropPriceAsk(st); }
        else if (st.awaitPriceFor === "beer" && st.beerPrice == null) { st.beerPrice = Number(text); await dropPriceAsk(st); }
      }
      if (st.priceWeekend == null) st.priceWeekend = scheduleFromText(text);
      if (st.priceBefore == null) st.priceBefore = beforeTimeFromText(text);
    }
  }
  // ответ ничего не поменял — без подсказки карточка осталась бы прежней, и казалось бы, что бот молчит
  if (!st.hint && snap() === before) {
    st.hint = "🤔 Не понял ответ. Если всё верно — жми «✅ В Комиссию» или ответь «да»; поправить — кнопками ниже.";
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
  await dropPriceAsk(st);   // вопрос о цене в чате (личка была закрыта) больше не нужен
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
  } else entered = posted;   // баню отмечают сразу после входа — заход и есть время поста (раньше вычитали длительность: сдвиг на 2–3 ч)
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
  // фото черновика (и досланные альбомом) — в поход
  const photos = st.hasPhotos ? ((await sb.from("visit_photos").update({ visit_id: visit.id, draft_msg: null })
    .eq("tg_from", tgId).eq("draft_msg", st.source).is("visit_id", null).select("id")).data?.length ?? 0) : 0;
  if (st.geo && st.bathId) await setBathPoint(st.bathId, st.geo, lg.players.find((p: Any) => p.id === st.authorId)?.is_commission);
  // тип бани со слов автора — только если он не был размечен; ошибся — Комиссия поправит в карточке бани
  if (st.bathId && st.type) await sb.from("baths").update({ type: st.type }).eq("id", st.bathId).is("type", null);
  // цена со слов автора — в историю бани, как если бы её занесли на сайте (участнику верим, отдельно не проверяем)
  if (st.price) await recordPrice("bath_prices", bathId, st.price, st.currency,
    { duration_min: null, is_weekend: st.priceWeekend === "weekend" ? true : st.priceWeekend === "weekday" ? false : null, before_time: st.priceBefore ?? null }, st.authorId);
  if (st.beerPrice) await recordPrice("bath_beer_prices", bathId, st.beerPrice, st.currency, {}, st.authorId);
  await sb.from("bot_posts").insert({ visit_id: visit.id, chat_id: st.chat, source_msg: st.source, card_msg: st.card, bath_id: bathId });

  const nicks = (st.company ?? []).map((id: string) => lg.players.find((p: Any) => p.id === id)?.nick).filter(Boolean);
  const summary = `🧖 <b>${esc(st.bathName)}</b>${st.newBath ? " · 🆕 кандидат в УУ" : ""}\n⏱ ${durLabel(st.dur)}\n👥 ${nicks.length ? esc(nicks.join(", ")) : "один"}`
    + photoLine(photos)
    + (st.type && !st.bathType ? `\n🏷 ${TYPE_RU[st.type]} — со слов автора` : "")
    + (st.price ? `\n💰 ${st.price} ${curLabel(st.currency)}${schedLabel(st)}` : "")
    + (st.beerPrice ? `\n🍺 ${st.beerPrice} ${curLabel(st.currency)}` : "")
    + repeatLine(await sameDayRepeat(visit.id));
  // статус «ушло в Комиссию» — всегда; персональное приветствие (если есть) — строкой ниже, а не вместо
  const greeting = greetLine(st.authorNick);
  const cardText = `Ушло в Комиссию ✅ <b>${esc(st.authorNick)}</b>${greeting ? `\n<i>${esc(greeting)}</i>` : ""}\n\n${summary}`;
  // точки на карте нет или она примерная — просьба прямо в карточке (необязательная), а не отдельным сообщением
  const { data: bath } = await sb.from("baths").select("lat, precision").eq("id", bathId).single();
  const needGeo = !!st.card && (bath?.lat == null || bath?.precision !== "exact");
  await sb.from("bot_posts").update({ card_text: cardText, ...(needGeo ? { geo_msg: st.card, geo_at: new Date().toISOString() } : {}) }).eq("visit_id", visit.id);
  if (!(await refreshCard(visit.id)) && st.card) await edit(st.chat, st.card, cardText);
  // 👀 — и на пост, и на карточку «Ушло в Комиссию»
  if (st.chatType !== "private") { await react(st.chat, st.source, "👀"); await react(st.chat, st.card, "👀"); }
  // пасхалки — отдельным сообщением, не в самой карточке (её потом ещё правят решением Комиссии); на настоящей
  // цене бани (последняя запись в bath_prices), а не на догадке из этого поста — у новой бани цены ещё нет
  const { data: cp } = await sb.from("bath_prices").select("price").eq("bath_id", bathId).order("price_date", { ascending: false }).limit(1).maybeSingle();
  const jokes = jokesFor(st, cp?.price ?? null);
  if (jokes.length) await send(st.chat, jokes.join("\n"), undefined, st.chatType === "private" ? undefined : st.source);

  const commission = lg.accounts.filter((a: Any) => a.tg_id && lg.players.find((p: Any) => p.id === a.player_id)?.is_commission);
  const note = `🔔 Поход от <b>${esc(st.authorNick)}</b>${link ? ` · <a href="${link}">пост</a>` : ""}\n\n${summary}` + await placeNote(bathId);
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

// п. 5: вторая баня в ту же баню за те же сутки (МСК) не засчитывается. Возвращает ники тех из похода,
// у кого в эти сутки в этой бане уже есть более ранний живой поход, — для них этот поход очков не даст
async function sameDayRepeat(visitId: number): Promise<string[]> {
  const { data: v } = await sb.from("visits").select("id, bath_id, entered_at, visit_players(player_id)").eq("id", visitId).maybeSingle();
  if (!v) return [];
  const t = new Date(v.entered_at).getTime(), m = new Date(t + 3 * 3600e3);
  const from = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), m.getUTCDate()) - 3 * 3600e3;
  const people = (v.visit_players ?? []).map((x: Any) => x.player_id);
  if (!people.length) return [];
  const { data: others } = await sb.from("visits").select("id, entered_at, visit_players!inner(player_id)")
    .eq("bath_id", v.bath_id).neq("status", "rejected").neq("id", visitId)
    .gte("entered_at", new Date(from).toISOString()).lt("entered_at", new Date(from + 864e5).toISOString())
    .in("visit_players.player_id", people);
  const ids = new Set<string>();
  for (const o of others ?? []) {
    const ot = new Date(o.entered_at).getTime();
    if (ot < t || (ot === t && o.id < v.id)) for (const p of o.visit_players ?? []) ids.add(p.player_id);
  }
  if (!ids.size) return [];
  const { data: ps } = await sb.from("players").select("nick").in("id", [...ids]);
  return (ps ?? []).map((p: Any) => p.nick);
}
// движок повтор сам не срезает (баню могли кинуть за прошлый день) — это подсказка Комиссии проверить дату
const repeatLine = (names: string[]) => names.length ? `\n⚠️ Похоже на повтор: у ${esc(names.join(", "))} в эти сутки уже есть поход в эту баню. Комиссия проверит дату (п. 5)` : "";

// ---------- живая карточка ----------
// Всё, что бот сообщает по походу после «В Комиссию», — правкой карточки и реакциями, а не новыми сообщениями:
// чат лиги не захламляется (просьба лиги 27.09). Карточка — из частей в bot_posts: основа, просьба о точке,
// «Долгая была?», ответ на него, решение Комиссии. Ответ на вопрос — ответом на саму карточку или кнопкой.
const GEO_ASK = "📍 Точной точки на карте нет — ответь на эту карточку ссылкой из Яндекс/Google Карт, адресом или геопозицией. Необязательно.";
const GEO_RETRY = "📍 Не нашёл, где это. Ответь на карточку ссылкой, где на карте видна точка, адресом с номером дома или геопозицией.";
async function refreshCard(visitId: number, geoRetry = false): Promise<boolean> {
  const { data: p } = await sb.from("bot_posts").select("chat_id, card_msg, card_text, geo_msg, ask_msg, long_note, verdict_text").eq("visit_id", visitId).maybeSingle();
  if (!p?.card_msg || !p.card_text) return false;
  const parts = [p.card_text], kb: Any[][] = [];
  if (p.geo_msg && p.geo_msg === p.card_msg) { parts.push(geoRetry ? GEO_RETRY : GEO_ASK); kb.push([btn("🙅 Без точки", `gx:${visitId}`)]); }
  if (p.ask_msg && p.ask_msg === p.card_msg && !p.long_note) { parts.push("⏳ Прошло 2,5 часа — долгая была, больше 2,5 ч?"); kb.push(LONG_KB(visitId)[0]); }
  if (p.long_note) parts.push(p.long_note);
  if (p.verdict_text) parts.push(p.verdict_text);
  await edit(p.chat_id, p.card_msg, parts.join("\n\n"), kb);
  return true;
}
// строка решения Комиссии с очками — для карточки и для личек Комиссии
async function verdictLine(visitId: number): Promise<string | null> {
  const { data: v } = await sb.from("visits").select("status, reject_reason, judge:players!visits_moderated_by_fkey(nick)").eq("id", visitId).maybeSingle();
  if (!v || !["ok", "rejected"].includes(v.status)) return null;
  const judge = (v as Any).judge?.nick ? ` — ${esc((v as Any).judge.nick)}` : "";
  if (v.status !== "ok") return `💩 Не засчитано${judge}${v.reject_reason ? `. Причина: ${esc(v.reject_reason)}` : ""}. Если это ошибка — напишите Комиссии.`;
  const { data: pts } = await sb.from("visit_points").select("nick, total").eq("visit_id", visitId);
  return `👍 Засчитано${judge}${pts?.length ? ": " + pts.map((x: Any) => `${esc(x.nick)} +${x.total}`).join(" · ") : ""}`;
}

// ---------- поход поправили ----------
// Компания, баня, время или длительность поменялись (на сайте, кнопкой «долгая», в базе) — зовёт триггер: ?refresh=<id>.
// Сводку пересобираем из базы и обновляем в личках Комиссии и в карточке в чате: иначе там оставалось «👥 один».
async function summaryOf(visitId: number): Promise<string | null> {
  const { data: v } = await sb.from("visits").select("duration_min, source, long_asked_at, created_by, baths(name, type, status), visit_players(player_id, players(nick))")
    .eq("id", visitId).maybeSingle();
  if (!v) return null;
  const vv = v as Any;
  const company = (vv.visit_players ?? []).filter((x: Any) => x.player_id !== v.created_by).map((x: Any) => x.players?.nick).filter(Boolean).sort();
  // экспресс — время не указывали: бот ставит час и ещё не спрашивал про долгую
  const dur = v.source === "bot" && v.duration_min === 60 && !v.long_asked_at ? null : v.duration_min;
  return `🧖 <b>${esc(vv.baths?.name)}</b>${vv.baths?.status === "pending" ? " · 🆕 кандидат в УУ" : ""}\n⏱ ${durLabel(dur)}\n👥 ${company.length ? esc(company.join(", ")) : "один"}`
    + photoLine(await photoCount(visitId))
    + (vv.baths?.type ? `\n🏷 ${TYPE_RU[vv.baths.type]}` : "")
    + repeatLine(await sameDayRepeat(visitId));
}
// у бани нет страны или региона — Комиссии пометка в уведомлении: бонус за новый регион/страну (п. 14) без них не считается.
// Висит, пока их нет: повторы геокодера (fillPlaces: 5 мин, 30 мин, 2 ч, 6 ч, дальше раз в сутки) их проставят и уведомление обновится — пометка уйдёт. В чат не пишем.
const PLACE_NOTE = "\n\n🌍 Регион бани пока не определён — бонус за новый регион и страну посчитается, когда он появится.";
async function placeNote(bathId: number | null | undefined): Promise<string> {
  if (!bathId) return "";
  const { data: b } = await sb.from("baths").select("country, region").eq("id", bathId).maybeSingle();
  return b && (!b.country || !b.region) ? PLACE_NOTE : "";
}
async function refreshVisit(visitId: number): Promise<boolean> {
  const { data: v } = await sb.from("visits")
    .select("status, source, tg_link, reject_reason, bath_id, author:players!visits_created_by_fkey(nick), judge:players!visits_moderated_by_fkey(nick)").eq("id", visitId).maybeSingle();
  const summary = v ? await summaryOf(visitId) : null;
  if (!v || !summary) return false;
  const vv = v as Any, author = esc(vv.author?.nick);
  const note = (v.source === "site" ? `🔔 Поход с сайта от <b>${author}</b>` : `🔔 Поход от <b>${author}</b>${v.tg_link ? ` · <a href="${v.tg_link}">пост</a>` : ""}`)
    + `\n\n${summary}` + await placeNote(vv.bath_id);
  const decided = v.status === "ok" || v.status === "rejected";
  const verdict = decided ? `\n\n${v.status === "ok" ? "✅ Засчитано" : "❌ Отклонено"}${vv.judge?.nick ? ` — ${esc(vv.judge.nick)}` : ""}`
    + (v.status !== "ok" && v.reject_reason ? `\nПричина: ${esc(v.reject_reason)}` : "") : "";
  let changed = false;
  const { data: notes } = await sb.from("bot_notifications").select("chat_id, message_id, text").eq("visit_id", visitId);
  for (const n of notes ?? []) {
    if (n.text === note) continue;   // уже свежее
    await edit(n.chat_id, n.message_id, `${note}${verdict}`, decided ? undefined : [[btn("✅ Засчитать", `ok:${visitId}`), btn("❌ Отклонить", `no:${visitId}`)]]);
    await sb.from("bot_notifications").update({ text: note }).eq("visit_id", visitId).eq("chat_id", n.chat_id);
    changed = true;
  }
  // живая карточка в чате: шапка («Ушло в Комиссию ✅ …») остаётся, сводка под ней — свежая
  const { data: post } = await sb.from("bot_posts").select("card_text, verdict_text").eq("visit_id", visitId).maybeSingle();
  // решение с очками — тоже свежее: тип или регион бани поменяли, таблица пересчитана — очки другие
  const cardVerdict = post?.verdict_text ? await verdictLine(visitId) : null;
  const cut = post?.card_text ? post.card_text.indexOf("\n\n") : -1;
  const freshSummary = cut >= 0 && post!.card_text.slice(cut + 2) !== summary;
  if (freshSummary || (cardVerdict && cardVerdict !== post!.verdict_text)) {
    await sb.from("bot_posts").update({
      ...(freshSummary ? { card_text: `${post!.card_text.slice(0, cut)}\n\n${summary}` } : {}),
      ...(cardVerdict && cardVerdict !== post!.verdict_text ? { verdict_text: cardVerdict } : {}),
    }).eq("visit_id", visitId);
    await refreshCard(visitId);
    changed = true;
  }
  return changed;
}

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
    + (vv.baths?.type ? `\n🏷 ${TYPE_RU[vv.baths.type]}` : "")
    + repeatLine(await sameDayRepeat(visitId));
  if (chat) {
    const greeting = greetLine(author);
    const cardText = `🌐 <b>${esc(author)}</b> отметил баню на сайте${greeting ? `\n${greeting}` : ""}\n\n${summary}`;
    const r = await send(chat, `${cardText}\n\nЖдёт Комиссию 👀`);
    if (r.ok) {
      // это и пост похода, и его карточка: решение Комиссии допишется правкой, а не новым сообщением
      await sb.from("bot_posts").update({ source_msg: r.result.message_id, card_msg: r.result.message_id, card_text: cardText }).eq("visit_id", visitId);
      await react(chat, r.result.message_id, "👀");
    }
    if (vv.baths?.type === "spa") await send(chat, pick(SPA_JOKES));
  }
  const note = `🔔 Поход с сайта от <b>${esc(author)}</b>\n\n${summary}` + await placeNote(v.bath_id);
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
    .eq("visit_id", visitId).or(`announced.is.null,announced.neq.${v.status}`).select("chat_id, source_msg, card_msg, card_text");
  let post = won?.[0];
  if (!post && v.source === "site" && freshVerdict) {
    // поход с сайта: поста в группе нет — объявим отдельным сообщением в чате лиги (вставка строки — та же защита от повтора).
    // Только свежее решение: ?verdict=<id> открыт всем, и старые походы иначе можно было «переобъявить» в чат
    const chat = Number(await setting("league_chat"));
    if (!chat) return false;
    const { data: fresh } = await sb.from("bot_posts").insert({ visit_id: visitId, chat_id: chat, source_msg: 0, bath_id: v.bath_id, announced: v.status })
      .select("chat_id, source_msg, card_msg, card_text").maybeSingle();
    post = fresh ?? undefined;
  }
  if (!post) return false;
  const ok = v.status === "ok", vv = v as Any;
  if (ok) await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);

  const line = await verdictLine(visitId);
  const verdict = `${ok ? "✅ Засчитано" : "❌ Отклонено"}${vv.judge?.nick ? ` — ${esc(vv.judge.nick)}` : ""}`
    + (!ok && v.reject_reason ? `\nПричина: ${esc(v.reject_reason)}` : "");
  const { data: notes } = await sb.from("bot_notifications").select("chat_id, message_id, text").eq("visit_id", visitId);
  for (const n of notes ?? []) {
    if (n.text) await edit(n.chat_id, n.message_id, `${n.text}\n\n${verdict}`);
    else await tg("editMessageReplyMarkup", { chat_id: n.chat_id, message_id: n.message_id, reply_markup: { inline_keyboard: [] } });
  }

  // живая карточка: 👍/💩 на пост и карточку, решение с очками — правкой карточки, новых сообщений в чате нет
  if (post.card_msg && post.card_text) {
    await sb.from("bot_posts").update({ verdict_text: line }).eq("visit_id", visitId);
    if (post.source_msg && post.source_msg !== post.card_msg) await react(post.chat_id, post.source_msg, ok ? "👍" : "💩");
    await react(post.chat_id, post.card_msg, ok ? "👍" : "💩");
    await refreshCard(visitId);
    return true;
  }
  // старые походы (до живой карточки): реакция на пост и итог отдельным сообщением в ответ на пост
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

// ---------- заявки «это я» ----------
// Выбрал ник на сайте (зовёт триггер: ?claim=<id>) — Комиссии в личку с кнопками. Подтвердили кнопкой или на сайте
// (?linked=<id>) — уведомления гасим, а пост, который участник успел написать боту до подтверждения, становится карточкой.
const accountName = (a: Any) => `<b>${esc(a.tg_name || "без имени")}</b>${a.tg_username ? ` (@${esc(a.tg_username)})` : ""}`;
async function commissionChats(): Promise<number[]> {
  const lg = await league();
  return lg.accounts.filter((a: Any) => a.tg_id && lg.players.find((p: Any) => p.id === a.player_id)?.is_commission).map((a: Any) => a.tg_id);
}

async function claimNotice(accountId: string): Promise<boolean> {
  const { data: a } = await sb.from("player_accounts").select("id, tg_name, tg_username, claimed_nick, player_id").eq("id", accountId).maybeSingle();
  if (!a || a.player_id || !a.claimed_nick) return false;
  const { data: prev } = await sb.from("claim_notices").select("nick, messages").eq("account_id", accountId).maybeSingle();
  if (prev?.nick === a.claimed_nick) return false;   // об этой заявке уже написали — повторный вызов не спамит Комиссию
  for (const m of prev?.messages ?? []) await edit(m.chat, m.msg, `🙋 Заявка ${accountName(a)} изменилась — новая ниже.`);
  const { data: p } = await sb.from("players").select("id").eq("nick", a.claimed_nick).maybeSingle();
  const { data: others } = p ? await sb.from("player_accounts").select("tg_username, tg_name").eq("player_id", p.id) : { data: [] };
  const text = `🙋 Заявка «это я»\n${accountName(a)} выбирает ник <b>${esc(a.claimed_nick)}</b>. Привязать?`
    + (others?.length ? `\n\n⚠️ К этому нику уже привязан ${others.map((o: Any) => o.tg_username ? "@" + esc(o.tg_username) : esc(o.tg_name)).join(", ")}` : "");
  const messages: Any[] = [];
  for (const chat of await commissionChats()) {
    const r = await send(chat, text, [[btn("✅ Подтвердить", `cl:${a.id}`), btn("❌ Отказать", `cn:${a.id}`)]]);
    if (r.ok) messages.push({ chat, msg: r.result.message_id });
  }
  await sb.from("claim_notices").upsert({ account_id: a.id, nick: a.claimed_nick, messages });
  return true;
}

async function decideClaim(cq: Any, me: Any, accountId: string, ok: boolean) {
  if (!me?.is_commission) return answer(cq.id, "Это кнопка для Комиссии", true);
  const { data: n } = await sb.from("claim_notices").select("nick").eq("account_id", accountId).maybeSingle();
  if (!n) return answer(cq.id, "Заявка уже решена");
  const { data: p } = await sb.from("players").select("id").eq("nick", n.nick).maybeSingle();
  // только если заявка та же и ещё не решена: второй из Комиссии мог нажать одновременно (или решили на сайте)
  const { data: done } = await sb.from("player_accounts").update(ok ? { player_id: p?.id, claimed_nick: null } : { claimed_nick: null })
    .eq("id", accountId).is("player_id", null).eq("claimed_nick", n.nick).select("id");
  if (!done?.length || (ok && !p)) return answer(cq.id, "Заявка уже решена или изменилась");
  await answer(cq.id, ok ? `Привязан к ${n.nick}` : "Отказано");
  if (ok) return linked(accountId, me.nick);   // триггер в базе тоже позовёт — второй вызов ничего не сделает
  const { data: taken } = await sb.from("claim_notices").delete().eq("account_id", accountId).select("messages");
  for (const m of taken?.[0]?.messages ?? []) await edit(m.chat, m.msg, `🙋 Заявка «это ${esc(n.nick)}»\n\n❌ Отказано — ${esc(me.nick)}`);
  const { data: a } = await sb.from("player_accounts").select("tg_id").eq("id", accountId).maybeSingle();
  const stash = a?.tg_id ? await takeStash(a.tg_id) : null;
  const where = stash ? stash.chat.id : a?.tg_id;
  if (where) await send(where, `Комиссия не подтвердила, что ты — ${esc(n.nick)}. Выбери свой ник на сайте ещё раз: ${SITE}`, undefined, stash && stash.chat.type !== "private" ? stash.message_id : undefined);
}

// отложенный пост забираем удалением: кнопка и триггер могут прийти почти одновременно — достанется одному
async function takeStash(tgId: number) {
  const { data } = await sb.from("bot_sessions").delete().eq("tg_id", tgId).not("state->stash", "is", null).select("state");
  const st = data?.[0]?.state;
  return st?.stash && Date.now() - (st.ts ?? 0) < STASH_TTL ? st.stash : null;
}

async function linked(accountId: string, judge?: string): Promise<boolean> {
  const { data: a } = await sb.from("player_accounts").select("id, tg_id, tg_name, tg_username, players(id, nick, is_commission)").eq("id", accountId).maybeSingle();
  const me = (a as Any)?.players;
  if (!a || !me) return false;
  const { data: taken } = await sb.from("claim_notices").delete().eq("account_id", accountId).select("messages");
  for (const m of taken?.[0]?.messages ?? []) {
    await edit(m.chat, m.msg, `🙋 ${accountName(a)} — это <b>${esc(me.nick)}</b>\n\n✅ Подтверждено — ${judge ? esc(judge) : "на сайте"}`);
  }
  const stash = a.tg_id ? await takeStash(a.tg_id) : null;
  if (stash) {
    await startDraft(stash, me, await league(), "✅ Комиссия подтвердила ник — теперь я тебя знаю. Проверь поход и жми «✅ В Комиссию».");
  } else if (taken?.length && a.tg_id) {
    await send(a.tg_id, `✅ Комиссия подтвердила: ты — <b>${esc(me.nick)}</b>. Отмечай походы в чате лиги (отметь меня) или прямо здесь.`);
  }
  return !!(taken?.length || stash);
}

// ответ на вопрос про точку: геопозиция, ссылка с точкой, адрес или ссылка на карточку организации
async function geoAnswer(msg: Any, post: Any, me: Any) {
  const { data: b } = await sb.from("baths").select("id, name, lat, lng, precision").eq("id", post.bath_id).single();
  const loc = msg.location ?? msg.venue?.location;
  // найденный адрес сверяем с примерной точкой бани, чтобы не поставить точку в другом городе
  const near = b?.lat != null && b.precision !== "exact" ? { lat: b.lat, lng: b.lng } : null;
  const maxKm = { city: 80, region: 400, country: 1500 }[b?.precision as string] ?? 400;
  const p = loc ? { lat: loc.latitude, lng: loc.longitude } : await locate(msg.text ?? msg.caption ?? "", near, maxKm);
  // живая карточка — ответ реакцией и правкой карточки; у старых походов (вопрос отдельным сообщением) — как раньше
  const living = await refreshable(post.visit_id);
  if (!p) {
    if (living) { await react(msg.chat.id, msg.message_id, "🤔"); return refreshCard(post.visit_id, true); }
    return send(msg.chat.id, "Не нашёл, где это. Пришли ссылку, где на карте видна точка, адрес с номером дома или геопозицию (📎 → Геопозиция).",
      [[btn("🙅 Отстань", `gx:${post.visit_id}`)]], msg.message_id);
  }
  const done = await setBathPoint(post.bath_id, p, me.is_commission);
  await sb.from("bot_posts").update({ geo_msg: null }).eq("visit_id", post.visit_id);
  await react(msg.chat.id, msg.message_id, done ? "👍" : "👌");
  if (living) return refreshCard(post.visit_id);
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

// Долгая — на доверии: одно «долгая» от любого из компании делает поход долгим, ошибки правит Комиссия.
// Отметить можно в любой момент до 8 часов после захода — хоть сразу («долгая будет»); позже — только Комиссия на сайте.
const LONG_STRANGER = "Это для тех, кто был в походе";
const LONG_LATE = "Прошло больше 8 часов с захода — долгую теперь отмечает Комиссия на сайте";
const LONG_MAX = 8 * 3600e3;
async function markLong(visitId: number, me: Any): Promise<"ok" | "stranger" | "late"> {
  const { data: vp } = await sb.from("visit_players").select("player_id").eq("visit_id", visitId).eq("player_id", me?.id ?? "").maybeSingle();
  if (!vp) return "stranger";
  const { data: v } = await sb.from("visits").select("duration_min, status, entered_at").eq("id", visitId).single();
  const since = Date.now() - new Date(v.entered_at).getTime();
  if (since > LONG_MAX) return "late";
  if (v.duration_min <= LONG) await sb.from("visits").update({ duration_min: LONG + 1 }).eq("id", visitId);
  if (v.status === "ok") await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);
  return "ok";
}

// ответ участника под вопросом «Долгая была?» — по строке на ответ; повторное нажатие ничего не дописывает (null)
function withLongAnswer(text: string, line: string): string | null {
  const lines = text.split("\n");
  if (lines.includes(line)) return null;
  const answered = lines.some((l) => /: (долгая 🔥|обычная|экспресс)$/u.test(l));
  return `${text}${answered ? "\n" : "\n\n"}${line}`;
}

// ответ текстом на «Долгая была?» — кнопки удобнее, но «да»/«нет» тоже понимаем
async function longAnswer(msg: Any, post: Any, me: Any, claimed = false) {
  const text = (msg.text ?? "").trim();
  const living = await refreshable(post.visit_id);
  if (claimed || isLongClaim(text) || /^(да|ага|угу|конечно|yes|\+)(?![\p{L}\p{N}])/iu.test(text)) {
    const res = await markLong(post.visit_id, me);
    if (res !== "ok") return send(msg.chat.id, longRefusal(res, null), undefined, msg.message_id);
    await react(msg.chat.id, msg.message_id, "🔥");
    if (living) return noteLong(post.visit_id, `🔥 Долгая — ответ: ${esc(me.nick)}, +1 всей компании`, true);
    return send(msg.chat.id, `🔥 ${esc(me.nick)}: долгая — +1 всей компании.`, undefined, msg.message_id);
  }
  if (/^(нет|не|обычная|экспресс|no|-)(?![\p{L}\p{N}])/iu.test(text)) {
    await react(msg.chat.id, msg.message_id, "👌");
    return living ? noteLong(post.visit_id, `⚡ Экспресс — ответ: ${esc(me.nick)}`, false) : undefined;
  }
  if (living) return react(msg.chat.id, msg.message_id, "🤔");
  return send(msg.chat.id, "Нажми кнопку под вопросом: долгая или обычная.", undefined, msg.message_id);
}
// у похода живая карточка (после 27.09) — отвечаем правкой, у старых — как раньше
const refreshable = async (visitId: number) =>
  !!(await sb.from("bot_posts").select("card_msg, card_text").eq("visit_id", visitId).maybeSingle()).data?.card_text;
// ответ на «Долгая была?» — строкой в карточке: «да» от любого из компании главнее «нет»; очки в решении — пересчитанные
async function noteLong(visitId: number, line: string, long: boolean) {
  const { data: p } = await sb.from("bot_posts").select("long_note, verdict_text").eq("visit_id", visitId).maybeSingle();
  if (!long && p?.long_note) return;   // «нет» после ответа ничего не меняет
  const verdict = p?.verdict_text ? await verdictLine(visitId) : null;
  await sb.from("bot_posts").update({ long_note: line, ...(verdict ? { verdict_text: verdict } : {}) }).eq("visit_id", visitId);
  return refreshCard(visitId);
}

// «долгая» сам по себе (отметили бота) — это про свой последний поход за 8 часов (давнее — только Комиссия).
// Ответ — 🔥 на сообщение и строка в карточке похода.
const LONG_FILLER = new Set(("была был было были будет буду будем это у меня нас мы я отметь отметьте отметить отмечаю засчитай пжл пожалуйста плиз пж " +
  "планирую собираюсь сидим сидеть сидим паримся надолго " +
  "получилась вышла кстати сегодня баня баньку парились парился посидели сидели вроде точно ура ну да").split(" "));
function isLongClaim(text: string) {
  const t = norm(text.replace(CALL, " "));
  if (!/долг(ая|ий|ую|ой|о|ие)(?![\p{L}])/u.test(t)) return false;
  // кроме слов про долгую и связок — ничего: иначе это новый пост про баню («Сандуны долгая с Деном»)
  return t.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !/^долг/.test(w) && !LONG_FILLER.has(w)).length === 0;
}
// в ответе на карточку своего похода хватит слова «долгая»: «Долгая — куда про неё писать?» — это про долгую
// (30.09 Ден так и написал, бот промолчал); «не долгая», «нет, не долгая» — нет
const LONG_WORD = /(^|[^\p{L}])долг(ая|ий|ую|ой|о|ие)(?![\p{L}])/iu;
const LONG_NOT = /(^|[^\p{L}])(не|нет|ни)[\s,]+(был[аио]?\s+)?долг/iu;
function longInReply(text: string) {
  const t = norm(text);
  return LONG_WORD.test(t) && !LONG_NOT.test(t) && !/^\s*нет(?![\p{L}])/iu.test(t);
}
function longRefusal(res: string, since: number | null) {
  if (res === "late") return LONG_LATE;
  return `${LONG_STRANGER} 🙂`;
}
async function claimLong(msg: Any, me: Any) {
  const { data: mine } = await sb.from("visit_players").select("visit_id, visits!inner(entered_at, status)").eq("player_id", me.id)
    .neq("visits.status", "rejected").gte("visits.entered_at", new Date(Date.now() - 24 * 3600e3).toISOString());
  const recent = (mine ?? []).map((x: Any) => ({ id: x.visit_id, at: new Date(x.visits.entered_at).getTime() })).sort((a: Any, b: Any) => b.at - a.at);
  const target = recent.find((v: Any) => Date.now() - v.at <= LONG_MAX) ?? recent[0];
  if (!target) return send(msg.chat.id, "Не нашёл твоего похода за последние сутки — сначала отметь баню.", undefined, msg.chat.type === "private" ? undefined : msg.message_id);
  const res = await markLong(target.id, me);
  if (res !== "ok") return send(msg.chat.id, longRefusal(res, Date.now() - target.at), undefined, msg.chat.type === "private" ? undefined : msg.message_id);
  await react(msg.chat.id, msg.message_id, "🔥");
  if (await refreshable(target.id)) await noteLong(target.id, `🔥 Долгая — ответ: ${esc(me.nick)}, +1 всей компании`, true);
  if (msg.chat.type === "private") return send(msg.chat.id, "🔥 Отметил долгую — +1 всей компании.");
}

// ---------- «@eblany» — позвать всех ----------
// Кто угодно в группе пишет «@eblany» и текст (можно и с отметкой бота) — бот отвечает на это сообщение: «📣 Ебланы, общий сбор!»,
// ссылка на него и отметки всех, кого знает в чате (chat_members), кроме автора. Текст автора не повторяем — он в ответе выше.
// Сообщение участника бот не правит: чужие сообщения в группах Telegram не даёт править никому.
// Не чаще раза в 10 минут на чат — чаще это спам (отметку видят даже те, у кого чат без звука).
// Имена тех, у кого Telegram не привязан к нику, бот спрашивает у Telegram (getChatMember) и запоминает. Telegram на частые
// вопросы отвечает «подожди» (429) — тогда отправляем сразу, а имена дозаполняем фоном и правим своё сообщение (rollcalls):
// отметки уже дошли, правка повторно никого не будит.
const EBLANY = /(^|[^\p{L}\p{N}_@])@eblany(?![\p{L}\p{N}_])/iu;
const ROLLCALL_GAP = 10 * 60e3;
const ROLLCALL_CHUNK = 50;   // отметок в одном сообщении; больше — следующим сообщением
const NO_NAME = "участник";  // имя ещё не узнали — отметка всё равно дойдёт

// имя участника чата у Telegram: строка — имя, false — его в чате нет (вышел, бот), null — не ответил.
// patient — ждём, сколько Telegram просит (до 5 с за раз), и спрашиваем снова; иначе одна попытка
async function memberName(chat: number, id: number, patient: boolean): Promise<string | false | null> {
  for (let i = 0; i < (patient ? 4 : 1); i++) {
    const r = await tg("getChatMember", { chat_id: chat, user_id: id });
    if (r.ok) return ["left", "kicked"].includes(r.result?.status) || r.result?.user?.is_bot ? false : r.result?.user?.first_name ?? null;
    if (r.error_code !== 429) {
      await sb.from("bot_log").insert({ kind: "error", detail: `getChatMember: ${r.error_code ?? "нет ответа"} ${r.description ?? ""}`.slice(0, 300) });
      return null;
    }
    if (patient) await sleep(Math.min(r.parameters?.retry_after ?? 1, 5) * 1000);
  }
  return null;
}

// текст сбора по частям (по ROLLCALL_CHUNK отметок); missing — сколько имён ещё не узнали
async function rollCallParts(rc: Any, patient: boolean): Promise<{ parts: string[]; missing: number }> {
  const lg = await league();
  const nickOf = new Map<number, string>();   // у кого Telegram привязан к нику лиги — отмечаем ником
  for (const a of lg.accounts) {
    const nick = lg.players.find((p: Any) => p.id === a.player_id)?.nick;
    if (a.tg_id && nick) nickOf.set(Number(a.tg_id), nick);
  }
  const { data: known } = await sb.from("chat_members").select("tg_id, name").eq("chat_id", rc.chat_id).order("added_at");
  const links: string[] = [];
  let missing = 0;
  const until = Date.now() + 100e3;   // фоновое дозаполнение — не дольше 100 с, остальное в следующий раз
  for (const m of known ?? []) {
    const id = Number(m.tg_id);
    if (id === Number(rc.author_tg)) continue;
    let name: string | false | null = nickOf.get(id) ?? m.name;
    if (!name && Date.now() < until) {
      name = await memberName(rc.chat_id, id, patient);
      if (name === false) { await sb.from("chat_members").delete().eq("chat_id", rc.chat_id).eq("tg_id", id); continue; }
      if (name) await sb.from("chat_members").update({ name }).eq("chat_id", rc.chat_id).eq("tg_id", id);
      if (patient) await sleep(300);   // не частим — иначе Telegram снова попросит подождать
    }
    if (!name) missing++;
    links.push(`<a href="tg://user?id=${id}">${esc(name || NO_NAME)}</a>`);
  }
  const link = postLink({ id: rc.chat_id, username: rc.chat_username }, rc.reply_to);
  const head = `📣 <b>Ебланы, общий сбор!</b>${link ? ` <a href="${link}">→ к сообщению</a>` : ""}`;
  return { parts: chunk(links, ROLLCALL_CHUNK).map((p, i) => `${i === 0 ? `${head}\n\n` : ""}${p.join(", ")}`), missing };
}

async function rollCall(msg: Any) {
  const chat = msg.chat.id;
  const { data: recent } = await sb.from("rollcalls").select("id").eq("chat_id", chat)
    .gte("at", new Date(Date.now() - ROLLCALL_GAP).toISOString()).limit(1);
  if (recent?.length) return react(chat, msg.message_id, "🥱");
  const { data: rc } = await sb.from("rollcalls")
    .insert({ chat_id: chat, chat_username: msg.chat.username ?? null, reply_to: msg.message_id, author_tg: msg.from.id }).select().single();
  if (!rc) return;
  const { parts, missing } = await rollCallParts(rc, false);
  if (!parts.length) return send(chat, "Некого звать: я пока не знаю участников этого чата.", undefined, msg.message_id);
  const msgs: number[] = [];
  for (const text of parts) {
    const r = await send(chat, text, undefined, msg.message_id);
    if (r.ok) msgs.push(r.result.message_id);
  }
  await sb.from("rollcalls").update({ msgs }).eq("id", rc.id);
  // не все имена узнали — дозаполняем фоном и правим сообщение, вебхук при этом отвечает сразу
  if (missing) later(rollFix(rc.id));
}

// поправить свой сбор: имена, которые узнали позже (зовёт сам сбор фоном; ?rollfix=<id> — вручную, безопасно повторять)
async function rollFix(id: number): Promise<boolean> {
  const { data: rc } = await sb.from("rollcalls").select("*").eq("id", id).maybeSingle();
  if (!rc?.msgs?.length) return false;
  const { parts } = await rollCallParts(rc, true);
  for (let i = 0; i < Math.min(parts.length, rc.msgs.length); i++) await edit(rc.chat_id, rc.msgs[i], parts[i]);
  return true;
}
// фоновая работа после ответа вебхуку (в Supabase Edge — EdgeRuntime.waitUntil)
function later(p: Promise<unknown>) {
  const rt = (globalThis as Any).EdgeRuntime;
  const safe = p.catch((e) => console.error("tg-bot later", e));
  if (rt?.waitUntil) rt.waitUntil(safe);
}

// кто вошёл в чат и вышел — чтобы «@eblany» звал тех, кто сейчас в чате (номер и имя, больше ничего)
async function trackMembers(msg: Any) {
  const chat = msg.chat.id;
  const joined = (msg.new_chat_members ?? []).filter((u: Any) => !u.is_bot);
  if (joined.length) await sb.from("chat_members").upsert(joined.map((u: Any) => ({ chat_id: chat, tg_id: u.id, name: u.first_name ?? null })));
  if (msg.left_chat_member && !msg.left_chat_member.is_bot) await sb.from("chat_members").delete().eq("chat_id", chat).eq("tg_id", msg.left_chat_member.id);
}

// ---------- фото ----------
// Бот только записывает, какое фото к какому походу (visit_photos); файл в бакет Яндекса перекачивает функция photos.
// Telegram хранит фото в нескольких размерах и уже без метаданных (GPS): берём самый большой до 1600 px и превью от 320 px.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function photoOf(msg: Any) {
  const side = (s: Any) => Math.max(s.width, s.height);
  const sizes = [...(msg.photo ?? [])].sort((a: Any, b: Any) => side(a) - side(b));
  if (!sizes.length) return null;
  const big = [...sizes].reverse().find((s: Any) => side(s) <= 1600) ?? sizes[0];
  const small = sizes.find((s: Any) => side(s) >= 320) ?? big;
  return { tg_file_id: big.file_id, tg_unique_id: big.file_unique_id, tg_thumb_id: small.file_id, w: big.width, h: big.height };
}
// фото — в поход или в черновик (draft — номер поста, с которого он начался); то же фото второй раз не кладём
async function addPhoto(msg: Any, playerId: string, to: { visitId?: number | null; draft?: number | null }): Promise<number | null> {
  const p = photoOf(msg);
  if (!p) return null;
  const { data } = await sb.from("visit_photos").upsert({
    ...p, visit_id: to.visitId ?? null, draft_msg: to.visitId ? null : to.draft ?? null, added_by: playerId, source: "bot",
    tg_from: msg.from.id, tg_album: msg.media_group_id ?? null,
  }, { onConflict: "tg_unique_id", ignoreDuplicates: true }).select("id").maybeSingle();
  return data?.id ?? null;
}
const photoLine = (n: number) => (n ? `\n📷 ${n} фото` : "");
const photoCount = async (visitId: number) =>
  (await sb.from("visit_photos").select("id", { count: "exact", head: true }).eq("visit_id", visitId).eq("hidden", false)).count ?? 0;
const draftPhotos = async (tgId: number, draft: number) =>
  (await sb.from("visit_photos").select("id", { count: "exact", head: true }).eq("tg_from", tgId).eq("draft_msg", draft).is("visit_id", null)).count ?? 0;
function dropDraftPhotos(tgId: number) { return sb.from("visit_photos").delete().eq("tg_from", tgId).is("visit_id", null); }

// альбом — пачка отдельных сообщений почти одновременно: карточку правим один раз, последним фото пачки
async function lastOfBurst(id: number | null, visitId: number) {
  if (!id) return false;
  await sleep(1500);
  const { data } = await sb.from("visit_photos").select("id").eq("visit_id", visitId).order("id", { ascending: false }).limit(1).maybeSingle();
  return data?.id === id;
}

// фото альбома без подписи. Подпись с отметкой бота — у соседнего фото того же отправителя: оно уже в походе или черновике.
// Сообщения альбома приходят вперемешку — ждём соседа пару секунд; не нашёлся — фото не нам, ничего не храним.
async function albumPhoto(msg: Any) {
  for (let i = 0; i < 3; i++) {
    const { data: sib } = await sb.from("visit_photos").select("visit_id, draft_msg, added_by")
      .eq("tg_album", msg.media_group_id).eq("tg_from", msg.from.id).limit(1).maybeSingle();
    if (sib) {
      const id = await addPhoto(msg, sib.added_by, { visitId: sib.visit_id, draft: sib.draft_msg });
      if (sib.visit_id && await lastOfBurst(id, sib.visit_id)) await refreshVisit(sib.visit_id);
      return;
    }
    await sleep(1500);
  }
}

// фото ответом на карточку похода — в этот поход. Класть фото может только тот, кто был в походе
async function photoToVisit(msg: Any, visitId: number, me: Any) {
  const { data: vp } = await sb.from("visit_players").select("player_id").eq("visit_id", visitId).eq("player_id", me.id).maybeSingle();
  if (!vp) return react(msg.chat.id, msg.message_id, "🤔");
  const id = await addPhoto(msg, me.id, { visitId });
  await react(msg.chat.id, msg.message_id, "👍");
  if (await lastOfBurst(id, visitId)) await refreshVisit(visitId);
}

// последний свой поход за сутки (кроме отклонённых)
async function recentVisit(playerId: string) {
  const { data } = await sb.from("visit_players").select("visit_id, visits!inner(entered_at, status, baths(name))").eq("player_id", playerId)
    .neq("visits.status", "rejected").gte("visits.entered_at", new Date(Date.now() - 24 * 3600e3).toISOString());
  const v = (data ?? []).sort((a: Any, b: Any) => String(b.visits.entered_at).localeCompare(String(a.visits.entered_at)))[0] as Any;
  return v ? { id: v.visit_id as number, bath: v.visits.baths?.name as string } : null;
}

// фото в личку или «@бот» с фото без бани в подписи — к своему последнему походу за сутки.
// В группе — только 👍 и строка в карточке похода; в личке — одно подтверждение на пачку
async function photoToRecent(msg: Any, me: Any) {
  const priv = msg.chat.type === "private";
  const v = await recentVisit(me.id);
  if (!v) {
    // альбом — пачка сообщений: на каждое фото отвечать текстом — спам, хватит реакции
    if (msg.media_group_id && !msg.caption) return react(msg.chat.id, msg.message_id, "🤔");
    return send(msg.chat.id, "Не нашёл твоего похода за последние сутки — фото приложи к посту, когда отмечаешь баню.", undefined, priv ? undefined : msg.message_id);
  }
  const id = await addPhoto(msg, me.id, { visitId: v.id });
  await react(msg.chat.id, msg.message_id, "👍");
  if (!(await lastOfBurst(id, v.id))) return;
  await refreshVisit(v.id);
  if (priv) await send(msg.chat.id, `📷 Приложил к походу в «${esc(v.bath)}». Фото в нём: ${await photoCount(v.id)}.`);
}

// подпись к фото — только «фото», «вот», отметка бота: значит, бани в ней нет и это фото к уже отмеченному походу
const PHOTO_FILLER = new Set(("фото фотка фотки фоточки фоточка фотографии фотографию фотография фотос фоты пикчи " +
  "вот держи лови ещё еще немного пару пара к с из в бани баньки бане походу похода сегодня").split(" "));
function isPhotoOnly(text: string) {
  const t = norm(text.replace(CALL, " "));
  return t.split(/[^\p{L}\p{N}]+/u).filter((w) => w && !PHOTO_FILLER.has(w)).length === 0;
}

// ---------- клички ----------
// в личке с ботом: «клички» — список (всем участникам); «кличка Мамонтов = Ден», «убери кличку Мамонтов» — Комиссия
async function aliasCommand(chat: number, text: string, me: Any) {
  const lg = await league();
  const nickOf = (id: string) => lg.players.find((p: Any) => p.id === id)?.nick ?? "?";
  if (/^клички$/iu.test(text)) {
    const list = lg.aliases.map((a: Any) => `${esc(a.alias)} — ${esc(nickOf(a.player_id))}`).sort((a: string, b: string) => a.localeCompare(b, "ru"));
    return send(chat, list.length ? `Клички:\n${list.join("\n")}` : "Кличек пока нет.");
  }
  if (!me.is_commission) return send(chat, "Клички добавляет Комиссия. А в карточке похода выбери человека кнопкой — предложу запомнить, как ты его назвал.");
  const del = /^(?:убери|удали) кличку\s+(.+)$/iu.exec(text);
  if (del) {
    const al = lg.aliases.find((a: Any) => norm(a.alias) === norm(del[1].trim()));
    if (!al) return send(chat, `Клички «${esc(del[1].trim())}» нет.`);
    await sb.from("player_aliases").delete().eq("alias", al.alias);
    return send(chat, `Убрал кличку «${esc(al.alias)}».`);
  }
  const add = /^кличка\s+(.+?)\s*=\s*(.+)$/iu.exec(text) ?? /^кличка\s+(.+?)\s+(?:—|–|-|это)\s+(.+)$/iu.exec(text);
  if (!add) return send(chat, "Так: «кличка Мамонтов = Ден». Убрать: «убери кличку Мамонтов». Все клички: «клички».");
  const alias = add[1].trim(), p = lg.players.find((x: Any) => norm(x.nick) === norm(add[2].trim()));
  if (!p) return send(chat, `Не знаю участника «${esc(add[2].trim())}» — напиши ник как в таблице.`);
  if (lg.players.some((x: Any) => norm(x.nick) === norm(alias))) return send(chat, `«${esc(alias)}» — это ник участника, кличкой быть не может.`);
  const { error } = await sb.from("player_aliases").insert({ alias, player_id: p.id, added_by: me.id });
  return send(chat, error ? `Кличка «${esc(alias)}» уже есть — сначала «убери кличку ${esc(alias)}».` : `💾 Запомнил: «${esc(alias)}» — это ${esc(p.nick)}.`);
}

// ---------- обработчики ----------
const mentionsBot = (msg: Any) => {
  const text: string = msg.text ?? msg.caption ?? "";
  const ents = msg.entities ?? msg.caption_entities ?? [];
  return ents.some((e: Any) => (e.type === "mention" && text.substr(e.offset + 1, e.length - 1).toLowerCase() === BOT)
    || (e.type === "bot_command" && /^\/banya/i.test(text.substr(e.offset, e.length)))
    // «#баня» — то же, что отметить бота: в подписи к фото Telegram не подсказывает ники, а хэштег набирается руками
    || (e.type === "hashtag" && HASHTAG.test(text.substr(e.offset, e.length))));
};
const HASHTAG = /^#бан(я|ька)$/iu;
const CALL = new RegExp(`@${BOT}|/banya(@\\w+)?|#бан(я|ька)(?![\\p{L}\\p{N}_])`, "giu");   // всё, чем зовут бота — из текста убираем

const HOWTO = `Отмечайте походы прямо здесь — отметьте меня (или начните с #баня) и напишите как есть:\n<i>@${BOT} Сандуны 3ч с Деном</i>\n`
  + `<i>#баня Сандуны 3ч с Деном</i> — удобно в подписи к фото, там Telegram не подсказывает ники\n\n`
  + "Не хватит чего-то — переспрошу. Отмечайте сразу, как зашли. Долгая (больше 2,5 ч) — отметьте меня или напишите в личку «долгая», можно сразу, в течение 8 часов. "
  + `Поход уйдёт в Комиссию, после решения на посте появится 👍 или 💩.\nТаблица и карта: ${SITE}`;

async function onMessage(msg: Any) {
  const chat = msg.chat.id, tgId = msg.from?.id, isPrivate = msg.chat.type === "private";
  // бота добавили в группу — здороваемся и показываем, как отмечать походы
  if (msg.new_chat_members?.some((u: Any) => u.is_bot && u.username?.toLowerCase() === BOT)) {
    return send(chat, `Привет, ЕБЛ! 🧖\n\n${HOWTO}`);
  }
  if (msg.new_chat_members || msg.left_chat_member) return trackMembers(msg);
  if (!tgId || msg.from.is_bot) return;
  const text: string = (msg.text ?? msg.caption ?? "").trim();
  // позвать всех — не пост про баню, даже с отметкой бота
  if (EBLANY.test(text)) return isPrivate ? send(chat, "Общий сбор — в чате лиги: напиши там «@eblany» и текст.") : rollCall(msg);
  const replyTo = msg.reply_to_message?.message_id;

  // ответ на «Долгая была?» или на просьбу прислать точку
  if (replyTo && msg.reply_to_message.from?.username?.toLowerCase() === BOT) {
    // у живой карточки оба вопроса — сама карточка: ссылка, адрес или геопозиция — это про точку, остальное — про долгую
    const { data: post } = await sb.from("bot_posts").select("visit_id, chat_id, bath_id, ask_msg, geo_msg, card_msg, long_note").eq("chat_id", chat)
      .or(`ask_msg.eq.${replyTo},geo_msg.eq.${replyTo},card_msg.eq.${replyTo}`).limit(1).maybeSingle();
    if (post) {
      const acc = await whoIs(tgId);
      if (!acc?.players) return;
      // фото ответом на карточку — в этот поход (с подписью «долгая» — и долгая тоже)
      if (msg.photo && post.card_msg === replyTo) {
        await photoToVisit(msg, post.visit_id, acc.players);
        if (!isLongClaim(text)) return;
      }
      const geoish = !!(msg.location || msg.venue) || /https?:\/\//.test(text) || looksLikeAddress(text) || hasLocationHint(text);
      // «долгая» ответом на карточку похода — долгая этого похода; ссылка, адрес, геопозиция — точка бани
      if (post.geo_msg === replyTo && post.bath_id && geoish) return geoAnswer(msg, post, acc.players);
      const claimed = post.card_msg === replyTo && longInReply(text);
      if (claimed || isLongClaim(text) || post.ask_msg === replyTo) return longAnswer(msg, post, acc.players, claimed);
      if (post.geo_msg === replyTo && post.bath_id) return geoAnswer(msg, post, acc.players);
      if (post.card_msg === replyTo) return;   // просто ответили на карточку — не нам
    }
  }

  const saved = await getState(tgId);
  const st = saved && !saved.stash && Date.now() - (saved.ts ?? 0) < DRAFT_TTL ? saved : null;   // отложенный пост — не черновик
  // ответ на карточку (awaitPriceMsg — отдельный вопрос о цене у черновиков до 30.09, пока они живы)
  const replyToCard = st && st.chat === chat && (isPrivate || (replyTo && (replyTo === st.card || replyTo === st.awaitPriceMsg)));
  if (!isPrivate && !mentionsBot(msg) && !replyToCard) {
    await implicitAnswer(msg);   // вдруг это ответ на вопрос бота без «Ответить»
    return;                      // остальное в группе — не нам
  }

  const acc = await whoIs(tgId);
  const me = acc?.players as Any;
  if (!me) {
    // ник ещё ждёт Комиссию — пост про баню запоминаем (он адресован боту), после подтверждения он станет карточкой похода
    const aboutBath = text.replace(CALL, "").trim().length > 2 && !/^\/|^(start|привет|хай|hi|hello)$/iu.test(text);
    if (acc?.claimed_nick && aboutBath) {
      await setState(tgId, { stash: {
        chat: { id: chat, type: msg.chat.type, username: msg.chat.username ?? null }, message_id: msg.message_id, date: msg.date, from: { id: tgId },
        text: msg.text, caption: msg.caption, entities: msg.entities, caption_entities: msg.caption_entities, location: msg.location, venue: msg.venue,
        photo: msg.photo,
      } });
      await claimNotice(acc.id);   // заявка старая и Комиссии о ней не писали — пишем сейчас (о той же заявке второй раз не пишет)
      return send(chat, `Заявка «это ${esc(acc.claimed_nick)}» ждёт Комиссию. Пост запомнил: как подтвердят ник, вернусь с карточкой похода.`,
        undefined, isPrivate ? undefined : msg.message_id);
    }
    return send(chat, acc?.claimed_nick
      ? `Заявка «это ${esc(acc.claimed_nick)}» ждёт Комиссию — как подтвердят, можно отмечать походы.`
      : `Чтобы отмечать походы, войди на сайте через Telegram и выбери свой ник: ${SITE}`, undefined, isPrivate ? undefined : msg.message_id);
  }
  const greeting = /^(\/start|\/help|start|старт|привет|хай|hi|hello)(?![\p{L}\p{N}])/iu.test(text);
  if (isPrivate && greeting) {
    await clearState(tgId);
    return send(chat, `Привет, ${esc(me.nick)}! ${HOWTO}\n\nЗдесь, в личке, тоже можно — просто напиши, где парился.`);
  }
  if (text === "/cancel" || text === `/cancel@${BOT}`) {
    await clearState(tgId);
    if (isPrivate) return send(chat, "Черновик отменён.");
    if (st?.card && st.chat === chat) await dropCard(st, "Черновик отменён.");
    return react(chat, msg.message_id, "👌");   // в группе — без нового сообщения
  }
  if (isPrivate && /^(кличк|убери кличку|удали кличку)/iu.test(text)) return aliasCommand(chat, text, me);
  // «долгая» / «долгая была» — в личке боту или с отметкой в чате: это про свой последний поход, а не новая баня
  // (в личке с открытым черновиком — это ответ на черновик: continueDraft поймёт «долгая» как время)
  if (isLongClaim(text) && (isPrivate || mentionsBot(msg)) && !(replyToCard && st)) return claimLong(msg, me);
  // фото в личку или с одной отметкой бота, без бани в подписи, — к своему последнему походу за сутки
  if (msg.photo && (isPrivate || mentionsBot(msg)) && !(replyToCard && st) && isPhotoOnly(text)) return photoToRecent(msg, me);
  if (text.startsWith("/") && !/^\/banya/i.test(text)) return;   // прочие команды — не походы
  // цифра цены в личку — ответ на вопрос из черновика в чате (askPrice)
  if (isPrivate && st?.priceInDm && st.awaitPriceFor && st.chat !== chat && /^\d{2,6}$/.test(text)) return priceFromDm(msg, st, await league());

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
  if (data.startsWith("cl:") || data.startsWith("cn:")) return decideClaim(cq, me, data.slice(3), data.startsWith("cl:"));
  if (data.startsWith("gx:")) {
    if (!me) return answer(cq.id, "Кнопка для участников лиги");
    // просто закрываем этот вопрос: больше не ждём ответа на него
    const vid = Number(data.slice(3));
    await sb.from("bot_posts").update({ geo_msg: null }).eq("visit_id", vid);
    await answer(cq.id, "Ок, без точки — её можно поставить потом на сайте");
    if (await refreshable(vid)) return refreshCard(vid);
    return edit(cq.message.chat.id, cq.message.message_id, `🙅 Ок, без точки. Её можно поставить потом на сайте: ${SITE}`);
  }
  if (data.startsWith("yl:")) {
    const vid = Number(data.slice(3));
    const res = await markLong(vid, me);
    if (res !== "ok") return answer(cq.id, res === "late" ? LONG_LATE : LONG_STRANGER, res === "late");
    await answer(cq.id, "🔥 Долгая — +1 всей компании");
    if (await refreshable(vid)) return noteLong(vid, `🔥 Долгая — ответ: ${esc(me.nick)}, +1 всей компании`, true);
    return noteLongAnswer(cq, vid, `${me.nick}: долгая 🔥`);
  }
  if (data.startsWith("nl:")) {
    const vid = Number(data.slice(3));
    const { data: vp } = await sb.from("visit_players").select("player_id").eq("visit_id", vid).eq("player_id", me?.id ?? "").maybeSingle();
    if (!vp) return answer(cq.id, LONG_STRANGER);
    await answer(cq.id, "Ок, экспресс");
    if (await refreshable(vid)) return noteLong(vid, `⚡ Экспресс — ответ: ${esc(me.nick)}`, false);
    return noteLongAnswer(cq, vid, `${me.nick}: экспресс`);
  }
  const st = await getState(tgId);
  if (!st && data === "send") return answer(cq.id, "Уже отправлено");
  if (!st || st.card !== cq.message?.message_id || st.chat !== cq.message?.chat?.id) {
    return answer(cq.id, "Это черновик другого участника — отметь бота в своём посте", true);
  }
  if (data === "send" && (st.companyOk === false || st.picking)) return answer(cq.id, "Сначала отметь, кто был в бане, или нажми «🙋 Один»", true);
  if (data === "send" && st.dup && !st.dupOk) return answer(cq.id, "Сначала ответь: это другой поход или тот же", true);
  if (data === "send") return sendDraft(cq, tgId);
  await answer(cq.id);
  const lg = await league();
  if (data === "x") { await clearState(tgId); return dropCard(st, "Черновик отменён."); }
  if (data === "dx") {
    // поход уже есть — фото из этого поста прикладываем к нему
    const moved = st.hasPhotos && st.dup?.id ? ((await sb.from("visit_photos").update({ visit_id: st.dup.id, draft_msg: null })
      .eq("tg_from", tgId).eq("draft_msg", st.source).is("visit_id", null).select("id")).data?.length ?? 0) : 0;
    await clearState(tgId);
    if (moved) await refreshVisit(st.dup.id);
    const tail = moved ? `\n📷 ${moved} фото приложил к нему.` : "";
    if (st.chatType !== "private") await react(st.chat, st.source, "👌");   // в группе — только реакция на пост, карточку убираем
    return dropCard(st, (st.dup?.mine ? "👌 Ок, второй раз не отмечаю." : `👌 Ок — поход у тебя уже есть в посте <b>${esc(st.dup?.by)}</b>.`) + tail);
  }
  if (data === "do") st.dupOk = true;
  else if (data.startsWith("cp:") && lg.players.some((p: Any) => p.id === data.slice(3))) {
    const id = data.slice(3), comp: string[] = st.company ?? [], picked: string[] = st.picked ?? [];
    st.company = comp.includes(id) ? comp.filter((x) => x !== id) : [...comp, id];
    st.picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    st.companyOk = st.company.length > 0;
  } else if (data === "al" && st.unknown?.length === 1 && st.picked?.length === 1) {
    const alias = st.unknown[0], nick = lg.players.find((p: Any) => p.id === st.picked[0])?.nick;
    const { error } = await sb.from("player_aliases").insert({ alias, player_id: st.picked[0], added_by: st.authorId });
    st.hint = error ? `Кличка «${esc(alias)}» уже занята — поменять её может Комиссия.` : `💾 Запомнил: «${esc(alias)}» — это ${esc(nick)}. В следующий раз узнаю сам.`;
    if (!error) st.unknown = [];
  } else if (data === "c1") { st.company = []; st.companyOk = true; st.picking = false; st.awaiting = null; }
  else if (data === "cd" && (st.company ?? []).length) { st.companyOk = true; st.picking = false; st.awaiting = null; }
  else if (data.startsWith("b:")) {
    const b = (st.candidates ?? []).find((c: Any) => c.id === Number(data.slice(2)));
    if (b) { st.bathId = b.id; st.bathName = b.name; st.bathType = b.type ?? null; st.type = null; st.newBath = null; st.newBathId = null; st.candidates = []; bathChanged(st); }
  } else if (data === "nb") {
    st.newBath = st.query; st.bathName = st.query; st.bathId = null; st.newBathId = null; st.bathType = null; st.type = null; st.candidates = []; bathChanged(st);
  } else if (data === "eb") {
    // «🏠 Баня» — выбрать заново: список найденного и «новая», сами не выбираем (раньше тут же выбиралась та же баня — кнопка «не работала»)
    st.bathId = null; st.newBath = null; st.newBathId = null; st.bathName = null; st.bathType = null; st.type = null; bathChanged(st);
    st.choosing = true; await resolveBath(st);
  } else if (data.startsWith("t:") && TYPE_RU[data.slice(2)]) {
    st.type = data.slice(2);
  } else if (data.startsWith("pw:") && SCHED_RU[data.slice(3)]) {
    st.priceWeekend = data.slice(3);
    if (st.priceStep === "sched") st.priceStep = "currency";   // шаг «будни/выходной/одна цена» в мастере цены — дальше валюта
  } else if (data === "pe" && st.priceFromHistory) {
    // цена в этот раз другая — сбрасываем автоподстановку и заводим тот же мастер, что и без истории
    st.price = null; st.currency = null; st.priceFromHistory = false; st.priceWeekend = null; st.priceBefore = null;
    st.priceStep = "sched";
  } else if (data === "be" && st.beerFromHistory) {
    st.beerPrice = null; st.beerFromHistory = false; await askPrice(st, "beer");
  } else if (data === "ap" && st.price == null) {
    st.priceStep = "sched";   // мастер цены: истории нет — спрашиваем будни/выходной/скидку/валюту по шагам
  } else if (data === "pkb" && st.priceStep === "sched") {
    st.priceStep = "before";
  } else if (data.startsWith("pb:") && st.priceStep === "before" && BEFORE_HOURS.includes(Number(data.slice(3)))) {
    st.priceBefore = `${data.slice(3).padStart(2, "0")}:00`;
    st.priceStep = "currency";
  } else if (data === "pz") {
    st.priceStep = null; st.priceWeekend = null; st.priceBefore = null;   // пропустили мастер цены — можно начать заново кнопкой
  } else if (data.startsWith("pc:") && st.priceStep === "currency" && CUR_BTNS.some(([c]) => c === data.slice(3))) {
    st.currency = data.slice(3) === "RUB" ? null : data.slice(3);
    st.priceStep = null;
    await askPrice(st, "price");   // последний шаг мастера — цифру спрашиваем в личке у автора (закрыта — в чате)
  } else if (data === "ab" && (st.price != null || st.priceFromHistory) && st.beerPrice == null) {
    await askPrice(st, "beer");
  } else if (data === "ed") st.awaiting = "dur";
  else if (data === "ec") { st.picking = true; st.awaiting = "company"; }
  else if (data.startsWith("d:")) { const m = Number(data.slice(2)); st.dur = m || null; st.start = null; st.awaiting = null; }
  return showCard(st, lg, tgId);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // решение Комиссии принято не кнопкой бота — зовёт триггер в базе; объявляет только настоящий статус и только один раз
  if (url.searchParams.get("new")) {
    return new Response(JSON.stringify({ notified: await siteVisit(Number(url.searchParams.get("new"))) }), { headers: { "Content-Type": "application/json" } });
  }
  if (url.searchParams.get("verdict")) {
    return new Response(JSON.stringify({ announced: await announce(Number(url.searchParams.get("verdict"))) }), { headers: { "Content-Type": "application/json" } });
  }
  // поход поправили — зовёт триггер на visits/visit_players; сайт меняет компанию несколькими запросами — ждём, пока закончит
  if (url.searchParams.get("refresh")) {
    await new Promise((r) => setTimeout(r, 1500));
    return new Response(JSON.stringify({ refreshed: await refreshVisit(Number(url.searchParams.get("refresh"))) }), { headers: { "Content-Type": "application/json" } });
  }
  // у бани поменяли название, тип, регион или страну (триггер baths_notify_changed): пересчитать таблицу и обновить
  // сообщения бота о свежих походах в неё — сводку (тип) и строку решения (очки)
  if (url.searchParams.get("bath")) {
    const bathId = Number(url.searchParams.get("bath"));
    await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);
    const { data: vs } = await sb.from("visits").select("id, bot_posts!inner(visit_id)").eq("bath_id", bathId)
      .gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString());
    let n = 0;
    for (const v of vs ?? []) if (await refreshVisit(v.id)) n++;
    return new Response(JSON.stringify({ refreshed: n }), { headers: { "Content-Type": "application/json" } });
  }
  // действия по просьбе владельца из bot_actions (пишет только service_role): поменять реакцию на сообщении и т. п.
  if (url.searchParams.get("actions")) {
    const { data: rows } = await sb.from("bot_actions").select("*").is("done_at", null).order("id").limit(20);
    for (const a of rows ?? []) {
      // replace — реакция бота заменяет его прежнюю (🤔 → 👍)
      const r = a.kind === "react" ? await react(a.chat_id, a.message_id, a.emoji) : { ok: false, description: "неизвестное действие" };
      await sb.from("bot_actions").update({ done_at: new Date().toISOString(), result: r.ok ? "ok" : String(r.description ?? "нет ответа").slice(0, 200) }).eq("id", a.id);
    }
    return new Response(JSON.stringify({ done: (rows ?? []).length }), { headers: { "Content-Type": "application/json" } });
  }
  // дозаполнить страну и регион у бань с точной точкой (dry — только показать)
  const fp = url.searchParams.get("fillplaces");
  if (fp) return new Response(JSON.stringify(await fillPlaces(fp === "dry", Number(url.searchParams.get("id")) || undefined)), { headers: { "Content-Type": "application/json" } });
  // поправить общий сбор (имена, узнанные позже) — безопасно повторять: бот только пересобирает свой же ответ
  if (url.searchParams.get("rollfix")) {
    return new Response(JSON.stringify({ fixed: await rollFix(Number(url.searchParams.get("rollfix"))) }), { headers: { "Content-Type": "application/json" } });
  }
  // заявка «это я» и её подтверждение — зовёт триггер на player_accounts; оба вызова идемпотентны
  const uuid = (k: string) => /^[0-9a-f-]{36}$/i.test(url.searchParams.get(k) ?? "") ? url.searchParams.get(k)! : null;
  if (uuid("claim")) return new Response(JSON.stringify({ notified: await claimNotice(uuid("claim")!) }), { headers: { "Content-Type": "application/json" } });
  if (uuid("linked")) {
    // кнопка бота сама доводит подтверждение до конца (с именем того, кто решил) — триггер ждёт, чтобы не опередить её
    await new Promise((r) => setTimeout(r, 1500));
    return new Response(JSON.stringify({ done: await linked(uuid("linked")!) }), { headers: { "Content-Type": "application/json" } });
  }
  // диагностика без секретов: состояние вебхука у Telegram и последние записи журнала — только время и тип,
  // detail (данные кнопок, стек ошибки) наружу не отдаём: по нему видно, кто что решал
  if (url.searchParams.get("diag") === "1") {
    const [info, me] = await Promise.all([tg("getWebhookInfo", {}), tg("getMe", {})]);
    const { data: log } = await sb.from("bot_log").select("at, kind").order("id", { ascending: false }).limit(10);
    const r = info.result ?? {};
    return new Response(JSON.stringify({ pending: r.pending_update_count, last_error: r.last_error_message, last_error_at: r.last_error_date,
      allowed: r.allowed_updates, url_ok: r.url === `${BASE}/functions/v1/tg-bot`,
      // режим приватности выключен — бот видит все сообщения группы (без этого не дойдут «@бот …» и «@eblany»)
      reads_all: me.result?.can_read_all_group_messages ?? null, log }), { headers: { "Content-Type": "application/json" } });
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
  const text = m?.text ?? m?.caption ?? "";
  const addressed = !m || m.chat?.type === "private" || mentionsBot(m) || m.new_chat_members || m.left_chat_member
    || m.reply_to_message?.from?.username?.toLowerCase() === BOT || EBLANY.test(text);
  const maybeAnswer = m && (m.location || m.venue || /https?:\/\//.test(text) || looksLikeAddress(text));
  if (!addressed) {
    // фото альбома без подписи: подпись с отметкой бота могла быть у соседнего фото — возьмём, только если так и есть
    if (m?.photo && m.media_group_id && !text && m.from && !m.from.is_bot) { try { await albumPhoto(m); } catch (e) { console.error("tg-bot", e); } }
    else if (maybeAnswer) { try { await onMessage(m); } catch (e) { console.error("tg-bot", e); } }
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
