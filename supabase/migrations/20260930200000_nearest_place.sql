-- Страна и регион ближайшей бани лиги к точке — запасной путь, когда геокодер OpenStreetMap не ответил серверу
-- (с общих облачных адресов Supabase он иногда отказывает; 26–30.09 так остались пустыми регион и страна у новых бань,
-- и бонус за новый регион, п. 14, не начислялся). Название — сразу в написании Комиссии. Расстояние — приближённое
-- (плоская проекция), для «в пределах 30 км» этого хватает.
create function public.nearest_place(p_lat double precision, p_lng double precision, p_km double precision default 30)
returns table (country text, region text, km double precision)
language sql stable security definer set search_path = public as $$
  select country, region, km from (
    select country, region,
      111.32 * sqrt(power(lat - p_lat, 2) + power((lng - p_lng) * cos(radians(p_lat)), 2)) as km
    from baths
    where status <> 'rejected' and country is not null and region is not null and lat is not null and lng is not null
  ) x
  where km <= p_km
  order by km
  limit 1
$$;
revoke all on function public.nearest_place(double precision, double precision, double precision) from public, anon, authenticated;
grant execute on function public.nearest_place(double precision, double precision, double precision) to service_role;

-- раз в ночь дозаполняем страну и регион у бань с точной точкой, где их не узнали (tg-bot?fillplaces=1)
select cron.schedule('ebl-fill-places', '0 1 * * *', $$
  select net.http_post(
    url := (select value #>> '{}' from public.settings where key = 'functions_url') || '/tg-bot?fillplaces=1',
    headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 120000)
  where exists (select 1 from public.baths where status <> 'rejected' and precision = 'exact' and lat is not null
                and (country is null or region is null));
$$);
