-- Факты бани на портале из Радара (30.10, Леха: «по баням, где в радаре решено, — чтобы со всей инфой переносились на
-- карту»). Баню, заведённую или привязанную Комиссией в Радаре, Сверка не проходила — «О бане» было пустым (30 из 33).
-- Сначала, как раньше, принятое в Сверке; нет его — что знает Радар: адрес, город, сайт, ссылка на Яндекс Карты или 2ГИС,
-- пример цены, мужские и женские дни. Частные — по-прежнему не показываем
create or replace function public.bath_facts(p_bath bigint) returns json
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select json_build_object('address', c.address, 'city', c.city, 'hours', c.hours, 'gender_days', c.gender_days,
              'price', c.price, 'price_date', c.price_date, 'price_src', c.price_src, 'website', c.website,
              'yandex_url', c.yandex_url, 'twogis_url', c.twogis_url, 'phone', c.phone,
              'sections', c.sections, 'amenities', c.amenities, 'run', c.run, 'decided_at', c.decided_at)
     from public.catalog_proposals c join public.baths b on b.id = c.bath_id
     where c.bath_id = p_bath and c.status in ('accepted', 'kept') and b.type is distinct from 'private'
     order by c.run desc, c.decided_at desc
     limit 1),
    (select json_build_object('address', r.address, 'city', r.city, 'hours', null,
              'gender_days', case when r.gender_split then 'есть мужские и женские дни или отделения' end,
              'price', r.price_example, 'price_date', to_char(r.last_seen, 'YYYY-MM'),
              'price_src', case when r.price_example is not null then coalesce(r.website, r.map_url) end,
              'website', r.website,
              'yandex_url', case when r.map_url ~* 'yandex\.' then r.map_url end,
              'twogis_url', case when r.map_url ~* '2gis\.' then r.map_url end, 'phone', null,
              'sections', '[]'::jsonb, 'amenities', '[]'::jsonb,
              'run', to_char(coalesce(r.decided_at, r.last_seen), 'YYYY-MM-DD'), 'decided_at', r.decided_at, 'source', 'radar')
     from public.radar_places r join public.baths b on b.id = r.bath_id
     where r.bath_id = p_bath and r.status in ('added', 'matched') and b.type is distinct from 'private'
     order by r.decided_at desc nulls last
     limit 1))
$$;
