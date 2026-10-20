-- Сверка, обратный ход (20.10, просьба Комиссии): агенты прошли необщественные бани лиги (хуитнесы, частные, без типа) и
-- для каждой говорят, какая она по факту (kind_found) и почему (kind_why). Похожие на общественные — вкладка «Тип»:
-- «Сделать общественной» (retype) меняет тип бани на найденный и принимает точку и данные, как «Принять»; «Вернуть»
-- возвращает и тип (prev_type), если его с тех пор не меняли.
alter table public.catalog_proposals add column kind_found text check (kind_found in ('public', 'spa', 'private', 'unknown'));
alter table public.catalog_proposals add column kind_why text;
alter table public.catalog_proposals add column prev_type text;

create or replace function public.catalog_decide(p_ids bigint[], p_action text, p_reason text default null) returns int
language plpgsql security definer set search_path = public as $$
declare r public.catalog_proposals; b public.baths; n int := 0; far double precision;
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  if p_action not in ('accept', 'retype', 'keep', 'reject', 'reopen') then raise exception 'Неизвестное действие %', p_action; end if;
  for r in select * from public.catalog_proposals where id = any(p_ids) order by id for update loop
    if p_action = 'reopen' then
      if r.status = 'new' then continue; end if;
      if r.status = 'accepted' and r.prev_precision is not null then
        update public.baths set lat = r.prev_lat, lng = r.prev_lng, precision = nullif(r.prev_precision, 'none')
        where id = r.bath_id and lat = r.lat and lng = r.lng;
      end if;
      if r.prev_type is not null then
        update public.baths set type = nullif(r.prev_type, 'none') where id = r.bath_id and type = r.kind_found;
      end if;
      update public.catalog_proposals set status = 'new', reject_reason = null, prev_lat = null, prev_lng = null,
        prev_precision = null, prev_type = null, decided_by = null, decided_at = null where id = r.id;
      n := n + 1; continue;
    end if;
    if r.status <> 'new' then continue; end if;   -- уже решено (двойное нажатие, пачка поверх решённого)
    if p_action = 'retype' then
      if r.kind_found not in ('public', 'spa', 'private') then raise exception 'Агенты не определили тип бани'; end if;
      select * into b from public.baths where id = r.bath_id for update;
      if b.type is distinct from r.kind_found then
        update public.catalog_proposals set prev_type = coalesce(b.type, 'none') where id = r.id;
        update public.baths set type = r.kind_found where id = r.bath_id;
      end if;
    end if;
    if p_action in ('accept', 'retype') and r.lat is not null then
      select * into b from public.baths where id = r.bath_id for update;
      far := case when b.lat is null then null else 6371 * 2 * asin(sqrt(power(sin(radians(r.lat - b.lat) / 2), 2)
        + cos(radians(b.lat)) * cos(radians(r.lat)) * power(sin(radians(r.lng - b.lng) / 2), 2))) end;
      if b.lat is null or b.precision is distinct from 'exact' or far > 0.3 then
        update public.catalog_proposals set prev_lat = b.lat, prev_lng = b.lng, prev_precision = coalesce(b.precision, 'none') where id = r.id;
        update public.baths set lat = r.lat, lng = r.lng, precision = 'exact' where id = r.bath_id;
      end if;
    end if;
    update public.catalog_proposals set status = case when p_action in ('accept', 'retype') then 'accepted' when p_action = 'keep' then 'kept' else 'rejected' end,
      reject_reason = case when p_action = 'reject' then coalesce(p_reason, 'other') end,
      decided_by = public.me(), decided_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- у частных бань данные агентов (адрес, часы) всем не показываем: частная бывает чьей-то дачей
create or replace function public.bath_facts(p_bath bigint) returns json
language sql stable security definer
set search_path = ''
as $$
  select json_build_object('address', c.address, 'city', c.city, 'hours', c.hours, 'gender_days', c.gender_days,
           'price', c.price, 'price_date', c.price_date, 'price_src', c.price_src, 'website', c.website,
           'yandex_url', c.yandex_url, 'twogis_url', c.twogis_url, 'phone', c.phone,
           'sections', c.sections, 'amenities', c.amenities, 'run', c.run, 'decided_at', c.decided_at)
  from public.catalog_proposals c join public.baths b on b.id = c.bath_id
  where c.bath_id = p_bath and c.status in ('accepted', 'kept') and b.type is distinct from 'private'
  order by c.run desc, c.decided_at desc
  limit 1
$$;
