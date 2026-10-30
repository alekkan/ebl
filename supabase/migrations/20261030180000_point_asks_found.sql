-- «Где была баня?»: баню, которой повторный прогон Сверки нашёл точку (индекс 70+), у людей не спрашиваем, пока её решает
-- Комиссия (30.10, Леха: «чтоб меньше у людей спрашивать»)
create or replace function public.point_ask_candidates() returns jsonb
language sql stable security definer set search_path = public as $$
  with doubt as (
    select distinct p.bath_id from catalog_proposals p join baths b on b.id = p.bath_id
    where p.status = 'new' and coalesce(p.match, 0) < 70 and not p.region_conflict and p.is_public is not false
      and coalesce(p.place_status, 'open') not in ('closed', 'repair')
      and not (coalesce(p.kind_found, '') = 'public' and b.type is distinct from 'public')
      and not (coalesce(p.kind_found, '') in ('spa', 'private') and b.type is null)
      and b.precision is distinct from 'exact'
      and not exists (select 1 from bath_point_requests r where r.bath_id = p.bath_id and r.status = 'pending')
      -- новый прогон нашёл точку (70+) — ждёт Комиссию в Сверке, людей не спрашиваем (30.10)
      and not exists (select 1 from catalog_proposals q where q.bath_id = p.bath_id and q.status = 'new' and q.match >= 70 and q.lat is not null)
  ), was as (
    select v.bath_id, vp.player_id, count(*)::int n, max(extract(year from v.entered_at))::int last,
      max(v.entered_at at time zone 'Europe/Moscow')::date last_date
    from visits v join visit_players vp on vp.visit_id = v.id
    where v.status = 'ok' and v.bath_id in (select bath_id from doubt) group by 1, 2
    union all
    select l.bath_id, pl.id, sum(l.n)::int, max(l.year), null from legacy_visits l join players pl on pl.nick = l.nick
    where l.bath_id in (select bath_id from doubt) group by 1, 2
  )
  select coalesce(jsonb_agg(jsonb_build_object('bath', w.bath_id, 'player', w.player_id, 'n', w.n, 'last', w.last, 'date', w.last_date)), '[]')
  from (select bath_id, player_id, sum(n)::int n, max(last) last, max(last_date) last_date from was group by 1, 2) w
$$;
