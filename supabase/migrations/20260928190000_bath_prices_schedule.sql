-- Цена бани разная в будни/выходные и часто со скидкой до какого-то часа («до 16:00») — добавляем это к цене,
-- а не заводим отдельную схему: та же история, тот же дубль-чек, просто два новых поля для сравнения.
alter table public.bath_prices add column is_weekend boolean;
alter table public.bath_prices add column before_time time;

drop function public.submit_bath_price(bigint, numeric, text, int);

create function public.submit_bath_price(p_bath_id bigint, p_price numeric, p_currency text, p_duration_min int,
                                          p_is_weekend boolean, p_before_time time) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.me();
  v_currency text := upper(coalesce(nullif(btrim(p_currency), ''), 'RUB'));
  v_last numeric;
  v_id bigint;
begin
  if v_me is null then raise exception 'Цены могут вносить участники лиги'; end if;
  if not exists (select 1 from baths where id = p_bath_id and status <> 'rejected') then
    raise exception 'Нет такой бани';
  end if;
  if p_price is null or p_price <= 0 then raise exception 'Цена должна быть больше нуля'; end if;
  if p_duration_min is not null and p_duration_min <= 0 then raise exception 'Время должно быть больше нуля'; end if;

  select price into v_last from bath_prices
  where bath_id = p_bath_id and currency = v_currency and coalesce(duration_min, -1) = coalesce(p_duration_min, -1)
    and is_weekend is not distinct from p_is_weekend and before_time is not distinct from p_before_time
  order by price_date desc, id desc limit 1;

  if v_last is not null and v_last = p_price then
    return null;   -- цена не изменилась — новую запись не пишем
  end if;

  insert into bath_prices (bath_id, price, currency, duration_min, is_weekend, before_time, created_by)
  values (p_bath_id, p_price, v_currency, p_duration_min, p_is_weekend, p_before_time, v_me)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.submit_bath_price(bigint, numeric, text, int, boolean, time) from public, anon;
grant execute on function public.submit_bath_price(bigint, numeric, text, int, boolean, time) to authenticated;
