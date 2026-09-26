-- Бот просит геоточку для новых бань и бань с примерной точкой: запоминаем его вопрос, чтобы узнать ответ.
alter table public.bot_posts add column geo_msg bigint;
alter table public.bot_posts add column bath_id bigint references public.baths(id) on delete set null;
