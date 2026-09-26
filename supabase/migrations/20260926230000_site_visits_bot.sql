-- Походы с сайта идут тем же путём, что из чата: Комиссии в личку — уведомление с кнопками (tg-bot?new=<id>),
-- решение — в чат лиги отдельным сообщением (поста в группе, на который можно ответить, у такого похода нет).
alter table public.visits add column source text not null default 'site' check (source in ('site', 'bot'));
update public.visits v set source = 'bot' where exists (select 1 from public.bot_posts bp where bp.visit_id = v.id);

-- основной чат лиги — сюда бот объявляет решения по походам с сайта
insert into public.settings (key, value) values ('league_chat', '-1002192445671')
on conflict (key) do nothing;

create function public.notify_site_visit() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.source = 'site' then
    perform net.http_post(
      url := base || '/tg-bot?new=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb);
  end if;
  return new;
end $$;

create trigger visits_notify_site after insert on public.visits
for each row execute function public.notify_site_visit();

-- решение по походу с сайта тоже объявляем, хотя поста бота у него нет
create or replace function public.announce_verdict() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.status in ('ok', 'rejected') and new.status is distinct from old.status
     and (new.source = 'site' or exists (select 1 from bot_posts where visit_id = new.id)) then
    perform net.http_post(
      url := base || '/tg-bot?verdict=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb);
  end if;
  return new;
end $$;
