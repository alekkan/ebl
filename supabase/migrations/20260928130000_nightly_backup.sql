-- Ночной бэкап в Яндекс (функция backup → бакет ebl-backups): таблицы public сжатым JSON и аватарки, хранятся 30 дней.
-- 03:30 МСК — после ночного пересчёта (00:05) и итогов недели. Одна копия в сутки — лишние вызовы функция пропускает.
select cron.schedule(
  'ebl-nightly-backup',
  '30 0 * * *',   -- 00:30 UTC = 03:30 МСК
  $$ select net.http_post(
       url := 'https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/backup',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb,
       timeout_milliseconds := 120000) $$
);
