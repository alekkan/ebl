-- Кубок (решения лиги 23.11): термы — в зачёт кубка; при полном равенстве — жребий.
--
-- 1. П. 22 Положения: в кубке считаются общественные бани, а к ним относятся и термальные комплексы (вход по банному билету,
--    больше половины процедур — в обнажённом виде), включая немецкие. На сайте термы лежат в типе «Хуитнес» вместе с
--    фитнесами, а в чемпионате тип менять нельзя (общественная там — +1). Поэтому отдельная отметка «в зачёт кубка»:
--    ставит Комиссия в карточке бани (правка baths — её право), кубок считает общественные и отмеченные, чемпионат её не видит.
alter table public.baths add column cup_ok boolean not null default false;

create or replace function public.baths_all() returns json
language sql stable
set search_path = ''
as $$
  select coalesce(json_agg(t order by t.id), '[]'::json)
  from (select id, name, type, country, region, lat, lng, precision, status, created_by, closed_on, cup_ok
        from public.baths where status <> 'rejected') t
$$;

-- 2. Жребий — последний аргумент: команды равны по очкам, сумме мест в чемпионате и баням тура (или двое в команде — по очкам
--    и месту) — раньше порядок решал номер команды и ник, теперь random(). Кого развёл жребий, помечено lot — в местах
--    команд и у участников; общий признак — ключ lot предложения. Перетянуть — тем же «Другой жребий».
--    Отпечаток (basis) — теперь только из входных данных (очки, бани, место в чемпионате), без мест по итогам: иначе
--    жребий менял бы его при каждом вызове, и принять предложение было бы нельзя.
create or replace function public.cup_build(p_round int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_shape text; v_draw boolean; v_lot boolean; v_rest jsonb; v_teams jsonb; v_results jsonb; v_basis text; v_pending int;
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
  ), tm0 as (
    select pl.team_id, pl.num, (case when p_round = 5 then '' else pl.path end) as grp,
           sum(pl.total)::int as team_total, sum(pl.baths)::int as team_baths, sum(pl.place)::int as team_places, count(*)::int as size
    from pl group by pl.team_id, pl.num, pl.path
  ), tm as (
    -- п. 17: поровну очков — выше команда с меньшей суммой мест в чемпионате, потом — у кого больше бань в туре, дальше — жребий;
    -- в финале пути встречаются
    select tm0.*,
           (row_number() over (partition by grp order by team_total desc, team_places, team_baths desc, random()))::int as r,
           count(*) over (partition by grp, team_total, team_places, team_baths) > 1 as team_lot
    from tm0
  ), q as (
    -- п. 18: в команде остаётся набравший больше, поровну — тот, кто выше в чемпионате, дальше — жребий
    select pl.*, tm.team_total, tm.team_baths, tm.team_places, tm.size, tm.r, tm.team_lot,
           (row_number() over (partition by pl.team_id order by pl.total desc, pl.place, random()))::int as pr,
           count(*) over (partition by pl.team_id, pl.total, pl.place) > 1 as lot
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
  v_lot := exists (select 1 from _cup_pl where team_lot or lot);
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
           'players', z.players) || case when z.team_lot then jsonb_build_object('lot', true) else '{}'::jsonb end order by z.path, z.r) into v_results
  from (
    select num, path, r, team_total, team_baths, team_places, team_lot,
           jsonb_agg(jsonb_build_object('nick', nick, 'total', total, 'baths', baths, 'place', place,
             'to', case when dest ~ '^C' then 'champions' when dest ~ '^L' then 'losers' when dest in ('R', 'F') then 'final'
                        when dest = 'W' then 'winner' when dest = 'S' then 'second' else 'out' end)
             || case when lot then jsonb_build_object('lot', true) else '{}'::jsonb end order by pr) as players
    from _cup_pl group by num, path, r, team_total, team_baths, team_places, team_lot
  ) z;

  select md5(string_agg(nick || ':' || team_id || ':' || total || ':' || baths || ':' || place, ',' order by nick)) into v_basis from _cup_pl;
  select count(*) into v_pending from visits v join cup_rounds cr on cr.n = p_round
  where v.status = 'pending' and v.posted_at >= cr.starts_at and v.posted_at < cr.ends_at;

  return jsonb_build_object('round', p_round, 'draw', v_draw, 'lot', v_lot, 'results', v_results, 'teams', v_teams, 'rest', v_rest, 'basis', v_basis, 'pending', v_pending);
end $$;
