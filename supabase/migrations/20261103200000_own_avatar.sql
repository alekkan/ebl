-- Своя аватарка с сайта (03.11): у кого фото в Telegram скрыто от ботов или кому не нравится — загружает сам.
-- Файл — avatars/own/<id участника>.jpg (браузер сам обрезает до квадрата и уменьшает), писать — только свой файл.
-- Свою аватарку бот больше не трогает: tg_photo_src = 'own' — sync-avatars и вход через Telegram её пропускают.
create policy "avatars: своя аватарка — загрузить" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and name = 'own/' || public.me()::text || '.jpg');
create policy "avatars: своя аватарка — заменить" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and name = 'own/' || public.me()::text || '.jpg')
  with check (bucket_id = 'avatars' and name = 'own/' || public.me()::text || '.jpg');
-- upsert в Storage сначала читает объект — без select замена своего файла не проходит
create policy "avatars: своя аватарка — прочитать" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and name = 'own/' || public.me()::text || '.jpg');

-- p_url — ссылка на свой файл в бакете (на стенде — локальный Supabase) (с ?v= для сброса кэша); null — вернуть фото из Telegram
create function public.set_my_photo(p_url text) returns void
language plpgsql security definer set search_path = public as $$
declare pid uuid := public.me();
begin
  if pid is null then raise exception 'Сначала войди и выбери свой ник'; end if;
  if p_url is not null and p_url !~ ('^(https://[a-z0-9]+\.supabase\.co|http://(127\.0\.0\.1|localhost):[0-9]+)/storage/v1/object/public/avatars/own/' || pid::text || '\.jpg\?v=[0-9]+$') then
    raise exception 'Не та ссылка на фото';
  end if;
  if p_url is null then
    -- фото из Telegram вернёт следующий вход или еженедельная сверка; до того — инициалы
    update player_accounts set tg_photo = null, tg_photo_src = null where auth_user = auth.uid() and player_id = pid;
    update players set photo_url = null where id = pid;
  else
    update player_accounts set tg_photo = p_url, tg_photo_src = 'own' where auth_user = auth.uid() and player_id = pid;
    update players set photo_url = p_url where id = pid;
  end if;
end $$;
revoke all on function public.set_my_photo(text) from public, anon;
grant execute on function public.set_my_photo(text) to authenticated;
