-- Фото профиля из Telegram: tg-login кладёт photo_url в аккаунт, триггер переносит его участнику.
-- У участника фото видно всем (как ник), в аккаунте хранится вместе с остальными данными Telegram.
alter table public.players add column photo_url text;
alter table public.player_accounts add column tg_photo text;

create function public.sync_player_photo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.player_id is not null and new.tg_photo is not null then
    update players set photo_url = new.tg_photo where id = new.player_id and photo_url is distinct from new.tg_photo;
  end if;
  return new;
end $$;

create trigger player_accounts_photo
after insert or update of player_id, tg_photo on public.player_accounts
for each row execute function public.sync_player_photo();
