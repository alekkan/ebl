-- Оценка до решения Комиссии — с придержкой (08.11, Леха: «оценить сразу, а в рейтинг — после засчитано»).
-- Раньше оценить можно было только засчитанный поход: кнопка «Оцени баню, пока помнишь» в форме похода вела в отказ,
-- а бот писал только после «засчитано» (Саня ждал до утра). Теперь:
--  • оценка похода на проверке принимается сразу (rate_visit), бот зовёт оценить сразу после отправки похода;
--  • пока поход не засчитан, оценку и отзыв к нему видит только автор: в рейтинг бани, ленту и карточку они не идут;
--  • засчитали — всё видно само; отклонили или убрали человека из похода — его оценка и отзыв к этому походу удаляются.
-- Отзыв к оценке похода на проверке помечается этим походом (reviews.visit_id); обычные отзывы — без похода, как раньше.

-- поход засчитан — для правил видимости (security definer: не зависит от прав читающего на visits)
create function public.visit_counted(p_visit bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from visits where id = p_visit and status = 'ok')
$$;
grant execute on function public.visit_counted(bigint) to anon, authenticated, service_role;

drop policy "оценки видны всем" on public.bath_ratings;
create policy "оценки видны, до засчёта — автору" on public.bath_ratings for select
  using (visit_id is null or public.visit_counted(visit_id) or player_id = public.me());

alter table public.reviews add column visit_id bigint references public.visits(id) on delete cascade;
drop policy "отзывы видны всем" on public.reviews;
create policy "отзывы видны, до засчёта — автору" on public.reviews for select
  using (visit_id is null or public.visit_counted(visit_id) or player_id = public.me());

-- рейтинг бани — только по засчитанным (и по оценкам бани без похода)
create or replace function public.bath_rating_all() returns json
language sql stable security definer set search_path = public as $$
  with agg as (
    select bath_id, json_build_object('overall', round(avg(overall), 2), 'n', count(*),
      'stove', round(avg(stove), 1), 'steam', round(avg(steam), 1), 'aqua', round(avg(aqua), 1), 'outdoor', round(avg(outdoor), 1),
      'kitchen', round(avg(kitchen), 1), 'atmosphere', round(avg(atmosphere), 1), 'service', round(avg(service), 1),
      'prices', round(avg(prices), 1)) j
    from bath_ratings r where r.visit_id is null or exists (select 1 from visits v where v.id = r.visit_id and v.status = 'ok')
    group by bath_id
  )
  select coalesce(json_object_agg(bath_id, j), '{}') from agg
$$;

-- странице оценки: поход на проверке оценить можно (held — «появится после проверки»), отклонённый — нет
create or replace function public.rating_form(p_visit bigint) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('visit', v.id, 'bath', v.bath_id, 'name', b.name, 'country', b.country, 'entered_at', v.entered_at,
    'player', public.me(), 'nick', (select nick from players where id = public.me()), 'held', v.status = 'pending',
    'allowed', public.me() is not null and v.status in ('ok', 'pending') and exists (select 1 from visit_players vp where vp.visit_id = v.id and vp.player_id = public.me())
      and v.entered_at >= (select (value #>> '{}')::date from settings where key = 'rating_since'),
    'why', case when public.me() is null then 'login'
                when not exists (select 1 from visit_players vp where vp.visit_id = v.id and vp.player_id = public.me()) then 'stranger'
                when v.status not in ('ok', 'pending') then 'rejected'
                when v.entered_at < (select (value #>> '{}')::date from settings where key = 'rating_since') then 'old' end,
    'scores', (select json_build_object('stove', r.stove, 'steam', r.steam, 'aqua', r.aqua, 'outdoor', r.outdoor, 'kitchen', r.kitchen,
                 'atmosphere', r.atmosphere, 'service', r.service, 'prices', r.prices)
               from bath_ratings r where r.visit_id = v.id and r.player_id = public.me()))
  from visits v join baths b on b.id = v.bath_id where v.id = p_visit
$$;

create or replace function public.rate_visit(p_visit bigint, p_scores jsonb) returns numeric
language plpgsql security definer set search_path = public as $$
declare v visits; s int[]; k text; r numeric;
begin
  select * into v from visits where id = p_visit;
  if not found or v.status not in ('ok', 'pending') then raise exception 'Поход отклонён — оценить нельзя'; end if;
  if public.me() is null or not exists (select 1 from visit_players where visit_id = p_visit and player_id = public.me()) then
    raise exception 'Оценивает тот, кто был в походе';
  end if;
  if v.entered_at < (select (value #>> '{}')::date from settings where key = 'rating_since') then raise exception 'Этот поход раньше рейтинга'; end if;
  foreach k in array array['stove', 'steam', 'aqua', 'outdoor', 'kitchen', 'atmosphere', 'service', 'prices'] loop
    if (p_scores ->> k) is null or (p_scores ->> k) !~ '^[1-5]$' then raise exception 'Нужны все восемь оценок от 1 до 5 (%)', k; end if;
    s := s || (p_scores ->> k)::int;
  end loop;
  insert into bath_ratings (visit_id, bath_id, player_id, stove, steam, aqua, outdoor, kitchen, atmosphere, service, prices)
  values (p_visit, v.bath_id, public.me(), s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8])
  on conflict (visit_id, player_id) do update set stove = excluded.stove, steam = excluded.steam, aqua = excluded.aqua,
    outdoor = excluded.outdoor, kitchen = excluded.kitchen, atmosphere = excluded.atmosphere, service = excluded.service,
    prices = excluded.prices, updated_at = now()
  returning overall into r;
  update rating_asks set done = true where visit_id = p_visit and player_id = public.me();
  return r;
end $$;

-- очередь «оцени баню» — сразу с походом (на проверке или засчитанным), а не после «засчитано»
create or replace function public.queue_rating_asks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('ok', 'pending') and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and new.entered_at >= (select (value #>> '{}')::date from settings where key = 'rating_since') then
    insert into rating_asks (visit_id, player_id) select new.id, vp.player_id from visit_players vp where vp.visit_id = new.id
    on conflict do nothing;
  end if;
  return new;
end $$;

create or replace function public.queue_rating_ask_player() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into rating_asks (visit_id, player_id)
  select new.visit_id, new.player_id from visits v where v.id = new.visit_id and v.status in ('ok', 'pending')
    and v.entered_at >= (select (value #>> '{}')::date from settings where key = 'rating_since')
  on conflict do nothing;
  return new;
end $$;

-- отклонили поход — оценки, отзывы и просьбы оценить по нему снимаем
create function public.drop_rejected_ratings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    delete from bath_ratings where visit_id = new.id;
    delete from reviews where visit_id = new.id;
    delete from rating_asks where visit_id = new.id;
  end if;
  return new;
end $$;
create trigger visits_drop_rejected_ratings after update of status on public.visits
  for each row execute function public.drop_rejected_ratings();

-- убрали человека из похода — снимаем и его оценку с отзывом к этому походу, не только просьбу оценить
create or replace function public.drop_rating_ask() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from rating_asks where visit_id = old.visit_id and player_id = old.player_id;
  delete from bath_ratings where visit_id = old.visit_id and player_id = old.player_id;
  delete from reviews where visit_id = old.visit_id and player_id = old.player_id;
  return old;
end $$;
