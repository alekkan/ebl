-- Убрали человека из похода (03.11: Женёк по ошибке отметил Леху в «91 sauna», потом поменяли на «Леху С») — его просьба
-- оценить баню остаётся в очереди, и бот шлёт «Напоминаю: оцени …» тому, кого там не было. Снимаем её вместе с участником.
create function public.drop_rating_ask() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from rating_asks where visit_id = old.visit_id and player_id = old.player_id;
  return old;
end $$;
create trigger visit_players_drop_rating_ask after delete on public.visit_players
  for each row execute function public.drop_rating_ask();

-- уже оставшиеся хвосты — те, кого в походе больше нет
delete from public.rating_asks ra
where not exists (select 1 from public.visit_players vp where vp.visit_id = ra.visit_id and vp.player_id = ra.player_id);
