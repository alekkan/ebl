// Итоги недели в чат лиги: картинка-поздравление (пьедестал, бани, очки за места — как на странице недельного зачёта) и подпись.
//
// Неделя закрывается в воскресенье в 22:59 МСК (п. 6). Пост — один на неделю и только когда по закрытой неделе всё решено:
// нет походов на проверке у Комиссии и новых бань на согласовании. Черновики в боте не ждём (решение лиги 27.09).
// Не решено — ждём: pg_cron зовёт функцию каждые 5 минут (ebl-week-results), пост выйдет после последнего решения Комиссии.
// Окно — с 23:00 воскресенья до конца среды; старые недели в чат не вытаскиваем.
//
//   (без параметров)        — pg_cron: проверить и, если пора, запостить в чат лиги (settings.league_chat)
//   ?render=<неделя>         — картинка PNG (данные те же, что в открытой таблице на сайте)
//   ?dry=<неделя>            — JSON: места, очки и что ещё ждёт решения (для тестов)
//   ?preview=<tg_id>&week=<n> — пример в личку участнику Комиссии (не чаще раза в 2 минуты)
import { createClient } from "npm:@supabase/supabase-js@2";
import { initWasm, Resvg } from "npm:@resvg/resvg-wasm@2.6.2";
import { msk, placePoints, weekOf } from "../_shared/scoring.js";
import { GOLOS400, GOLOS700, UNBOUNDED700 } from "../_shared/fonts.ts";
import { HAT } from "./hat.ts";
import { NPM_CDN, TELEGRAM_API } from "../_shared/hosts.ts";

const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const BASE = Deno.env.get("SUPABASE_URL")!;
const SITE = (Deno.env.get("SITE_URL") ?? "https://ebl.su/").replace(/\/?$/, "/");
const sb = createClient(BASE, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const WASM = `${NPM_CDN}/@resvg/resvg-wasm@2.6.2/index_bg.wasm`;   // версия — как в import выше
// deno-lint-ignore no-explicit-any
type Any = any;

const setting = async (key: string) => (await sb.from("settings").select("value").eq("key", key).maybeSingle()).data?.value ?? null;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmt = (n: number) => (Math.round(n * 10) / 10).toLocaleString("ru-RU");
const plural = (n: number, a: string, b: string, c: string) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const baths = (n: number) => `${n} ${plural(n, "баня", "бани", "бань")}`;
const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { "Content-Type": "application/json" } });

// ---------- данные недели ----------
type Row = { nick: string; baths: number; pts: number; place: string; photo: string | null };
async function weekData(season: number, week: number) {
  const [{ data: st }, { data: ps }] = await Promise.all([
    sb.from("standings").select("nick, week_baths, week_pts"),
    sb.from("players").select("nick, photo_url"),
  ]);
  const photo = new Map((ps ?? []).map((p: Any) => [p.nick, p.photo_url]));
  const raw = (st ?? []).map((s: Any) => [s.nick, +(s.week_baths?.[String(week)] ?? 0), s.week_pts?.[String(week)]] as [string, number, number | undefined])
    .filter((r) => r[1] > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
  // очки за места — из таблицы (закрытая неделя) или по тем же правилам движка (п. 7), если неделя ещё идёт
  const calc = placePoints(raw.map((r) => [r[0], r[1]]));
  const rows: Row[] = [];
  for (let i = 0; i < raw.length;) {
    let j = i; while (j + 1 < raw.length && raw[j + 1][1] === raw[i][1]) j++;
    const place = i === j ? String(i + 1) : `${i + 1}–${j + 1}`;
    for (let k = i; k <= j; k++) rows.push({ nick: raw[k][0], baths: raw[k][1], pts: raw[k][2] ?? calc[raw[k][0]] ?? 0, place, photo: photo.get(raw[k][0]) ?? null });
    i = j + 1;
  }
  // даты недели: W1 — с 1 января, дальше пн–вс
  const jan1 = new Date(Date.UTC(season, 0, 1)), firstMon = new Date(jan1);
  firstMon.setUTCDate(1 + ((8 - jan1.getUTCDay()) % 7));
  const from = week === 1 ? jan1 : new Date(firstMon.getTime() + (week - 2) * 7 * 864e5), to = new Date(week === 1 ? firstMon.getTime() - 864e5 : from.getTime() + 6 * 864e5);
  const d = (x: Date, m = true) => x.toLocaleDateString("ru-RU", { day: "numeric", ...(m ? { month: "long" } : {}), timeZone: "UTC" });
  const dates = from.getUTCMonth() === to.getUTCMonth() ? `${d(from, false)}–${d(to)}` : `${d(from)} – ${d(to)}`;
  return { rows, dates, total: raw.reduce((a, r) => a + r[1], 0) };
}

// что по неделе ещё не решено Комиссией: походы на проверке и новые бани на согласовании
async function pendingFor(season: number, week: number) {
  const inWeek = (t: string | number | Date) => weekOf(new Date(t), season) === week;
  const [{ data: pv }, { data: pb }] = await Promise.all([
    sb.from("visits").select("id, posted_at").eq("status", "pending"),
    sb.from("baths").select("id, visits(posted_at, status)").eq("status", "pending"),
  ]);
  const visits = (pv ?? []).filter((v: Any) => inWeek(v.posted_at)).length;
  const bathsN = (pb ?? []).filter((b: Any) => (b.visits ?? []).some((v: Any) => v.status !== "rejected" && inWeek(v.posted_at))).length;
  return { visits, baths: bathsN, total: visits + bathsN };
}

// ---------- картинка ----------
const hue = (s: string) => { let h = 7; for (const ch of s) h = (h * 31 + ch.codePointAt(0)!) % 360; return h; };
const initials = (s: string) => s.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0]).join("").toUpperCase();
const b64 = (u8: Uint8Array) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const u8 = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

