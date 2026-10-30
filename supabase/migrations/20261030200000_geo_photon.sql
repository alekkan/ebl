-- Поиск адреса в Photon (тот же OpenStreetMap, поиск мягче, 30.10: турецкую улицу Nominatim не знал) — с сервера базы через
-- pg_net, как geo_search: функциям Supabase внешние геокодеры отвечают не всегда. Ответ — geo_result(id). Только service_role.
create function public.geo_photon(p_q text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_get(
    url := coalesce((select value #>> '{}' from settings where key = 'photon_url'), 'https://photon.komoot.io') || '/api',
    params := jsonb_build_object('q', left(p_q, 300), 'limit', '3'),
    headers := '{"User-Agent": "EBL-bot/1.0 (https://ebl.su)"}'::jsonb,
    timeout_milliseconds := 10000)
$$;
revoke all on function public.geo_photon(text) from public, anon, authenticated;
grant execute on function public.geo_photon(text) to service_role;
