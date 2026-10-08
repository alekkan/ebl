-- Посещения бань для карты — одним запросом. Представление bath_counts — это 3000+ строк, а PostgREST отдаёт по 1000:
-- сайт качал его четырьмя страницами подряд, и каждая шла через шлюз Яндекса к Cloudflare, где в плохие минуты запрос
-- ждёт секунды или падает с 503 (07.10.2026). Здесь те же строки одним ответом, компактно: [bath_id, year, nick, n].
-- Права те же, что у представления: агрегаты без дат и компаний, видны и гостям.
create function public.bath_counts_all() returns json
language sql stable
set search_path = ''
as $$
  select coalesce(json_agg(json_build_array(bath_id, year, nick, n) order by bath_id, year, nick), '[]'::json)
  from public.bath_counts
$$;
revoke execute on function public.bath_counts_all() from public;
grant execute on function public.bath_counts_all() to anon, authenticated, service_role;
