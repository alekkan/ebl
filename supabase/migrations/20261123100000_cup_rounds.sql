-- Кубок, этап 2 (23.11): переход между турами. Система считает итоги тура и составы следующего (docs/cup.md, «Переходы»),
-- Комиссия принимает их на сайте; жребий пути ебланов после первого тура тянет система, Комиссия может перетянуть.
-- До принятия предложение видит только Комиссия; команды следующего тура появляются в cup_teams только после «Принять».

-- одна строка на тур: предложение (пока не принято — заменяется новым), после принятия — итог тура для истории
create table public.cup_transitions (
  round int primary key references public.cup_rounds(n),
  proposal jsonb not null,
  basis text not null,   -- отпечаток мест и очков: изменились после предложения — принять нельзя, надо смотреть заново
  proposed_by uuid references public.players(id),
  proposed_at timestamptz not null default now(),
  accepted_by uuid references public.players(id),
  accepted_at timestamptz
);
alter table public.cup_transitions enable row level security;
-- напрямую не читается никем: принятое отдаёт cup_state(), предложение — cup_propose() Комиссии
grant all on public.cup_transitions to service_role;

-- куда идёт участник после тура: r — место команды на своём пути, pr — место участника в команде.
-- C1..C3 / L1..L3 — команда следующего тура на пути чемпионов / ебланов, LD — жребий пути ебланов,
-- R — победитель пути чемпионов (тур 4 отдыхает), F — в финал с пути ебланов, W / S — победитель и финалист, X — выбыл
create function public.cup_dest(p_round int, p_path text, r int, pr int) returns text
language sql immutable as $$
  select case
    when p_round = 1 then case r
      when 1 then 'C1'
      when 2 then case when pr <= 2 then 'C2' else 'LD' end
      when 3 then case when pr <= 2 then 'C3' else 'LD' end
      when 4 then case when pr = 1 then 'C3' else 'LD' end
      when 5 then case when pr = 1 then 'C2' else 'LD' end
      else 'LD' end
    when p_round = 2 and p_path = 'champions' then case r
      when 1 then 'C1'
      when 2 then case when pr <= 2 then 'C2' else 'L3' end
      else case when pr = 1 then 'C2' else 'L3' end end
    when p_round = 3 and p_path = 'champions' then case r when 1 then 'R' else 'L3' end
    when p_round in (2, 3) then case r
      when 1 then 'L1'
      when 2 then case when pr <= 2 then 'L2' else 'X' end
      else case when pr = 1 then 'L2' else 'X' end end
    when p_round = 4 then case r when 1 then 'F' else 'X' end
    else case r when 1 then 'W' else 'S' end
  end
$$;

