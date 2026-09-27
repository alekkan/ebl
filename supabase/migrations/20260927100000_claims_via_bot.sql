-- Заявки «это я» — тоже через бота. Раньше их было видно только на сайте («Стол Комиссии»): Комиссия не знала о заявке,
-- а пост нового участника бот отклонял и забывал. Теперь:
--  - выбрал ник (claim_nick) → Комиссии в личку уведомление с кнопками (tg-bot?claim=<id>);
--  - ник подтвердили (кнопкой бота или на сайте) → бот гасит уведомления и превращает отложенный пост участника
--    в карточку похода (tg-bot?linked=<id>).
create table public.claim_notices (
  account_id uuid primary key references public.player_accounts(id) on delete cascade,
  nick text not null,                          -- какой ник подтверждает кнопка: заявку могли поменять после уведомления
  messages jsonb not null default '[]',        -- [{chat, msg}] — уведомления в личке Комиссии
  created_at timestamptz not null default now()
);
alter table public.claim_notices enable row level security;
grant all on public.claim_notices to service_role;

create function public.notify_account_claim() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is null then return new; end if;
  if new.player_id is not null and old.player_id is null then
    perform net.http_post(url := base || '/tg-bot?linked=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb);
  elsif new.player_id is null and new.claimed_nick is not null and new.claimed_nick is distinct from old.claimed_nick then
    perform net.http_post(url := base || '/tg-bot?claim=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb);
  end if;
  return new;
end $$;

create trigger player_accounts_notify after update of player_id, claimed_nick on public.player_accounts
for each row execute function public.notify_account_claim();
