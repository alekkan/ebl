-- Как вернуть datafix_2026-10-28_shibuya.sql: 1119 снова баня лиги, походы 2023/2024 — обратно в неё.
begin;
update public.baths set status = 'ok' where id = 1119;
update public.legacy_visits set bath_id = 1119
 where bath_id = 1018 and (year, nick) in ((2023, 'Женёк В'), (2024, 'Женёк В'), (2024, 'Шурик'));
commit;
