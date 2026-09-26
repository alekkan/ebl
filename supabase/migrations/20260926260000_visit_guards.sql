-- Дыры в правах на журнал походов.

-- 1. Участник мог переписать свою строку компании (visit_id) и «переехать» в чужой засчитанный поход.
-- Правка строк нужна была только для фото долгого (has_proof, photos) — долгий теперь на доверии.
-- Комиссия правит компанию удалением и вставкой строк, её политики на insert/delete остаются.
drop policy if exists "каждый сам подтверждает долгий поход" on public.visit_players;
revoke update on public.visit_players from authenticated;

-- 2. Поход с сайта: служебные поля ставит база, а не участник. Иначе можно задним числом попасть в закрытую
-- неделю (posted_at), притвориться ботом и не разбудить Комиссию (source), подсунуть чужую ссылку (tg_link)
-- или погасить вопрос «Долгая была?» (long_asked_at). Бот (service_role) и SQL из консоли — без изменений.
create function public.visits_site_defaults() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.role() = 'authenticated' then
    new.posted_at := now();
    new.created_at := now();
    new.source := 'site';
    new.tg_link := null;
    new.long_asked_at := null;
    new.moderated_at := null;
    new.reject_reason := null;
  end if;
  return new;
end $$;

create trigger visits_site_defaults before insert on public.visits
for each row execute function public.visits_site_defaults();

-- 3. Тип отклонённой бани участник не размечает — она не в справочнике.
create or replace function public.suggest_bath_type(p_bath bigint, p_type text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.me() is null then raise exception 'Тип бани отмечают участники лиги'; end if;
  if p_type not in ('public', 'spa', 'private') then raise exception 'Нет такого типа: %', p_type; end if;
  update baths set type = p_type where id = p_bath and type is null and status <> 'rejected';
end $$;
