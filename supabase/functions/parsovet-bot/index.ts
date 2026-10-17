// Посредник бота Парсовета (@parsovet_bot) — для соседнего проекта parsovet.ru (репозиторий alekkan/parsovet, docs/api.md).
// Парсовет живёт в Яндекс Облаке, а оттуда Telegram недоступен в обе стороны (17.10.2026). Поэтому обновления Telegram
// принимает эта функция (Франкфурт): пересылает их API Парсовета и отправляет в Telegram ответы, которые API вернул
// списком { method, body }. Ничего не хранит, к базе ЕБЛ и к боту ЕБЛ не обращается.
// Секреты: PARSOVET_BOT_TOKEN (токен @parsovet_bot), PARSOVET_API (шлюз API Парсовета), PARSOVET_HOOK (общий секрет вебхука —
// Telegram присылает его в заголовке, API Парсовета ждёт его же). Настраивает и ставит вебхук scripts/setup-bot-relay.sh Парсовета.
import { TELEGRAM_API } from "../_shared/hosts.ts";

const TOKEN = Deno.env.get("PARSOVET_BOT_TOKEN") ?? "";
const API = (Deno.env.get("PARSOVET_API") ?? "").replace(/\/+$/, "");
const HOOK = Deno.env.get("PARSOVET_HOOK") ?? "";
const METHODS = new Set(["sendMessage"]);   // что API может попросить отправить — и только это

Deno.serve(async (req) => {
  if (!HOOK || !API || req.headers.get("x-telegram-bot-api-secret-token") !== HOOK) return new Response("forbidden", { status: 403 });
  const update = await req.text();
  let send: { method: string; body: unknown }[];
  try {
    const r = await fetch(`${API}/bot/${HOOK}`, {
      method: "POST", body: update, signal: AbortSignal.timeout(20000),
      headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": HOOK },
    });
    if (!r.ok) throw new Error(`API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    send = (await r.json()).send ?? [];
  } catch (e) {
    // API не ответил — 502: Telegram пришлёт то же обновление ещё раз
    console.error("parsovet api", String(e));
    return new Response("api unavailable", { status: 502 });
  }
  for (const x of send) {
    if (!METHODS.has(x.method)) continue;
    const r = await fetch(`${TELEGRAM_API}/bot${TOKEN}/${x.method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(x.body), signal: AbortSignal.timeout(10000),
    }).catch((e) => { console.error("telegram", x.method, String(e)); return null; });
    if (r && !r.ok) console.error("telegram", x.method, r.status, await r.text());
  }
  return new Response("ok");
});
