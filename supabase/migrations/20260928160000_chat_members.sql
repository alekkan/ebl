-- Кого бот знает в чате — для «@eblany» (позвать всех, docs/bot.md). Список участников группы Telegram ботам не отдаёт:
-- он собран разово владельцем (28.09, из Telegram Web) и дальше пополняется по сообщениям о входе и выходе из чата.
-- Только номер аккаунта и имя — без переписки. Видят только функции.
create table public.chat_members (
  chat_id bigint not null,
  tg_id bigint not null,
  name text,                 -- имя из Telegram; пусто — бот спросит его у Telegram (getChatMember) при первом вызове
  added_at timestamptz not null default now(),
  primary key (chat_id, tg_id)
);
alter table public.chat_members enable row level security;
grant all on public.chat_members to service_role;
