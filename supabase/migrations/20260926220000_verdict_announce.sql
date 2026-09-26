-- Решение Комиссии объявляется в Telegram одинаково, откуда бы его ни приняли: кнопками бота, на сайте, правкой заявки.
-- Смена статуса на ok/rejected будит бота (tg-bot?verdict=<id>): 👍/💩 на пост и карточку, итог ответом на пост,
-- в личке Комиссии — кто решил. Одно объявление на решение: bot_posts.announced — последний объявленный статус.
alter table public.bot_posts add column announced text;
-- текст уведомления Комиссии — чтобы дописать к нему решение, даже если приняли его не кнопкой
alter table public.bot_notifications add column text text;

-- уже объявленное ботом не повторяем
update public.bot_posts bp set announced = v.status
from public.visits v where v.id = bp.visit_id and v.status in ('ok', 'rejected');

-- куда звать бота; на локальном стенде — удалить или поменять на локальный адрес (иначе триггер дёргает боевого бота)
insert into public.settings (key, value)
values ('functions_url', '"https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1"')
on conflict (key) do nothing;

create function public.announce_verdict() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null and new.status in ('ok', 'rejected') and new.status is distinct from old.status
     and exists (select 1 from bot_posts where visit_id = new.id) then
    perform net.http_post(
      url := base || '/tg-bot?verdict=' || new.id,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb);
  end if;
  return new;
end $$;

create trigger visits_announce_verdict after update of status on public.visits
for each row execute function public.announce_verdict();
