-- Походы прошлых сезонов, которые при загрузке таблицы 26.09 ушли в соседнее отделение (22.10, ответы Витька):
-- «Малевича бани» 2025 — мужской, в гранд вип был только Миша П (2026); «Серпухов, Городские» 2023 — женский (Витёк);
-- «Казань, баня 7» 2023 — первый разряд (в высшем Махмуд был в 2024). После — пересчёт таблицы.
begin;
update public.legacy_visits set bath_id = 645 where bath_id = 644 and year = 2025 and nick in ('Диман', 'Фил', 'Хвост');
update public.legacy_visits set bath_id = 609 where bath_id = 610 and year = 2023 and nick = 'Витёк';
update public.legacy_visits set bath_id = 793 where bath_id = 792 and year = 2023 and nick = 'Махмуд';
commit;
