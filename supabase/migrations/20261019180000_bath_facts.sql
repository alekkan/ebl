-- Факты о бане на портале (19.10): то, что агенты собрали в сверке каталога и Комиссия приняла («Принять» или «Оставить
-- нашу точку»), видно всем в карточке бани — адрес, часы, мужские и женские дни, цена с датой и источником, сайт, ссылки
-- на Яндекс Карты и 2ГИС, телефон, отделения, что есть. Только принятое и только эти поля: заметки агентов, цитаты,
-- индекс уверенности и непринятое остаются у Комиссии (catalog_proposals закрыта RLS). Карточка просит факты одной бани,
-- когда её открыли, — не в boot_public: первый экран от этого не тяжелеет.
create function public.bath_facts(p_bath bigint) returns json
language sql stable security definer
set search_path = ''
as $$
  select json_build_object('address', c.address, 'city', c.city, 'hours', c.hours, 'gender_days', c.gender_days,
           'price', c.price, 'price_date', c.price_date, 'price_src', c.price_src, 'website', c.website,
           'yandex_url', c.yandex_url, 'twogis_url', c.twogis_url, 'phone', c.phone,
           'sections', c.sections, 'amenities', c.amenities, 'run', c.run, 'decided_at', c.decided_at)
  from public.catalog_proposals c
  where c.bath_id = p_bath and c.status in ('accepted', 'kept')
  order by c.run desc, c.decided_at desc
  limit 1
$$;
revoke execute on function public.bath_facts(bigint) from public;
grant execute on function public.bath_facts(bigint) to anon, authenticated, service_role;
