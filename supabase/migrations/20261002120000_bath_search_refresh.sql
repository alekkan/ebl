-- 1. Поиск бани ботом без разницы «е»/«ё»: в справочнике «Лёгкий пар», а пишут «Легкий пар» — бот не находил (01.10).
alter table public.baths add column name_search text generated always as (lower(translate(name, 'Ёё', 'Ее'))) stored;

-- 2. У бани поменяли название, тип, регион или страну — бот обновляет свои сообщения о свежих походах в неё: тип в сводке
--    и очки в строке «Засчитано» (02.10 Комиссия поменяла «Хуитнес» на «Общественная», а в чате остались «Хуитнес» и «+5»).
--    tg-bot?bath=<id> сам пересчитывает таблицу и правит карточки; зовём, только если такие сообщения есть.
create function public.notify_bath_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare base text := (select value #>> '{}' from settings where key = 'functions_url');
begin
  if base is not null
     and (new.name, new.type, new.region, new.country) is distinct from (old.name, old.type, old.region, old.country)
     and exists (select 1 from visits v join bot_posts p on p.visit_id = v.id
                 where v.bath_id = new.id and v.created_at > now() - interval '30 days') then
    perform net.http_post(url := base || '/tg-bot?bath=' || new.id, headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb, timeout_milliseconds := 60000);
  end if;
  return new;
end $$;
create trigger baths_notify_changed after update of name, type, region, country on public.baths
for each row execute function public.notify_bath_changed();
