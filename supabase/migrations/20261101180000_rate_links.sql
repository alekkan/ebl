-- Личная ссылка на оценку (01.11, Леха: мини-приложение грузится долго — «уникальную ссылку для каждого человека/похода и
-- открывать прямо в браузере Telegram»). У приглашения — секретный ключ; ссылка ebl.su/rate.html?t=<ключ> входит на сайт
-- под этим человеком (tg-login ?rate=1, 7 дней) и открывает лёгкую страницу оценки без карты и без загрузки всей лиги.
alter table public.rating_asks
  add column token text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') unique,
  add column created_at timestamptz not null default now();

-- странице оценки — ещё кто оценивает (отзыв пишется от его имени без загрузки всей лиги)
create or replace function public.rating_form(p_visit bigint) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('visit', v.id, 'bath', v.bath_id, 'name', b.name, 'country', b.country, 'entered_at', v.entered_at,
    'player', public.me(), 'nick', (select nick from players where id = public.me()),
    'allowed', public.me() is not null and v.status = 'ok' and exists (select 1 from visit_players vp where vp.visit_id = v.id and vp.player_id = public.me())
      and v.entered_at >= (select (value #>> '{}')::date from settings where key = 'rating_since'),
    'why', case when public.me() is null then 'login'
                when not exists (select 1 from visit_players vp where vp.visit_id = v.id and vp.player_id = public.me()) then 'stranger'
                when v.status <> 'ok' then 'pending'
                when v.entered_at < (select (value #>> '{}')::date from settings where key = 'rating_since') then 'old' end,
    'scores', (select json_build_object('stove', r.stove, 'steam', r.steam, 'aqua', r.aqua, 'outdoor', r.outdoor, 'kitchen', r.kitchen,
                 'atmosphere', r.atmosphere, 'service', r.service, 'prices', r.prices)
               from bath_ratings r where r.visit_id = v.id and r.player_id = public.me()))
  from visits v join baths b on b.id = v.bath_id where v.id = p_visit
$$;
