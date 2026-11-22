-- Кубок: сообщения бота в чат лиги (23.11) — старт первого тура и итоги каждого тура после принятия Комиссией.
-- Шлёт функция week-results (её уже зовёт pg_cron каждые 5 минут); здесь — отметки «уже объявлено», чтобы не повторяться.
create table public.cup_posts (
  round int primary key,        -- 0 — старт кубка, 1…5 — итоги тура
  accepted_at timestamptz,      -- какое принятие итогов объявлено: отменили и приняли заново — выйдет уточнение
  chat_id bigint not null,
  message_id bigint,
  posted_at timestamptz not null default now()
);
alter table public.cup_posts enable row level security;
revoke all on public.cup_posts from anon, authenticated;   -- на стенде права раздаются по умолчанию — снимаем явно
grant all on public.cup_posts to service_role;
