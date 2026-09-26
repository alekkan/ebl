// Раз в неделю: проверяем фото профиля всех привязанных участников через Telegram Bot API
// и перекачиваем в хранилище те, что поменялись.
import { createClient } from "npm:@supabase/supabase-js@2";
import { lastBotApiNote, syncAvatar } from "../_shared/avatar.ts";

Deno.serve(async () => {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: accounts, error } = await sb.from("player_accounts").select("id, tg_id, tg_photo_src").not("tg_id", "is", null).not("player_id", "is", null);
  if (error) return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500 });
  let updated = 0;
  const notes: Record<string, number> = {};
  for (const acc of accounts) {
    const stored = await syncAvatar(sb, acc);
    notes[lastBotApiNote] = (notes[lastBotApiNote] ?? 0) + 1;
    if (!stored) continue;
    await sb.from("player_accounts").update({ tg_photo: stored.url, tg_photo_src: stored.src }).eq("id", acc.id);
    updated++;
  }
  return new Response(JSON.stringify({ ok: true, checked: accounts.length, updated, notes }), { headers: { "Content-Type": "application/json" } });
});
