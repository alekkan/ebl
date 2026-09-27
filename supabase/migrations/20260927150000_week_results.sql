-- Итоги недели в чат лиги (функция week-results): картинка с пьедесталом и подпись — один раз на неделю, когда по закрытой
-- неделе всё решено (нет походов на проверке, новых бань на согласовании, недописанных черновиков). Просьба лиги 27.09.2026.
create table public.week_posts (
  season int not null,
  week int not null,
  chat_id bigint not null,
  message_id bigint,
  posted_at timestamptz not null default now(),
  primary key (season, week)
);
alter table public.week_posts enable row level security;
grant all on public.week_posts to service_role;

-- проверка каждые 5 минут: сама функция решает, пора ли (с 23:00 воскресенья до конца среды, всё решено, ещё не постили)
select cron.schedule(
  'ebl-week-results',
  '*/5 * * * *',
  $$ select net.http_post(
       url := 'https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/week-results',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
