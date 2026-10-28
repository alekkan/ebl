-- «Shibuya saunas» (1119) — та же баня, что «Shibuya Saunas» (1018, Сибуя, Токио; точки в 30 м) (28.10, Женёк В).
-- Походы 2023/2024 (Женёк В, Шурик) переносим в 1018 (там только 2026), саму 1119 не удаляем, а отклоняем —
-- с карты и списков пропадает, вернуть можно. После — пересчёт таблицы.
begin;
update public.legacy_visits set bath_id = 1018 where bath_id = 1119;
update public.baths set status = 'rejected' where id = 1119;
commit;
