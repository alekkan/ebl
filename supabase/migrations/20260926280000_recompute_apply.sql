-- Запись результата пересчёта одной транзакцией. Раньше recompute отдельно обновлял standings, стирал visit_points
-- и вставлял заново: два пересчёта подряд (решение на сайте + кнопка в боте) сталкивались на ключах visit_points,
-- а сайт между удалением и вставкой видел ленту без очков. Теперь пересчёты пишут по очереди и целиком.
-- Зовёт только edge-функция recompute (service_role).
create function public.recompute_apply(p_standings jsonb, p_points jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('ebl:recompute'));

  insert into standings (nick, total, baths, u, uu, long, k, pub, reg, week_pts, week_baths, updated_at)
  select nick, total, baths, u, uu, long, k, pub, reg,
         coalesce(week_pts, '{}'), coalesce(week_baths, '{}'), coalesce(updated_at, now())
  from jsonb_populate_recordset(null::standings, p_standings)
  on conflict (nick) do update set
    total = excluded.total, baths = excluded.baths, u = excluded.u, uu = excluded.uu, long = excluded.long,
    k = excluded.k, pub = excluded.pub, reg = excluded.reg,
    week_pts = excluded.week_pts, week_baths = excluded.week_baths, updated_at = excluded.updated_at;
  -- ников, которых больше нет в расчёте (переименовали), в таблице не оставляем; пустой расчёт таблицу не стирает
  if jsonb_array_length(p_standings) > 0 then
    delete from standings where nick not in (select s ->> 'nick' from jsonb_array_elements(p_standings) s);
  end if;

  delete from visit_points where true;
  -- поход могли удалить, пока шёл расчёт — его очки пропускаем, а не роняем всю запись
  insert into visit_points (visit_id, nick, total, lines)
  select r.visit_id, r.nick, r.total, r.lines
  from jsonb_populate_recordset(null::visit_points, p_points) r
  where exists (select 1 from visits v where v.id = r.visit_id);
end $$;

revoke all on function public.recompute_apply(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.recompute_apply(jsonb, jsonb) to service_role;
