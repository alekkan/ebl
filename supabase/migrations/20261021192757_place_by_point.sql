-- Страна и регион бани с точной точкой — по координатам (21.10, решение Лехи): точка, которую поставил человек или приняла
-- Комиссия в Сверке, точнее региона из таблицы (Хельсинки стояли в Хабаровском крае). Москва по точке — «Москва»,
-- область — «Московская обл». Раньше по точке заполняли только пустые страну и регион.
-- place_lat/place_lng — точка, по которой страну и регион определили (геокодер или Комиссия руками в карточке): точку
-- передвинули — баня снова в очереди ebl-fill-places, где бы её ни двигали (Сверка, Радар, запрос точки, бот).
alter table public.baths add column place_lat float8, add column place_lng float8;

-- уже стоящие точные — как есть: расхождения с регионом по точке Комиссия смотрит одним списком, не автоматом
update public.baths set place_lat = lat, place_lng = lng
where precision = 'exact' and lat is not null and country is not null and region is not null;

-- кого спросить геокодер: точная точка, а страна или регион пустые или определены не по этой точке
create view public.bath_place_due as
  select id, name, lat, lng, country, region from public.baths
  where status <> 'rejected' and precision = 'exact' and lat is not null
    and (country is null or region is null or place_lat is distinct from lat or place_lng is distinct from lng);
revoke all on public.bath_place_due from anon, authenticated;
grant select on public.bath_place_due to service_role;

select cron.unschedule('ebl-fill-places');
select cron.schedule('ebl-fill-places', '*/5 * * * *', $$
  select net.http_post(
    url := (select value #>> '{}' from public.settings where key = 'functions_url') || '/tg-bot?fillplaces=1',
    headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 120000)
  where exists (select 1 from public.bath_place_due d left join public.bath_place_tries t on t.bath_id = d.id
                where t.next_at is null or t.next_at <= now());
$$);
