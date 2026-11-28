-- «Miyakoyu2» (1087, без точки) — та же баня, что «Miyakoyu» (1086, точная точка) (28.11, Женёк В).
-- Поход 2023 из 1087 — второй поход Женька В туда в 2023-м, как у Shirako no yu: в 1086 за 2023 становится n = 2.
-- Строку 1087 удаляем (ключ legacy_visits — баня, год, ник), саму 1087 не удаляем, а отклоняем — с карты и списков пропадает.
begin;
update public.legacy_visits set n = n + 1 where bath_id = 1086 and year = 2023 and nick = 'Женёк В';
delete from public.legacy_visits where bath_id = 1087 and year = 2023 and nick = 'Женёк В';
update public.baths set status = 'rejected' where id = 1087;
commit;
