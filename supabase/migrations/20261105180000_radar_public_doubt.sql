-- УУ «под вопросом» (05.11, Леха: «спорные тоже в УУ, другим цветом»): на карту — и общественные места Радара с индексом
-- 50–69, а не только 70+. Сайт рисует их светлее; «Отметить поход» — так же, тип бани Комиссия проверит вместе с походом.
-- Остальное как в 20261105120000_radar_public.sql.
create or replace function public.radar_public() returns json
language sql stable security definer set search_path = public as $$
  with known as (
    select id, lat, lng from baths
    where status = 'ok' and precision = 'exact' and lat is not null and id in (select bath_id from bath_counts))
  select json_build_object(
    -- [id, название, город, регион, адрес, широта, долгота, индекс, пример цены, сайт, ссылка на карту, сводка, мужские/женские отдельно, билет на человека]
    'places', (select coalesce(json_agg(json_build_array(r.id, r.name, r.city, r.region, r.address, round(r.lat::numeric, 5), round(r.lng::numeric, 5),
        r.public_index, r.price_example, r.website, r.map_url, r.note, r.gender_split, r.ticket_per_person) order by r.public_index desc, r.id), '[]')
      from radar_places r
      where r.status = 'new' and r.kind = 'public' and r.public_index >= 50 and r.lat is not null and r.lng is not null
        and not exists (select 1 from known k where abs(k.lat - r.lat) < 0.01
          and 6371000 * 2 * asin(sqrt(power(sin(radians(k.lat - r.lat) / 2), 2)
            + cos(radians(r.lat)) * cos(radians(k.lat)) * power(sin(radians(k.lng - r.lng) / 2), 2))) < 150)),
    -- индекс у бань лиги: заведённых из Радара и привязанных к месту Радара
    'index', (select coalesce(json_object_agg(bath_id, public_index), '{}') from (
      select distinct on (bath_id) bath_id, public_index from radar_places
      where bath_id is not null and public_index is not null and status in ('added', 'matched') order by bath_id, last_seen desc) x))
$$;
revoke execute on function public.radar_public() from public;
grant execute on function public.radar_public() to anon, authenticated, service_role;

-- «Отметить поход» в баню с карты, где лига не была: место становится общественной баней с точной точкой (как «В лигу»
-- у Комиссии), поход дальше — обычной формой и на проверку Комиссии. Только участнику лиги и только из тех же мест,
-- что видны на карте; повторный вызов — та же баня
create or replace function public.radar_to_bath(p_id bigint) returns bigint
language plpgsql security definer set search_path = public as $$
declare r public.radar_places; v_bath bigint;
begin
  if public.me() is null then raise exception 'Отметить поход может участник лиги'; end if;
  select * into r from public.radar_places where id = p_id for update;
  if not found then raise exception 'Места нет на карте'; end if;
  if r.status = 'added' and r.bath_id is not null then return r.bath_id; end if;
  if r.status <> 'new' or r.kind <> 'public' or coalesce(r.public_index, 0) < 50 or r.lat is null then raise exception 'Этого места нет на карте'; end if;
  insert into public.baths (name, type, lat, lng, precision, status, created_by)
  values (r.name, 'public', r.lat, r.lng, 'exact', 'ok', public.me())
  returning id into v_bath;
  update public.radar_places set status = 'added', bath_id = v_bath, decided_by = public.me(), decided_at = now() where id = p_id;
  return v_bath;
end $$;
revoke execute on function public.radar_to_bath(bigint) from public;
grant execute on function public.radar_to_bath(bigint) to authenticated, service_role;
