-- Триггеры зовут бота через pg_net со сроком ожидания по умолчанию 5 секунд. Холодная функция (только проснулась) с паузой
-- в ?refresh (1,5 с) и сборкой сводки не успевает — запрос обрывается, и правка сообщения Комиссии теряется молча
-- (07.10 так падала проверка «добавили Дена — сообщение Комиссии обновилось»). Ждём до 30 секунд, как у остальных вызовов.
create or replace function public.announce_verdict() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.status in ('ok', 'rejected') and new.status is distinct from old.status
     and (new.source = 'site' or exists (select 1 from bot_posts where visit_id = new.id)) then
    perform net.http_post(url := base || '/tg-bot?verdict=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
  return new;
end $$;

create or replace function public.notify_account_claim() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is null then return new; end if;
  if new.player_id is not null and old.player_id is null then
    perform net.http_post(url := base || '/tg-bot?linked=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  elsif new.player_id is null and new.claimed_nick is not null and new.claimed_nick is distinct from old.claimed_nick then
    perform net.http_post(url := base || '/tg-bot?claim=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
  return new;
end $$;

create or replace function public.notify_site_visit() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.source = 'site' then
    perform net.http_post(url := base || '/tg-bot?new=' || new.id,
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
    perform net.http_post(url := base || '/tg-bot?refresh=' || vid,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000);
  end if;
  return coalesce(new, old);
end $$;
