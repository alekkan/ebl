-- Вход через бота (16.10): виджет Telegram просит номер телефона и подтверждение на отдельной странице — долго и непривычно.
-- Теперь сайт заводит одноразовый код, человек подтверждает его в боте: по ссылке «Войти через бота» (телефон), по QR
-- с экрана компьютера или прислав код в личку. Сайт опрашивает tg-login и, как только бот отметил «✅ Да, это я»,
-- получает сессию. Опросить код может только браузер, который его завёл: у него секрет, а в базе — только его хэш.
create table public.login_codes (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  secret_hash text not null,                         -- sha256 секрета: сам код виден на экране и в QR — по нему сессию не забрать
  device text,                                       -- «Chrome, Mac» — бот показывает, куда входят
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  tg_id bigint, tg_username text, tg_name text,      -- кто подтвердил в боте
  confirmed_at timestamptz,
  denied_at timestamptz,                             -- «✖️ Нет, не я» — сайт перестаёт ждать
  used_at timestamptz                                -- сайт забрал сессию: второй раз по коду не войти
);
alter table public.login_codes enable row level security;
grant all on public.login_codes to service_role;    -- пишут и читают только функции (tg-login, бот)

-- коды живут 10 минут, хранить их незачем: ночью подчищаем
select cron.schedule('ebl-login-codes-trim', '45 3 * * *', $$delete from public.login_codes where created_at < now() - interval '1 day'$$);
