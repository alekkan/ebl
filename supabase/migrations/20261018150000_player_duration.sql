-- Разная длительность в одном походе (18.10, просьба владельца): «я и Фил — долгую, Диман — экспресс, а компания у всех».
-- Своя длительность участника — visit_players.duration_min; пусто — как у похода (так у всех старых и почти у всех новых).
-- +1 за долгий (п. 15) — каждому, у кого своя (или общая) длительность больше 150 минут; компания (п. 11) — как раньше, по всем.
-- Отмечают только на сайте: автор — в форме («У кого-то было по-другому?»), Комиссия — в правке заявки. Бот — как раньше.
alter table public.visit_players add column duration_min int check (duration_min >= 60);

-- Комиссия правит длительность участника в правке заявки; остальное в строке компании по-прежнему не меняется никем
-- (её правку закрыли 26.09, см. 20260926260000_visit_guards.sql) — право только на это поле и только Комиссии
grant update (duration_min) on public.visit_players to authenticated;
create policy "Комиссия правит длительность" on public.visit_players for update to authenticated
  using (public.is_commission()) with check (public.is_commission());

-- поход с сайта — со своей длительностью попутчиков (p_durations); тело — как в 20261010194119_visit_for_player.sql
drop function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[], uuid);
create function public.submit_visit(p_bath_id bigint, p_new_bath jsonb, p_bath_type text, p_entered_at timestamptz,
  p_duration_min int, p_companions uuid[], p_player uuid default null, p_durations jsonb default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.me();
  v_author uuid := coalesce(p_player, public.me());
  v_new jsonb := nullif(p_new_bath, 'null'::jsonb);
  v_bath bigint := p_bath_id;
  v_season int := coalesce((select (value #>> '{}')::int from settings where key = 'season'),
                           extract(year from now() at time zone 'Europe/Moscow')::int);
  v_visit bigint;
begin
  if v_me is null then raise exception 'Отмечать походы могут участники лиги'; end if;
  if v_author <> v_me and not public.is_commission() then raise exception 'Поход за другого заводит только Комиссия'; end if;
  if not exists (select 1 from players where id = v_author) then raise exception 'Нет такого участника'; end if;
  if (v_bath is null) = (v_new is null) then raise exception 'Укажи баню: из справочника или новую'; end if;
  if p_duration_min is null or p_duration_min < 60 then raise exception 'Поход засчитывается от часа'; end if;
  if p_entered_at is null or p_entered_at > now() + interval '10 minutes' then raise exception 'Время захода ещё не наступило'; end if;
  if extract(year from p_entered_at at time zone 'Europe/Moscow') <> v_season then
    raise exception 'Поход не из сезона %', v_season;
  end if;
  if p_bath_type is not null and p_bath_type not in ('public', 'spa', 'private') then
    raise exception 'Нет такого типа: %', p_bath_type;
  end if;

  if v_new is not null then
    v_bath := public.submit_visit_bath(v_new, v_me);   -- новую баню завёл тот, кто вносит
  elsif not exists (select 1 from baths where id = v_bath and status <> 'rejected') then
    raise exception 'Нет такой бани';
  end if;
  -- тип со слов автора — только пустой, как в suggest_bath_type
  if p_bath_type is not null then
    update baths set type = p_bath_type where id = v_bath and type is null and status <> 'rejected';
  end if;

  insert into visits (bath_id, entered_at, duration_min, created_by, entered_by, source, status)
  values (v_bath, p_entered_at, p_duration_min, v_author, nullif(v_me, v_author), 'site', 'pending')
  returning id into v_visit;
  -- автор всегда в компании; повторы, сам автор и неизвестные id из списка отбрасываются.
  -- Комиссия, которая вносит, в компании — только если сама себя отметила попутчиком
  -- своя длительность попутчика (p_durations: {id участника: минуты}) — только если не как у похода; у автора — длительность похода
  insert into visit_players (visit_id, player_id, duration_min)
  select v_visit, v_author, null::int
  union
  select v_visit, p.id, nullif((p_durations ->> p.id::text)::int, p_duration_min)
  from players p where p.id = any(coalesce(p_companions, '{}')) and p.id <> v_author;

  return jsonb_build_object('visit_id', v_visit, 'bath_id', v_bath);
end $$;

revoke all on function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[], uuid, jsonb) from public, anon;
grant execute on function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[], uuid, jsonb) to authenticated;
