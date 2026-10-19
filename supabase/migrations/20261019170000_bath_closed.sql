-- Баня закрылась (19.10, просьба Комиссии после сверки каталога: Реутовские, Вешняковские, Красноармейск…): отмечаем
-- датой, а не удаляем и не отклоняем — походы и очки за них остаются в истории. Сайт рисует такую баню на карте бледной
-- и не предлагает в форме похода. Ставит и снимает Комиссия в карточке бани (правка baths — её право, политика
-- «Комиссия правит бани»). null — работает.
alter table public.baths add column closed_on date;

create or replace function public.baths_all() returns json
language sql stable
set search_path = ''
as $$
  select coalesce(json_agg(t order by t.id), '[]'::json)
  from (select id, name, type, country, region, lat, lng, precision, status, created_by, closed_on
        from public.baths where status <> 'rejected') t
$$;
