-- Бани для сайта — одним запросом. Их больше тысячи, а PostgREST отдаёт по 1000: сайт качал справочник двумя страницами
-- подряд, и это одна из причин, почему заставка «Готовлю парок…» висела секундами (15.10). Права те же, что у таблицы:
-- функция без security definer, политика «бани видны всем» (отклонённые — только Комиссии) работает как при обычном запросе.
create function public.baths_all() returns json
language sql stable
set search_path = ''
as $$
  select coalesce(json_agg(t order by t.id), '[]'::json)
  from (select id, name, type, country, region, lat, lng, precision, status, created_by
        from public.baths where status <> 'rejected') t
$$;
revoke execute on function public.baths_all() from public;
grant execute on function public.baths_all() to anon, authenticated, service_role;
