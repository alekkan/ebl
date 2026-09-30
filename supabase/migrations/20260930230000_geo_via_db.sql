-- Геокодер OpenStreetMap не отвечает edge-функциям Supabase (их адреса у него в блоке: 30.09 из функций — отказ,
-- с сервера базы — ответ), поэтому страну и регион по координатам бани спрашиваем через pg_net с сервера базы:
-- geo_reverse ставит запрос, geo_result отдаёт ответ (placeByPoint в _shared/place.ts ждёт его несколько секунд).
-- Адрес геокодера — settings.nominatim_url (на стенде тесты ставят свою заглушку), по умолчанию настоящий.
-- URL собирается здесь из координат — наружу ничего другого этими функциями не отправить.
create function public.geo_reverse(p_lat double precision, p_lng double precision) returns bigint
language sql security definer set search_path = public as $$
  select net.http_get(
    url := coalesce((select value #>> '{}' from settings where key = 'nominatim_url'), 'https://nominatim.openstreetmap.org')
      || '/reverse?format=jsonv2&zoom=5&accept-language=ru&lat=' || p_lat::text || '&lon=' || p_lng::text,
    headers := '{"User-Agent": "EBL-bot/1.0 (https://ebl.su)"}'::jsonb,
    timeout_milliseconds := 10000)
$$;
create function public.geo_result(p_id bigint) returns table (status int, content text)
language sql security definer set search_path = public as $$
  select status_code, content from net._http_response where id = p_id
$$;
revoke all on function public.geo_reverse(double precision, double precision) from public, anon, authenticated;
revoke all on function public.geo_result(bigint) from public, anon, authenticated;
grant execute on function public.geo_reverse(double precision, double precision), public.geo_result(bigint) to service_role;
