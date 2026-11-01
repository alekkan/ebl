-- Уведомления о походах не теряются (01.11: поход Лехи с сайта — бот рассылал дольше 30 секунд, база не дождалась ответа,
-- в ОУД и Комиссии всё пришло с опозданием). Триггеры зовут бота с &bg=1: он сразу отвечает «принял» и рассылает уже после
-- ответа (EdgeRuntime.waitUntil). Страховка — проверка каждые 2 минуты (tg-bot?sweep=1): свежий поход с сайта без поста
-- в ОУД, свежее решение Комиссии без объявления — досылает. Повторов нет: бот сначала отмечает отправку в bot_posts.
create or replace function public.announce_verdict() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.status in ('ok', 'rejected') and new.status is distinct from old.status
     and (new.source = 'site' or exists (select 1 from bot_posts where visit_id = new.id)) then
    perform net.http_post(url := base || '/tg-bot?verdict=' || new.id || '&bg=1',
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
  return new;
end $$;

create or replace function public.notify_site_visit() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.source = 'site' then
    perform net.http_post(url := base || '/tg-bot?new=' || new.id || '&bg=1',
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
  return new;
end $$;

create or replace function public.notify_visit_changed() returns trigger
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
    perform net.http_post(url := base || '/tg-bot?refresh=' || vid || '&bg=1',
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
  return coalesce(new, old);
end $$;

select cron.schedule('ebl-notify-sweep', '*/2 * * * *', $$
  select net.http_post(
    url := (select value #>> '{}' from public.settings where key = 'functions_url') || '/tg-bot?sweep=1',
    headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