async function photoData(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    const type = buf[0] === 0x89 ? "image/png" : "image/jpeg";   // Telegram отдаёт как octet-stream — тип по сигнатуре
    return `data:${type};base64,${b64(buf)}`;
  } catch { return null; }
}

function avatar(id: string, row: Row, cx: number, cy: number, r: number, img: string | null, ring: string) {
  const face = img
    ? `<clipPath id="c${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath><image href="${img}" x="${cx - r}" y="${cy - r}" width="${2 * r}" height="${2 * r}" preserveAspectRatio="xMidYMid slice" clip-path="url(#c${id})"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue(row.nick)}, 35%, 82%)"/><text x="${cx}" y="${cy + r * 0.2}" text-anchor="middle" font-family="Unbounded" font-weight="700" font-size="${r * 0.62}" fill="hsl(${hue(row.nick)}, 45%, 28%)">${esc(initials(row.nick))}</text>`;
  return `${face}<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring}" stroke-width="7"/>`;
}

// строки «по одному на участника», одинаковые места — одной строкой с именами (4–13 · по 1 бане · по +2,1: …)
function restLines(rows: Row[]) {
  const out: { head: string; names: string }[] = [];
  for (const place of [...new Set(rows.map((r) => r.place))]) {
    const g = rows.filter((r) => r.place === place);
    out.push(g.length === 1
      ? { head: `${place}. ${g[0].nick} · ${baths(g[0].baths)} · +${fmt(g[0].pts)}`, names: "" }
      : { head: `${place} · по ${g[0].baths} ${plural(g[0].baths, "бане", "бани", "бань")} · по +${fmt(g[0].pts)}`, names: g.map((r) => r.nick).join(", ") });
  }
  return out;
}
function wrap(text: string, max: number) {
  const lines: string[] = []; let cur = "";
  for (const w of text.split(" ")) { if ((cur + " " + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) lines.push(cur);
  return lines;
}

async function renderPng(week: number, data: Awaited<ReturnType<typeof weekData>>) {
  const W = 1080, H = 1350, base = 890;
  // ступеньки пьедестала — по местам: место делят несколько человек — все стоят на своей ступеньке
  const groups = [...new Set(data.rows.map((r) => r.place))].map((pl) => data.rows.filter((r) => r.place === pl));
  const steps = groups.slice(0, 3), rest = groups.slice(3).flat();
  const imgs = await Promise.all(steps.map((g) => Promise.all(g.slice(0, 3).map((r) => photoData(r.photo)))));
  // 2 — слева, 1 — в центре, 3 — справа
  const slots = [
    { i: 1, x: 250, h: 190, fill: "#d3dbd2", ring: "#eef3ec", r: 76 },
    { i: 0, x: 540, h: 260, fill: "#f2c160", ring: "#f6d58c", r: 96 },
    { i: 2, x: 830, h: 150, fill: "#dc9a68", ring: "#f0c29c", r: 76 },
  ].filter((s) => steps[s.i]);
  const podium = slots.map((s) => {
    const g = steps[s.i], row = g[0], y = base - s.h, many = g.length > 1;
    const r = many ? Math.round(s.r * 0.62) : s.r, cy = y - r - 72;
    const shown = g.slice(0, 3), gap = r * 1.35, x0 = s.x - ((shown.length - 1) * gap) / 2;
    const faces = shown.map((m, k) => avatar(`${s.i}-${k}`, m, x0 + k * gap, cy, r, imgs[s.i][k], s.ring)).join("");
    const names = many ? (g.length <= 2 ? g.map((m) => m.nick).join(", ") : `${g[0].nick} и ещё ${g.length - 1}`) : row.nick;
    const label = names.length > 16 ? names.slice(0, 15) + "…" : names;
    return `<rect x="${s.x - 125}" y="${y}" width="250" height="${s.h + 40}" rx="26" fill="${s.fill}"/>
      <text x="${s.x}" y="${y + 74}" text-anchor="middle" font-family="Unbounded" font-weight="700" font-size="56" fill="#1d2a1f">+${esc(fmt(row.pts))}</text>
      <text x="${s.x}" y="${y + 116}" text-anchor="middle" font-family="Golos Text" font-weight="700" font-size="30" fill="#1d2a1f" fill-opacity=".72">${esc(many ? `по ${row.baths} ${plural(row.baths, "бане", "бани", "бань")}` : baths(row.baths))}</text>
      ${faces}
      <text x="${s.x}" y="${y - 26}" text-anchor="middle" font-family="Golos Text" font-weight="700" font-size="${many ? 30 : 36}" fill="#ffffff">${esc(label)}</text>
      ${s.i === 0 && !many ? `<svg x="${s.x - 82}" y="${cy - r - 92}" width="164" height="127" viewBox="0 0 40 31"><g transform="rotate(-8 20 16)">${HAT}</g></svg>` : ""}`;
  }).join("");
  // остальные места — компактно, одинаковые места одной строкой
  let y = base + 92, list = "";
  for (const l of restLines(rest)) {
    if (y > H - 110) break;
    list += `<text x="96" y="${y}" font-family="Golos Text" font-weight="700" font-size="32" fill="#f2c160">${esc(l.head)}</text>`;
    y += 44;
    for (const line of l.names ? wrap(l.names, 52) : []) {
      if (y > H - 110) { list += `<text x="96" y="${y}" font-family="Golos Text" font-size="28" fill="#e8efe6" fill-opacity=".85">…</text>`; y += 40; break; }
      list += `<text x="96" y="${y}" font-family="Golos Text" font-size="28" fill="#e8efe6" fill-opacity=".85">${esc(line)}</text>`;
      y += 40;
    }
    y += 10;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17291b"/><stop offset="1" stop-color="#2d5132"/></linearGradient>
      <radialGradient id="glow" cx=".5" cy=".42" r=".55"><stop offset="0" stop-color="#f2c160" stop-opacity=".28"/><stop offset="1" stop-color="#f2c160" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/>
    <g fill="none" stroke="#ffffff" stroke-opacity=".06" stroke-width="10" stroke-linecap="round">
      <path d="M120 380 c-40 -60 40 -90 0 -150 s40 -90 0 -150"/><path d="M960 420 c-40 -60 40 -90 0 -150 s40 -90 0 -150"/>
    </g>
    <text x="${W / 2}" y="104" text-anchor="middle" font-family="Golos Text" font-weight="700" font-size="26" letter-spacing="7" fill="#f2c160">ЕВРАЗИЙСКАЯ БАННАЯ ЛИГА</text>
    <text x="${W / 2}" y="196" text-anchor="middle" font-family="Unbounded" font-weight="700" font-size="74" fill="#ffffff">ИТОГИ НЕДЕЛИ</text>
    <text x="${W / 2}" y="254" text-anchor="middle" font-family="Golos Text" font-weight="700" font-size="34" fill="#e8efe6" fill-opacity=".85">W${week} · ${esc(data.dates)} · ${data.total} ${plural(data.total, "поход", "похода", "походов")}</text>
    ${podium}
    ${list}
    <text x="${W / 2}" y="${H - 48}" text-anchor="middle" font-family="Golos Text" font-weight="700" font-size="28" fill="#f2c160" fill-opacity=".85">ebl.su · таблица и карта бань</text>
  </svg>`;
  await (wasmReady ??= initWasm(fetch(WASM)));
  const r = new Resvg(svg, { font: { fontBuffers: [u8(UNBOUNDED700), u8(GOLOS700), u8(GOLOS400)], defaultFontFamily: "Golos Text", loadSystemFonts: false } });
  return r.render().asPng();
}
let wasmReady: Promise<void> | null = null;

function caption(week: number, data: Awaited<ReturnType<typeof weekData>>) {
  const medal = ["🥇", "🥈", "🥉"];
  const groups = [...new Set(data.rows.map((r) => r.place))].map((pl) => data.rows.filter((r) => r.place === pl));
  const top = groups.slice(0, 3).map((g, i) => `${medal[i]} <b>${esc(g.map((r) => r.nick).join(", "))}</b> — ${baths(g[0].baths)}${g.length > 1 ? " у каждого" : ""}, +${fmt(g[0].pts)}`);
  const rest = restLines(groups.slice(3).flat()).slice(0, 6).map((l) => l.names ? `${l.head}: ${esc(l.names)}` : esc(l.head));
  const leader = groups[0]?.length === 1 ? groups[0][0] : null;
  return [`🏆 <b>Итоги недели W${week}</b> · ${esc(data.dates)}`, "", ...top, ...(rest.length ? ["", ...rest] : []), "",
    `За неделю — ${data.total} ${plural(data.total, "поход", "похода", "походов")} от ${data.rows.length} ${plural(data.rows.length, "участника", "участников", "участников")}.`,
    leader ? `Поздравляем, ${esc(leader.nick)}! 👑` : groups[0] ? `Поздравляем лидеров недели! 👑` : "", `Таблица: ${SITE}#table`].filter((x) => x !== null).join("\n").slice(0, 1024);
}

async function sendPhoto(chat: number, png: Uint8Array, text: string) {
  const fd = new FormData();
  fd.append("chat_id", String(chat)); fd.append("caption", text); fd.append("parse_mode", "HTML");
  fd.append("photo", new Blob([png], { type: "image/png" }), "week.png");
  return await fetch(`${TELEGRAM_API}/bot${TOKEN}/sendPhoto`, { method: "POST", body: fd }).then((r) => r.json()).catch(() => ({ ok: false }));
}

// ---------- когда постить ----------
async function autoPost() {
  const season = Number(await setting("season")) || 2026, cutover = Number(await setting("cutover_week")) || 1, chat = Number(await setting("league_chat")) || 0;
  const now = new Date(), m = msk(now), dow = m.getUTCDay();
  // окно: с 23:00 воскресенья (неделя уже закрыта) до конца среды
  const inWindow = (dow === 0 && m.getUTCHours() >= 23) || dow === 1 || dow === 2 || dow === 3;
  const week = weekOf(now, season) - 1;
  if (!inWindow || week < cutover || !chat) return { skipped: "не время" };
  const { data: done } = await sb.from("week_posts").select("week").eq("season", season).eq("week", week).maybeSingle();
  if (done) return { skipped: "уже запощено", week };
  const waiting = await pendingFor(season, week);
  if (waiting.total) return { week, waiting };
  // забираем неделю себе вставкой: параллельный вызов второй пост не сделает; не отправилось — отдаём обратно
  const { data: claim } = await sb.from("week_posts").insert({ season, week, chat_id: chat }).select("week").maybeSingle();
  if (!claim) return { skipped: "уже запощено", week };
  await fetch(`${BASE}/functions/v1/recompute`, { method: "POST" }).catch(() => null);   // очки за места закрытой недели
  const data = await weekData(season, week);
  const r = data.rows.length ? await sendPhoto(chat, await renderPng(week, data), caption(week, data)) : { ok: true, skipped: "за неделю бань не было — неделя не разыгрывается (п. 8)" };
  if (!r.ok) { await sb.from("week_posts").delete().eq("season", season).eq("week", week); return { week, error: r.description ?? "не отправилось" }; }
  await sb.from("week_posts").update({ message_id: r.result?.message_id ?? null }).eq("season", season).eq("week", week);
  return { week, posted: true };
}

Deno.serve(async (req) => {
  const url = new URL(req.url), season = Number(await setting("season")) || 2026;
  const wk = (k: string) => Number(url.searchParams.get(k)) || weekOf(new Date(), season);
  try {
    if (url.searchParams.has("render")) {
      const w = wk("render");
      return new Response(await renderPng(w, await weekData(season, w)), { headers: { "Content-Type": "image/png" } });
    }
    if (url.searchParams.has("dry")) {
      const w = wk("dry");
      return json({ week: w, ...(await weekData(season, w)), waiting: await pendingFor(season, w) });
    }
    if (url.searchParams.get("preview")) {
      const tg = Number(url.searchParams.get("preview")), w = wk("week");
      const { data: acc } = await sb.from("player_accounts").select("players(is_commission)").eq("tg_id", tg).maybeSingle();
      if (!(acc as Any)?.players?.is_commission) return json({ error: "пример — только участнику Комиссии" }, 403);
      const last = Number(await setting("week_preview_at")) || 0;
      if (Date.now() - last < 120e3) return json({ error: "не чаще раза в 2 минуты" }, 429);
      await sb.from("settings").upsert({ key: "week_preview_at", value: Date.now() });
      const data = await weekData(season, w);
      const r = await sendPhoto(tg, await renderPng(w, data), `👀 <b>Пример</b> — так будет выглядеть пост в чате\n\n${caption(w, data)}`);
      return json({ sent: !!r.ok, error: r.description });
    }
    return json(await autoPost());
  } catch (e) {
    console.error("week-results", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
