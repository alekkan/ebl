-- Радар для просмотра (02.11, Леха): места, которые уже есть в лиге среди посещённых бань с точной точкой, не показываем —
-- привязанные к такой бане и стоящие ближе 150 м к ней (то же правило, что radarNear во вкладке Радара у Комиссии, 23.10).
-- Заведённые из Радара бани, куда ещё никто не ходил, остаются — категория «В лиге».
create or replace function public.radar_view(p_key text) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if p_key is null or not exists (select 1 from radar_view_keys where key = p_key) then return null; end if;
  return (with known as (
      select id, lat, lng from baths
      where status = 'ok' and precision = 'exact' and lat is not null and id in (select bath_id from bath_counts))
    select coalesce(json_agg(json_build_array(r.id, r.name, r.city, r.region, r.address, round(r.lat::numeric, 5), round(r.lng::numeric, 5),
      r.kind, r.status, r.public_index, r.website, r.map_url, r.price_example, r.bath_id, r.note) order by r.public_index desc nulls last), '[]')
    from radar_places r
    where r.lat is not null and r.lng is not null and r.status <> 'hidden' and coalesce(r.kind, '') <> 'closed'
      and (r.bath_id is null or r.bath_id not in (select id from known))
      and not exists (select 1 from known k where abs(k.lat - r.lat) < 0.01
        and 6371000 * 2 * asin(sqrt(power(sin(radians(k.lat - r.lat) / 2), 2)
          + cos(radians(r.lat)) * cos(radians(k.lat)) * power(sin(radians(k.lng - r.lng) / 2), 2))) < 150));
end $$;
