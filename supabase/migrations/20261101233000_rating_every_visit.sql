-- Рейтинг бани — по всем оценкам (01.11, Леха: «если я 5 раз схожу — 5 раз поставлю оценку»). Раньше считали последнюю
-- оценку каждого человека. Оценка похода — одна на поход и человека (бот после «засчитано»); за прошлые походы (до
-- rating_since и из таблицы) — одна на человека и баню, из карточки бани. В среднее идут все.
create or replace function public.bath_rating_all() returns json
language sql stable security definer set search_path = public as $$
  with agg as (
    select bath_id, json_build_object('overall', round(avg(overall), 2), 'n', count(*),
      'stove', round(avg(stove), 1), 'steam', round(avg(steam), 1), 'aqua', round(avg(aqua), 1), 'outdoor', round(avg(outdoor), 1),
      'kitchen', round(avg(kitchen), 1), 'atmosphere', round(avg(atmosphere), 1), 'service', round(avg(service), 1),
      'prices', round(avg(prices), 1)) j
    from bath_ratings group by bath_id
  )
  select coalesce(json_object_agg(bath_id, j), '{}') from agg
$$;
