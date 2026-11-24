-- Кубок (24.11): итоги тура Комиссия принимает в личке у бота, а не на вкладке «Кубок» (docs/cup.md, «Переходы»).
-- Тур сыгран — бот сам считает предложение и шлёт его каждому участнику Комиссии с кнопками «Принять» / «Другой жребий».
-- Для этого у cup_propose / cup_accept появляется вход для сервера: *_by(…, p_by) — кто решил, передаёт бот
-- (он уже проверил, что кнопку нажал участник Комиссии). Вход с сайта остаётся прежним и зовёт те же функции.

-- что бот написал Комиссии про итоги тура: чтобы не писать дважды и править сообщения у всех после решения
create table public.cup_asks (
  round int primary key references public.cup_rounds(n),
  text text not null,                           -- что сейчас в сообщениях: очки изменились — текст другой, сообщения правятся
  messages jsonb not null default '[]'::jsonb,  -- [{chat, msg}] — по сообщению на участника Комиссии
  asked_at timestamptz not null default now()
);
alter table public.cup_asks enable row level security;
revoke all on public.cup_asks from anon, authenticated;
grant all on public.cup_asks to service_role;

create function public.cup_propose_by(p_round int, p_redraw boolean, p_by uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row cup_transitions; v_new jsonb;
begin
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
  insert into cup_transitions (round, proposal, basis, proposed_by) values (p_round, v_new - 'basis', v_new->>'basis', p_by)
  on conflict (round) do update set proposal = excluded.proposal, basis = excluded.basis, proposed_by = excluded.proposed_by, proposed_at = now();
  return v_new - 'basis';
end $$;
revoke all on function public.cup_propose_by(int, boolean, uuid) from public, anon, authenticated;
grant execute on function public.cup_propose_by(int, boolean, uuid) to service_role;

create function public.cup_accept_by(p_round int, p_by uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row cup_transitions; v_team jsonb; v_id int;
begin
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
  update cup_transitions set accepted_by = p_by, accepted_at = now() where round = p_round;
end $$;
revoke all on function public.cup_accept_by(int, uuid) from public, anon, authenticated;
grant execute on function public.cup_accept_by(int, uuid) to service_role;

-- вход с сайта: проверка «это Комиссия» — здесь, дело — в *_by
create or replace function public.cup_propose(p_round int, p_redraw boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  return public.cup_propose_by(p_round, p_redraw, public.me());
end $$;

create or replace function public.cup_accept(p_round int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  perform public.cup_accept_by(p_round, public.me());
end $$;
