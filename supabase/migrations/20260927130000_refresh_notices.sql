-- Поход поправили — компанию, баню, время захода или длительность (на сайте, кнопкой «долгая», прямо в базе), —
-- бот обновляет сводку в сообщениях Комиссии в личке и в карточке в чате (tg-bot?refresh=<id>). Иначе там
-- оставалось старое: добавили Дена в поход Alex B, а у Комиссии висело «👥 один» (27.09.2026).
-- Зовём, только если обновлять есть что: уведомления уже разосланы или у похода есть живая карточка.
create function public.notify_visit_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text := (select value #>> '{}' from settings where key = 'functions_url');
  vid bigint;
begin
  if tg_table_name = 'visits' then vid := new.id;
  elsif tg_op = 'DELETE' then vid := old.visit_id;
  else vid := new.visit_id;
  end if;
  if base is not null and (exists (select 1 from bot_notifications where visit_id = vid)
                           or exists (select 1 from bot_posts where visit_id = vid and card_text is not null)) then
    perform net.http_post(url := base || '/tg-bot?refresh=' || vid,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb);
  end if;
  return coalesce(new, old);
end $$;

create trigger visit_players_changed after insert or delete on public.visit_players
for each row execute function public.notify_visit_changed();

create trigger visits_changed after update of bath_id, duration_min, entered_at on public.visits
for each row when (old.bath_id is distinct from new.bath_id or old.duration_min is distinct from new.duration_min
                   or old.entered_at is distinct from new.entered_at)
execute function public.notify_visit_changed();
