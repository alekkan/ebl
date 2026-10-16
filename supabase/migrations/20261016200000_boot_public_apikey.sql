-- Ранний запрос данных из index.html (16.10) шлёт ключ в адресе (?apikey=…), а не заголовком: без своих заголовков браузер
-- не делает перед запросом проверку CORS (OPTIONS), а она стоила ещё круг до базы — до 0,8 с при первом заходе.
-- Боевой шлюз Supabase ключ из адреса убирает сам, а локальный стенд передаёт его в PostgREST как параметр функции
-- (404 «нет boot_public(apikey)») — поэтому параметр есть и ничего не делает. Тело — как в 20261016110402_boot_public.sql.
drop function public.boot_public();
create function public.boot_public(apikey text default null) returns json
language sql stable
set search_path = ''
as $$
  select json_build_object(
    'baths', public.baths_all(),
    'counts', public.bath_counts_all(),
    'standings', (select coalesce(json_agg(s order by s.nick), '[]'::json) from public.standings s),
    'reviews', (select coalesce(json_agg(json_build_object('id', r.id, 'bath_id', r.bath_id, 'rating', r.rating, 'text', r.text,
                  'created_at', r.created_at, 'player_id', r.player_id, 'players', case when p.id is null then null else json_build_object('nick', p.nick) end)
                  order by r.id), '[]'::json)
                from public.reviews r left join public.players p on p.id = r.player_id),
    'prices', (select coalesce(json_agg(json_build_object('id', x.id, 'bath_id', x.bath_id, 'price', x.price, 'currency', x.currency,
                 'duration_min', x.duration_min, 'is_weekend', x.is_weekend, 'before_time', x.before_time, 'price_date', x.price_date)
                 order by x.bath_id, x.price_date, x.id), '[]'::json)
               from public.bath_prices x),
    'beer', (select coalesce(json_agg(json_build_object('id', x.id, 'bath_id', x.bath_id, 'price', x.price, 'currency', x.currency, 'price_date', x.price_date)
               order by x.bath_id, x.price_date, x.id), '[]'::json)
             from public.bath_beer_prices x),
    'players', (select coalesce(json_agg(json_build_object('id', p.id, 'nick', p.nick, 'is_commission', p.is_commission, 'photo_url', p.photo_url)
                  order by p.id), '[]'::json)
                from public.players p)
  )
$$;
revoke execute on function public.boot_public(text) from public;
grant execute on function public.boot_public(text) to anon, authenticated, service_role;
