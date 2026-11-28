-- «Syakinohoyu» (1129) — та же баня, что «Shirako no yu» (1028, 志楽の湯 в Кавасаки) (28.11, Женёк В).
-- Поход 2023 из 1129 — второй поход Женька В туда в 2023-м (подтвердил он сам): в 1028 за 2023 становится n = 2.
-- Строку 1129 удаляем (ключ legacy_visits — баня, год, ник), саму 1129 не удаляем, а отклоняем — с карты и списков пропадает.
begin;
update public.legacy_visits set n = n + 1 where bath_id = 1028 and year = 2023 and nick = 'Женёк В';
delete from public.legacy_visits where bath_id = 1129 and year = 2023 and nick = 'Женёк В';
update public.baths set status = 'rejected' where id = 1129;
commit;
