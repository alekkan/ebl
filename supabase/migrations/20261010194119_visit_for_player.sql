-- Комиссия заводит поход за другого участника — только на сайте (решение лиги 10.10.2026): Витёк отмечает баню Шурика,
-- сам в ней не будучи. Поход — Шурика (created_by, он в компании), а кто внёс — в entered_by: видно в ленте, в посте бота
-- и в уведомлении Комиссии. Дальше — обычный путь: ждёт Комиссию, решение — в чат лиги.
alter table public.visits add column entered_by uuid references public.players(id);
comment on column public.visits.entered_by is 'Комиссия внесла поход за участника (created_by); пусто — внёс сам автор';

-- участник напрямую в таблицу «внесла Комиссия» не пишет: подделать подпись Комиссии нельзя
create or replace function public.visits_site_defaults() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    new.posted_at := now();
    new.created_at := now();
    new.source := 'site';
    new.tg_link := null;
    new.long_asked_at := null;
    new.moderated_at := null;
    new.reject_reason := null;
    if new.entered_by is not null and not public.is_commission() then new.entered_by := null; end if;
  end if;
  return new;
end $$;

-- p_player — за кого поход (только Комиссия; пусто — за себя). Прежняя подпись без него — заменяется:
-- старая страница, которая зовёт без p_player, попадает сюда же (значение по умолчанию).
drop function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[]);
create function public.submit_visit(p_bath_id bigint, p_new_bath jsonb, p_bath_type text, p_entered_at timestamptz,
  p_duration_min int, p_companions uuid[], p_player uuid default null) returns jsonb
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
  insert into visit_players (visit_id, player_id)
  select v_visit, v_author
  union
  select v_visit, p.id from players p where p.id = any(coalesce(p_companions, '{}')) and p.id <> v_author;

  return jsonb_build_object('visit_id', v_visit, 'bath_id', v_bath);
end $$;

revoke all on function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[], uuid) from public, anon;
grant execute on function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[], uuid) to authenticated;
