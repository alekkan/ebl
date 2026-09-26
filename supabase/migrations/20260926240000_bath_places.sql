-- Какие страны и регионы уже встречались в справочнике, самые частые первыми: по ним бот и сайт приводят
-- название из OpenStreetMap («Кировская область») к написанию Комиссии («Кировская обл») — см. _shared/place.ts.
create view public.bath_places with (security_invoker = true) as
select country, region, count(*)::int as n
from public.baths
where status <> 'rejected' and country is not null
group by country, region
order by n desc;

grant select on public.bath_places to anon, authenticated, service_role;
