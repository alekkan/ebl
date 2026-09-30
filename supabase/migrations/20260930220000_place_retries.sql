-- Повторы геокодера для бань с точной точкой, у которых не определились страна или регион (п. 14 без них не считается).
-- Нет строки — баню спросят при ближайшем запуске (≤ 5 минут после того, как поставили точку); не ответил — следующая
-- попытка через 30 минут, 2 часа, 6 часов, дальше раз в сутки (tries — сколько раз уже спрашивали). Определились — строку удаляем.
create table public.bath_place_tries (
  bath_id bigint primary key references public.baths(id) on delete cascade,
  tries int not null default 0,
  next_at timestamptz not null default now()
);
alter table public.bath_place_tries enable row level security;
grant all on public.bath_place_tries to service_role;

-- ebl-fill-places: вместо раза в ночь — каждые 5 минут, но только если есть баня, которую пора спросить
select cron.schedule('ebl-fill-places', '*/5 * * * *', $$
  select net.http_post(
    url := (select value #>> '{}' from public.settings where key = 'functions_url') || '/tg-bot?fillplaces=1',
    headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 120000)
  where exists (select 1 from public.baths b left join public.bath_place_tries t on t.bath_id = b.id
                where b.status <> 'rejected' and b.precision = 'exact' and b.lat is not null
                  and (b.country is null or b.region is null) and (t.next_at is null or t.next_at <= now()));
$$);
