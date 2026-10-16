-- Опрос в чат по просьбе владельца (16.10: название банного портала для всех) — тем же путём, что и реакции: пишем строку
-- в bot_actions (только service_role), бот отправляет. payload — {question, options: [...], multiple, anonymous};
-- номер сообщения с опросом бот записывает в message_id после отправки.
alter table public.bot_actions drop constraint bot_actions_kind_check;
alter table public.bot_actions add constraint bot_actions_kind_check check (kind in ('react', 'poll'));
alter table public.bot_actions alter column message_id drop not null;
alter table public.bot_actions add column payload jsonb;
