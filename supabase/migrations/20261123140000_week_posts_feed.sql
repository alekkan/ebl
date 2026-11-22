-- Итоги недели — в ленту сайта (23.11): когда бот запостил итоги в чат, в ленте появляется такая же запись.
-- Сами места и очки сайт берёт из открытой таблицы; отсюда — только какая неделя и когда вышел пост.
-- week_posts — служебная таблица бота (только service_role), поэтому наружу отдаём через функцию с правами владельца.
create function public.week_posts_public() returns json
language sql stable security definer set search_path = public as $$
  select coalesce(json_agg(json_build_object('week', w.week, 'posted_at', w.posted_at) order by w.week), '[]'::json)
  from week_posts w
  where w.season = coalesce((select (value #>> '{}')::int from settings where key = 'season'), 2026)
$$;
revoke all on function public.week_posts_public() from public;
grant execute on function public.week_posts_public() to anon, authenticated, service_role;

-- в общий запрос первого экрана (новых запросов при загрузке не плодим)
create or replace function public.boot_public(apikey text default null) returns json
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
                from public.players p),
    'cup', public.cup_state(),
    'week_posts', public.week_posts_public()
  )
$$;
