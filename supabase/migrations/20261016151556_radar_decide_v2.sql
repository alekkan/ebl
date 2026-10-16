-- Радар, удобство для Комиссии (16.10): при заведении можно сразу выбрать тип (общественная / хуитнес / частная —
-- на грани бывает), а при скрытии — причину одним нажатием (не баня, аренда, хуитнес, закрыта, дубль). Причины —
-- ещё и метки для модуля: следующий прогон не предложит то же самое и научится на решениях Комиссии.
alter table public.radar_places add column hide_reason text
  check (hide_reason in ('not_bath', 'rental', 'spa', 'closed', 'duplicate', 'other'));

drop function public.radar_decide(bigint, text, bigint);
create function public.radar_decide(p_id bigint, p_action text, p_bath bigint default null,
                                    p_type text default 'public', p_reason text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare r public.radar_places; v_bath bigint;
begin
  if not public.is_commission() then raise exception 'Решает только Комиссия'; end if;
  select * into r from public.radar_places where id = p_id for update;
  if not found then raise exception 'Места нет в радаре'; end if;
  if p_action = 'add' then
    if p_type not in ('public', 'spa', 'private') then raise exception 'Неизвестный тип бани %', p_type; end if;
    if r.status = 'added' and r.bath_id is not null then return r.bath_id; end if;   -- двойное нажатие — та же баня
    insert into public.baths (name, type, lat, lng, precision, status, created_by)
    values (r.name, p_type, r.lat, r.lng, case when r.lat is null then null else 'exact' end, 'ok', public.me())
    returning id into v_bath;
    update public.radar_places set status = 'added', bath_id = v_bath, hide_reason = null, decided_by = public.me(), decided_at = now() where id = p_id;
    return v_bath;
  elsif p_action = 'match' then
    if p_bath is null or not exists (select 1 from public.baths where id = p_bath) then raise exception 'Нет такой бани в лиге'; end if;
    update public.radar_places set status = 'matched', bath_id = p_bath, hide_reason = null, decided_by = public.me(), decided_at = now() where id = p_id;
    return p_bath;
  elsif p_action = 'hide' then
    update public.radar_places set status = 'hidden', hide_reason = coalesce(p_reason, 'other'), decided_by = public.me(), decided_at = now() where id = p_id;
  elsif p_action = 'reopen' then
    update public.radar_places set status = 'new', bath_id = null, hide_reason = null, decided_by = null, decided_at = null where id = p_id;
  else
    raise exception 'Неизвестное действие %', p_action;
  end if;
  return null;
end $$;
revoke execute on function public.radar_decide(bigint, text, bigint, text, text) from public;
grant execute on function public.radar_decide(bigint, text, bigint, text, text) to authenticated, service_role;
