-- Комиссия подтвердила долгую (или сняла подтверждение) — бот пересчитывает таблицу и правит карточку похода в чате:
-- очки в строке «Засчитано» и пометку про долгую (24.11: после подтверждения в чате оставались старые очки).
-- Зовём, только если у похода есть карточка бота.
create function public.notify_long_ok() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and exists (select 1 from bot_posts where visit_id = new.id and card_text is not null) then
    perform net.http_post(url := base || '/tg-bot?long=' || new.id, headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb, timeout_milliseconds := 60000);
  end if;
  return new;
end $$;
create trigger visits_long_ok_changed after update of long_ok on public.visits
for each row when (old.long_ok is distinct from new.long_ok) execute function public.notify_long_ok();
