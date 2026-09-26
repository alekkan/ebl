-- Telegram-бот: черновик похода (что уже понял бот из поста), карточка в группе и сообщения Комиссии.
-- Пишет и читает только edge-функция tg-bot (service role), поэтому политик нет.
create table public.bot_sessions (
  tg_id bigint primary key,             -- автор черновика: один черновик на человека
  state jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- пост в группе и карточка бота под ним — чтобы после решения Комиссии поставить реакцию и обновить карточку
create table public.bot_posts (
  visit_id bigint primary key references public.visits(id) on delete cascade,
  chat_id bigint not null,
  source_msg bigint not null,
  card_msg bigint,
  ask_msg bigint                        -- «Долгая была?» через 2,5 часа после захода
);

alter table public.visits add column long_asked_at timestamptz;

-- сообщения Комиссии с кнопками «Засчитать» / «Отклонить»
create table public.bot_notifications (
  visit_id bigint not null references public.visits(id) on delete cascade,
  chat_id bigint not null,
  message_id bigint not null,
  primary key (visit_id, chat_id)
);

alter table public.bot_sessions enable row level security;
alter table public.bot_posts enable row level security;
alter table public.bot_notifications enable row level security;
grant all on public.bot_sessions, public.bot_posts, public.bot_notifications to service_role;

-- раз в 10 минут бот спрашивает «Долгая была?» про походы, где с захода прошло 2,5 часа
select cron.schedule(
  'ebl-bot-long-ask',
  '*/10 * * * *',
  $$ select net.http_post(
       url := 'https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/tg-bot?tick=1',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
