-- Сообщение с кнопкой в чат по просьбе владельца (02.11: «Отметить поход» в закрепе группы) — тем же путём, что реакции
-- и опросы: строка в bot_actions (только service_role), бот отправляет. payload — {text, label, start}: текст сообщения,
-- подпись кнопки и что открыть в мини-приложении (t.me/<бот>?startapp=<start>, по умолчанию visit — форма похода).
alter table public.bot_actions drop constraint bot_actions_kind_check;
alter table public.bot_actions add constraint bot_actions_kind_check check (kind in ('react', 'poll', 'button'));
