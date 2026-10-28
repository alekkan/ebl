-- «Omachi onsen» (1096) — та же баня, что «Yakushi no yu» (1141, 湯けむり屋敷 薬師の湯 в Омати, Нагано) (28.10, Женёк В).
-- Поход 2023 переносим в 1141 (там у Женька В только 2025), саму 1096 не удаляем, а отклоняем — с карты и списков
-- пропадает, вернуть можно. После — пересчёт таблицы.
begin;
update public.legacy_visits set bath_id = 1141 where bath_id = 1096 and year = 2023 and nick = 'Женёк В';
update public.baths set status = 'rejected' where id = 1096;
commit;
