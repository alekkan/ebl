-- Поход с сайта одной транзакцией: новая баня, тип со слов автора, поход и компания — либо всё, либо ничего.
-- Раньше сайт делал это четырьмя запросами: обрыв посередине оставлял поход без компании или баню без похода,
-- а бот ждал 3 секунды, пока сайт допишет компанию. Уведомление триггера (pg_net) уходит после коммита.
-- p_new_bath: {name, country, region, type, lat, lng, precision}; ровно одно из p_bath_id / p_new_bath.
create function public.submit_visit(p_bath_id bigint, p_new_bath jsonb, p_bath_type text, p_entered_at timestamptz,
  p_duration_min int, p_companions uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.me();
  v_new jsonb := nullif(p_new_bath, 'null'::jsonb);
  v_bath bigint := p_bath_id;
  v_season int := coalesce((select (value #>> '{}')::int from settings where key = 'season'),
                           extract(year from now() at time zone 'Europe/Moscow')::int);
  v_visit bigint;
begin
  if v_me is null then raise exception 'Отмечать походы могут участники лиги'; end if;
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
    v_bath := public.submit_visit_bath(v_new, v_me);
  elsif not exists (select 1 from baths where id = v_bath and status <> 'rejected') then
    raise exception 'Нет такой бани';
  end if;
  -- тип со слов автора — только пустой, как в suggest_bath_type
  if p_bath_type is not null then
    update baths set type = p_bath_type where id = v_bath and type is null and status <> 'rejected';
  end if;

  insert into visits (bath_id, entered_at, duration_min, created_by, source, status)
  values (v_bath, p_entered_at, p_duration_min, v_me, 'site', 'pending')
  returning id into v_visit;
  -- автор всегда в компании; повторы, сам автор и неизвестные id из списка отбрасываются
  insert into visit_players (visit_id, player_id)
  select v_visit, v_me
  union
  select v_visit, p.id from players p where p.id = any(coalesce(p_companions, '{}')) and p.id <> v_me;

  return jsonb_build_object('visit_id', v_visit, 'bath_id', v_bath);
end $$;

-- новая баня от участника: ждёт Комиссию (status = pending), точка — только если есть обе координаты
create function public.submit_visit_bath(p jsonb, p_me uuid) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_name text := btrim(p ->> 'name');
  v_type text := nullif(p ->> 'type', '');
  v_lat double precision := nullif(p ->> 'lat', '')::double precision;
  v_lng double precision := nullif(p ->> 'lng', '')::double precision;
  v_prec text := nullif(p ->> 'precision', '');
  v_id bigint;
begin
  if jsonb_typeof(p) <> 'object' then raise exception 'Новая баня — объект с названием'; end if;
  if coalesce(length(v_name), 0) < 2 or length(v_name) > 200 then raise exception 'Название бани — от 2 до 200 символов'; end if;
  if v_type is not null and v_type not in ('public', 'spa', 'private') then raise exception 'Нет такого типа: %', v_type; end if;
  if (v_lat is null) <> (v_lng is null) or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
    raise exception 'Неверные координаты бани';
  end if;
  if v_lat is null then v_prec := null; else v_prec := coalesce(v_prec, 'exact'); end if;
  if v_prec is not null and v_prec not in ('exact', 'city', 'region', 'country') then raise exception 'Неверная точность точки: %', v_prec; end if;

  insert into baths (name, type, country, region, lat, lng, precision, status, created_by)
  values (v_name, v_type, nullif(btrim(p ->> 'country'), ''), nullif(btrim(p ->> 'region'), ''), v_lat, v_lng, v_prec, 'pending', p_me)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[]) from public, anon;
grant execute on function public.submit_visit(bigint, jsonb, text, timestamptz, int, uuid[]) to authenticated;
-- помощник снаружи не вызывается: иначе баню можно было бы завести от чужого имени
revoke all on function public.submit_visit_bath(jsonb, uuid) from public, anon, authenticated;
