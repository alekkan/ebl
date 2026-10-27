-- «Kamata sauna» (1067) — дубль «Garden Sauna Kamata» (1053): точки в 7 м друг от друга (27.10, Женёк В). Поход 2023
-- переносим в 1053 (там за 2023 записи Женька В нет), саму 1067 не удаляем, а отклоняем — с карты и списков пропадает,
-- вернуть можно. После — пересчёт таблицы.
begin;
update public.legacy_visits set bath_id = 1053 where bath_id = 1067 and year = 2023 and nick = 'Женёк В';
update public.baths set status = 'rejected' where id = 1067;
commit;
