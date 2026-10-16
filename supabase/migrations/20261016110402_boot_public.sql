-- Всё общее для первого экрана — одним запросом (16.10). Через шлюз Яндекса запрос обычно идёт 0,3–0,5 с, но примерно
-- каждый десятый застревает на 1–4 с (замеры с узлов в России и с компьютера владельца). Сайт при загрузке слал семь
-- таких запросов разом (бани, посещения, таблица, отзывы, цены, пиво, участники) и ждал самый медленный — больше чем
-- в половине загрузок хотя бы один застревал, и заставка «Готовлю парок…» висела секунды. Один ответ — один шанс застрять.
-- Те же строки и поля, что сайт брал по отдельности. Функция без security definer: права и политики таблиц работают как
-- при обычных запросах (отклонённые бани и прочее закрытое гость не увидит). Скаляр json — без ограничения PostgREST в 1000 строк.
create function public.boot_public() returns json
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
revoke execute on function public.boot_public() from public;
grant execute on function public.boot_public() to anon, authenticated, service_role;
