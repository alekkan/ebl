-- Оценка бани из её карточки (01.11, Леха: «если был хотя бы один визит и ещё не оценивал»). Бывают походы без записи
-- на портале — из таблицы Витька, только год и число. Поэтому оценка из карточки — по бане, а не по походу: visit_id пустой,
-- одна такая оценка на человека и баню (можно поправить). Был ли человек — по bath_counts (походы портала и таблицы).
alter table public.bath_ratings alter column visit_id drop not null;
create unique index bath_ratings_by_bath on public.bath_ratings (bath_id, player_id) where visit_id is null;

-- что показать странице оценки бани: баня, можно ли, когда был последний раз (дата с портала или только год) и прежняя оценка
create function public.rating_form_bath(p_bath bigint) returns json
language sql stable security definer set search_path = public as $$
  with me as (select p.id, p.nick from players p where p.id = public.me()),
  last_visit as (
    select max(v.entered_at) at from visits v join visit_players vp on vp.visit_id = v.id
    where v.bath_id = p_bath and v.status = 'ok' and vp.player_id = (select id from me)),
  last_year as (select max(c.year) y from bath_counts c where c.bath_id = p_bath and c.nick = (select nick from me))
  select json_build_object('bath', b.id, 'name', b.name, 'country', b.country, 'player', (select id from me), 'nick', (select nick from me),
    'entered_at', (select at from last_visit), 'year', (select y from last_year),
    'allowed', (select y from last_year) is not null,
    'why', case when (select id from me) is null then 'login' when (select y from last_year) is null then 'stranger' end,
    'scores', (select json_build_object('stove', r.stove, 'steam', r.steam, 'aqua', r.aqua, 'outdoor', r.outdoor, 'kitchen', r.kitchen,
                 'atmosphere', r.atmosphere, 'service', r.service, 'prices', r.prices)
               from bath_ratings r where r.bath_id = b.id and r.player_id = (select id from me) order by r.updated_at desc limit 1))
  from baths b where b.id = p_bath
$$;
grant execute on function public.rating_form_bath(bigint) to anon, authenticated, service_role;

-- оценить баню, где был (любой поход — с портала или из таблицы); все восемь пунктов 1–5
create function public.rate_bath(p_bath bigint, p_scores jsonb) returns numeric
language plpgsql security definer set search_path = public as $$
declare s int[]; k text; r numeric; v_nick text := (select nick from players where id = public.me());
begin
  if v_nick is null then raise exception 'Оценивают участники лиги'; end if;
  if not exists (select 1 from bath_counts where bath_id = p_bath and nick = v_nick) then raise exception 'Оценивает тот, кто был в этой бане'; end if;
  foreach k in array array['stove', 'steam', 'aqua', 'outdoor', 'kitchen', 'atmosphere', 'service', 'prices'] loop
    if (p_scores ->> k) is null or (p_scores ->> k) !~ '^[1-5]$' then raise exception 'Нужны все восемь оценок от 1 до 5 (%)', k; end if;
    s := s || (p_scores ->> k)::int;
  end loop;
  insert into bath_ratings (visit_id, bath_id, player_id, stove, steam, aqua, outdoor, kitchen, atmosphere, service, prices)
  values (null, p_bath, public.me(), s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8])
  on conflict (bath_id, player_id) where visit_id is null do update set stove = excluded.stove, steam = excluded.steam, aqua = excluded.aqua,
    outdoor = excluded.outdoor, kitchen = excluded.kitchen, atmosphere = excluded.atmosphere, service = excluded.service,
    prices = excluded.prices, updated_at = now()
  returning overall into r;
  return r;
end $$;
revoke execute on function public.rate_bath(bigint, jsonb) from public, anon;
grant execute on function public.rate_bath(bigint, jsonb) to authenticated, service_role;

-- бани, которые я уже оценивал (любым путём) — карточке: показывать ли приглашение «Оцени баню»
create function public.my_rated_baths() returns bigint[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct bath_id), '{}') from bath_ratings where player_id = public.me()
$$;
grant execute on function public.my_rated_baths() to authenticated, service_role;
