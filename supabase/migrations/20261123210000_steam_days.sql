-- Пары по дням недели. Старые записи действуют ежедневно.
alter table public.bath_schedule
  add column days smallint[] not null default array[1,2,3,4,5,6,7]::smallint[]
  check (cardinality(days) between 1 and 7 and days <@ array[1,2,3,4,5,6,7]::smallint[]);
alter table public.bath_schedule drop constraint bath_schedule_every_min_check;
alter table public.bath_schedule add constraint bath_schedule_every_min_check check (every_min in (60, 90, 120));

-- Обновляем только выбранные дни. Будни и выходные не перезаписывают друг друга.
create function public.submit_bath_steam(p_bath_id bigint, p_times time[], p_every_min int, p_days smallint[]) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.me();
  v_times time[];
  v_days smallint[];
  v_id bigint;
begin
  if v_me is null then raise exception 'Расписание могут вносить участники лиги'; end if;
  if not exists (select 1 from baths where id = p_bath_id and status <> 'rejected') then raise exception 'Нет такой бани'; end if;
  if p_every_min is not null and p_every_min not in (60, 90, 120) then raise exception 'Выбери интервал или укажи время паров'; end if;
  select array_agg(distinct t order by t) into v_times from unnest(p_times) t where t is not null;
  if v_times is null then raise exception 'Укажи хотя бы один пар'; end if;
  if cardinality(v_times) > 48 then raise exception 'Слишком много паров'; end if;
  select array_agg(distinct d order by d) into v_days from unnest(p_days) d;
  if v_days is null or array_position(v_days, null) is not null or not v_days <@ array[1,2,3,4,5,6,7]::smallint[] then
    raise exception 'Выбери дни паров';
  end if;
  -- Одновременные одинаковые отправки не создают две записи в истории.
  perform pg_advisory_xact_lock(hashtextextended('bath-steam:' || p_bath_id, 0));
  if not exists (
    select 1 from unnest(v_days) d
    left join lateral (
      select s.times, s.every_min from bath_schedule s
      where s.bath_id = p_bath_id and s.kind = 'steam' and d = any(s.days)
      order by s.id desc limit 1
    ) latest on true
    where latest.times is distinct from v_times or latest.every_min is distinct from p_every_min
  ) then return null; end if;
  insert into bath_schedule (bath_id, kind, times, every_min, days, created_by)
    values (p_bath_id, 'steam', v_times, p_every_min, v_days, v_me) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.submit_bath_steam(bigint, time[], int, smallint[]) from public, anon;
grant execute on function public.submit_bath_steam(bigint, time[], int, smallint[]) to authenticated;

-- Прежний вызов с тремя аргументами по-прежнему задаёт расписание на все дни.
create or replace function public.submit_bath_steam(p_bath_id bigint, p_times time[], p_every_min int) returns bigint
language sql security definer set search_path = public as $$
  select public.submit_bath_steam(p_bath_id, p_times, p_every_min, array[1,2,3,4,5,6,7]::smallint[]);
$$;

create or replace function public.bath_schedule_of(p_bath bigint) returns json
language sql stable security definer set search_path = '' as $$
  with steam as (
    select d.day, json_build_object(
      'times', (select json_agg(to_char(t, 'HH24:MI') order by t) from unnest(s.times) t),
      'every_min', s.every_min, 'at', s.created_at) as item
    from generate_series(1, 7) d(day)
    cross join lateral (
      select b.* from public.bath_schedule b
      where b.bath_id = p_bath and b.kind = 'steam' and d.day = any(b.days)
      order by b.id desc limit 1
    ) s
  )
  select json_build_object(
    'steam', (select item from steam where day = extract(isodow from now() at time zone 'Europe/Moscow')::int),
    'steam_week', (select coalesce(json_object_agg(day, item order by day), '{}'::json) from steam),
    'hours', (select json_build_object('open', to_char(s.open_time, 'HH24:MI'), 'close', to_char(s.close_time, 'HH24:MI'), 'at', s.created_at)
      from public.bath_schedule s where s.bath_id = p_bath and s.kind = 'hours' order by s.id desc limit 1));
$$;
