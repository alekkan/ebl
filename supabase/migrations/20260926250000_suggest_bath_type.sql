-- Тип бани со слов участника: при отметке похода в бане без типа сайт спрашивает, какая она.
-- Участник может только заполнить пустой тип; поменять размеченный — Комиссия (политика на baths).
create function public.suggest_bath_type(p_bath bigint, p_type text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.me() is null then raise exception 'Тип бани отмечают участники лиги'; end if;
  if p_type not in ('public', 'spa', 'private') then raise exception 'Нет такого типа: %', p_type; end if;
  update baths set type = p_type where id = p_bath and type is null;
end $$;

revoke all on function public.suggest_bath_type(bigint, text) from public, anon;
grant execute on function public.suggest_bath_type(bigint, text) to authenticated;