-- итоги тура и составы следующего одним json; жребий — новый при каждом вызове
create function public.cup_build(p_round int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_shape text; v_draw boolean; v_rest jsonb; v_teams jsonb; v_results jsonb; v_basis text; v_pending int;
begin
  drop table if exists _cup_pl;
  create temp table _cup_pl on commit drop as
  with pl as (
    select t.id as team_id, t.num, t.path, p.nick, coalesce(x.total, 0) as total, coalesce(x.baths, 0) as baths, coalesce(s.place, 99) as place
    from cup_teams t
    join cup_team_players tp on tp.team_id = t.id
    join players p on p.id = tp.player_id
    left join (select c.nick, sum(c.total)::int as total, (count(*) filter (where c.total > 0))::int as baths
               from cup_points c where c.round = p_round group by c.nick) x on x.nick = p.nick
    -- место в чемпионате — как в таблице на сайте: очки, потом бани
    left join (select st.nick, (row_number() over (order by st.total desc, st.baths desc, st.nick))::int as place from standings st) s on s.nick = p.nick
    where t.round = p_round
  ), tm as (
    -- п. 17: поровну очков — выше команда с меньшей суммой мест в чемпионате, потом — у кого больше бань в туре; в финале пути встречаются
    select pl.team_id, sum(pl.total)::int as team_total, sum(pl.baths)::int as team_baths, sum(pl.place)::int as team_places, count(*)::int as size,
           (row_number() over (partition by (case when p_round = 5 then '' else pl.path end)
                               order by sum(pl.total) desc, sum(pl.place), sum(pl.baths) desc, pl.num))::int as r
    from pl group by pl.team_id, pl.num, pl.path
  ), q as (
    -- п. 18: в команде остаётся набравший больше, поровну — тот, кто выше в чемпионате
    select pl.*, tm.team_total, tm.team_baths, tm.team_places, tm.size, tm.r,
           (row_number() over (partition by pl.team_id order by pl.total desc, pl.place, pl.nick))::int as pr
    from pl join tm using (team_id)
  )
  select q.*, public.cup_dest(p_round, q.path, q.r, q.pr) as dest from q;

  select string_agg(z.path || ':' || z.c, ',' order by z.path) into v_shape
  from (select path, count(distinct team_id) as c from _cup_pl group by path) z;
  if v_shape is distinct from (array['champions:6', 'champions:3,losers:3', 'champions:2,losers:3', 'losers:3', 'champions:1,losers:1'])[p_round]
     or exists (select 1 from _cup_pl where size <> 3) then
    raise exception 'Состав тура % не по регламенту — итоги не подвести', p_round;
  end if;

  v_draw := exists (select 1 from _cup_pl where dest = 'LD');
  -- слепой жребий: девять участников пути ебланов — в три команды по трое
  update _cup_pl p set dest = 'L' || d.slot
  from (select nick, (row_number() over (order by random()) - 1) / 3 + 1 as slot from _cup_pl where dest = 'LD') d
  where d.nick = p.nick;

  select jsonb_agg(nick order by pr) into v_rest from _cup_pl where dest = 'R';
  select coalesce(jsonb_agg(jsonb_build_object('num', z.num, 'path', z.path, 'players', z.players) order by z.num), '[]'::jsonb) into v_teams
  from (
    select row_number() over (order by y.path, y.code) as num, y.path, y.players
    from (
      select dest as code, case when left(dest, 1) = 'C' then 'champions' else 'losers' end as path, jsonb_agg(nick order by total desc, place, nick) as players
      from _cup_pl where dest ~ '^[CL][0-9]$' or dest = 'F' group by dest
      union all
      -- в финал с пути чемпионов выходит команда, отдыхавшая в туре 4
      select 'A', 'champions', t.proposal->'rest' from cup_transitions t where p_round = 4 and t.round = 3
    ) y
  ) z;

  select jsonb_agg(jsonb_build_object('num', z.num, 'path', z.path, 'place', z.r, 'total', z.team_total, 'baths', z.team_baths, 'places', z.team_places,
           'players', z.players) order by z.path, z.r) into v_results
  from (
    select num, path, r, team_total, team_baths, team_places,
           jsonb_agg(jsonb_build_object('nick', nick, 'total', total, 'baths', baths, 'place', place,
             'to', case when dest ~ '^C' then 'champions' when dest ~ '^L' then 'losers' when dest in ('R', 'F') then 'final'
                        when dest = 'W' then 'winner' when dest = 'S' then 'second' else 'out' end) order by pr) as players
    from _cup_pl group by num, path, r, team_total, team_baths, team_places
  ) z;

  select md5(string_agg(nick || ':' || team_id || ':' || r || ':' || pr || ':' || total, ',' order by nick)) into v_basis from _cup_pl;
  select count(*) into v_pending from visits v join cup_rounds cr on cr.n = p_round
  where v.status = 'pending' and v.posted_at >= cr.starts_at and v.posted_at < cr.ends_at;

  return jsonb_build_object('round', p_round, 'draw', v_draw, 'results', v_results, 'teams', v_teams, 'rest', v_rest, 'basis', v_basis, 'pending', v_pending);
end $$;
revoke all on function public.cup_build(int) from public, anon, authenticated;
grant execute on function public.cup_build(int) to service_role;

-- Комиссия смотрит итоги сыгранного тура. Повторный вызов отдаёт то же предложение (его видит вся Комиссия),
-- пока не изменились очки; p_redraw — тянуть жребий заново.
create function public.cup_propose(p_round int, p_redraw boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row cup_transitions; v_new jsonb;
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  perform pg_advisory_xact_lock(hashtext('ebl:cup'));
  if not exists (select 1 from cup_rounds where n = p_round and ends_at <= now()) then raise exception 'Тур % ещё не сыгран', p_round; end if;
  if p_round > 1 and not exists (select 1 from cup_transitions where round = p_round - 1 and accepted_at is not null) then
    raise exception 'Сначала прими итоги тура %', p_round - 1;
  end if;
  select * into v_row from cup_transitions where round = p_round;
  if v_row.accepted_at is not null then raise exception 'Итоги тура % уже приняты', p_round; end if;
  v_new := public.cup_build(p_round);
  if v_row.round is not null and not p_redraw and v_row.basis = v_new->>'basis' then
    return v_row.proposal || jsonb_build_object('pending', v_new->'pending');
  end if;
  insert into cup_transitions (round, proposal, basis, proposed_by) values (p_round, v_new - 'basis', v_new->>'basis', public.me())
  on conflict (round) do update set proposal = excluded.proposal, basis = excluded.basis, proposed_by = excluded.proposed_by, proposed_at = now();
  return v_new - 'basis';
end $$;
revoke all on function public.cup_propose(int, boolean) from public, anon;
grant execute on function public.cup_propose(int, boolean) to authenticated, service_role;

-- Комиссия принимает предложение: команды следующего тура заводятся ровно такими, как показаны
create function public.cup_accept(p_round int) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row cup_transitions; v_team jsonb; v_id int;
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  perform pg_advisory_xact_lock(hashtext('ebl:cup'));
  select * into v_row from cup_transitions where round = p_round;
  if v_row.round is null then raise exception 'Итоги тура % ещё не подведены', p_round; end if;
  if v_row.accepted_at is not null then raise exception 'Итоги тура % уже приняты', p_round; end if;
  if v_row.basis <> public.cup_build(p_round)->>'basis' then raise exception 'Очки тура изменились — посмотри итоги заново'; end if;
  if exists (select 1 from cup_teams where round = p_round + 1) then raise exception 'Команды тура % уже заведены', p_round + 1; end if;
  for v_team in select * from jsonb_array_elements(v_row.proposal->'teams') loop
    insert into cup_teams (round, num, path) values (p_round + 1, (v_team->>'num')::int, v_team->>'path') returning id into v_id;
    insert into cup_team_players (team_id, player_id)
    select v_id, p.id from players p where p.nick in (select jsonb_array_elements_text(v_team->'players'));
  end loop;
  update cup_transitions set accepted_by = public.me(), accepted_at = now() where round = p_round;
end $$;
revoke all on function public.cup_accept(int) from public, anon;
grant execute on function public.cup_accept(int) to authenticated, service_role;

-- приняли по ошибке: команды следующего тура убираются, предложение остаётся; дальше — снова «Принять» или новые итоги
create function public.cup_reopen(p_round int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  perform pg_advisory_xact_lock(hashtext('ebl:cup'));
  if not exists (select 1 from cup_transitions where round = p_round and accepted_at is not null) then raise exception 'Итоги тура % не приняты', p_round; end if;
  if exists (select 1 from cup_transitions where round = p_round + 1 and accepted_at is not null) then
    raise exception 'Сначала отмени итоги тура %', p_round + 1;
  end if;
  delete from cup_transitions where round = p_round + 1;
  delete from cup_teams where round = p_round + 1;
  update cup_transitions set accepted_by = null, accepted_at = null where round = p_round;
end $$;
revoke all on function public.cup_reopen(int) from public, anon;
grant execute on function public.cup_reopen(int) to authenticated, service_role;

-- в cup_state — история: принятые итоги туров (места, кто куда пошёл, составы следующего тура)
create or replace function public.cup_state() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'rounds', (select coalesce(json_agg(json_build_object('n', r.n, 'starts_at', r.starts_at, 'ends_at', r.ends_at) order by r.n), '[]'::json) from cup_rounds r),
    'teams', (select coalesce(json_agg(json_build_object('id', t.id, 'round', t.round, 'num', t.num, 'path', t.path,
                'players', (select coalesce(json_agg(p.nick order by p.nick), '[]'::json)
                            from cup_team_players tp join players p on p.id = tp.player_id where tp.team_id = t.id))
                order by t.round, t.num), '[]'::json) from cup_teams t),
    'points', (select coalesce(json_agg(json_build_object('round', x.round, 'nick', x.nick, 'total', x.total, 'baths', x.baths)), '[]'::json)
               from (select round, nick, sum(total) as total, count(*) filter (where total > 0) as baths from cup_points group by round, nick) x),
    'long_gate', (select value from settings where key = 'long_confirm'),
    'history', (select coalesce(json_agg((t.proposal - 'pending') || jsonb_build_object('accepted_at', t.accepted_at) order by t.round), '[]'::json)
                from cup_transitions t where t.accepted_at is not null)
  )
$$;
