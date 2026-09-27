-- Отзывов на баню у участника может быть несколько: сходил ещё раз — написал ещё. Раньше новый отзыв затирал старый
-- (замечание Махмуда, 27.09.2026). Свой отзыв можно удалить, Комиссия удаляет любой — политики те же.
alter table public.reviews drop constraint if exists reviews_bath_id_player_id_key;
create index if not exists reviews_bath on public.reviews (bath_id, created_at desc);

-- «Долгая была?» бот больше сам не спрашивает — баню отмечают сразу после входа, а про долгую участник пишет сам:
-- отмечает бота и пишет «долгая» через 2,5–8 часов после захода. Чат лиги не захламляется вопросами.
select cron.unschedule(jobname) from cron.job where jobname = 'ebl-bot-long-ask';
