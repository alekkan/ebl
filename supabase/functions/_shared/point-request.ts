// Перенести точную точку бани: участник предлагает, Комиссия решает (миграция bath_point_requests, docs/bot.md).
// Общее для сайта (bath-location) и бота (ответ точкой на карточку). Комиссии в личку пишет бот — его зовёт триггер.
import { distKm } from "./geo.ts";

type Point = { lat: number; lng: number };

// до 100 м от того, что стоит, — та же точка: Комиссию не дёргаем
const SAME_KM = 0.1;

// deno-lint-ignore no-explicit-any
export async function requestPoint(sb: any, bathId: number, p: Point, playerId: string, source: "site" | "bot",
  tg?: { chat: number; msg: number }): Promise<{ same?: true; requested?: number; km: number | null }> {
  const { data: b } = await sb.from("baths").select("lat, lng").eq("id", bathId).single();
  const km = b?.lat != null ? distKm({ lat: b.lat, lng: b.lng }, p) : null;
  if (km != null && km < SAME_KM) return { same: true, km };
  // передумал и прислал другую точку — свой прежний запрос по этой бане снимаем, Комиссия решает по последнему
  await sb.from("bath_point_requests").delete().eq("bath_id", bathId).eq("requested_by", playerId).eq("status", "pending");
  const { data, error } = await sb.from("bath_point_requests").insert({
    bath_id: bathId, lat: p.lat, lng: p.lng, old_lat: b?.lat ?? null, old_lng: b?.lng ?? null, requested_by: playerId, source,
    tg_chat: tg?.chat ?? null, tg_msg: tg?.msg ?? null,
  }).select("id").single();
  if (error) throw new Error(error.message);
  return { requested: data.id, km };
}
