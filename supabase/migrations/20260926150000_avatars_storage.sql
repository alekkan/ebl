-- Фото профиля храним у себя: бакет avatars (публичный на чтение, пишут только edge-функции).
-- player_accounts.tg_photo — ссылка на наше хранилище, tg_photo_src — по чему понимаем, что фото в Telegram сменилось.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

alter table public.player_accounts add column tg_photo_src text;

-- еженедельная сверка фото: понедельник 04:00 МСК
select cron.schedule(
  'ebl-weekly-avatars',
  '0 1 * * 1',
  $$ select net.http_post(
       url := 'https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/sync-avatars',
       headers := '{"Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb) $$
);
