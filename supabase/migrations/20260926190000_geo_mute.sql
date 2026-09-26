-- «Отстань» на вопрос про точку: не спрашивать про эту баню 30 дней; когда бот спросил — чтобы принять ответ без «Ответить».
alter table public.baths add column geo_mute_until timestamptz;
alter table public.bot_posts add column geo_at timestamptz;
