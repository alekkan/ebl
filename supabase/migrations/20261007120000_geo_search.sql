-- Поиск адреса (OpenStreetMap Nominatim /search) с сервера базы через pg_net — edge-функциям Supabase геокодер не отвечает
-- (30.09, см. 20260930230000_geo_via_db.sql). 07.10 из-за этого бот не принял ни ссылку Google на место, ни адрес текстом.
-- Параметры pg_net кодирует сам; ответ — geo_result(id). Только service_role.
create function public.geo_search(p_q text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_get(
    url := coalesce((select value #>> '{}' from settings where key = 'nominatim_url'), 'https://nominatim.openstreetmap.org') || '/search',
    params := jsonb_build_object('q', left(p_q, 300), 'format', 'jsonv2', 'limit', '3', 'accept-language', 'ru'),
    headers := '{"User-Agent": "EBL-bot/1.0 (https://ebl.su)"}'::jsonb,
    timeout_milliseconds := 10000)
$$;
revoke all on function public.geo_search(text) from public, anon, authenticated;
grant execute on function public.geo_search(text) to service_role;
