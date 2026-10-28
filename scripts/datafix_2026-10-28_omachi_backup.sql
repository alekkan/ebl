-- Как вернуть datafix_2026-10-28_omachi.sql: 1096 снова баня лиги, поход 2023 Женька В — обратно в неё.
begin;
update public.baths set status = 'ok' where id = 1096;
update public.legacy_visits set bath_id = 1096 where bath_id = 1141 and year = 2023 and nick = 'Женёк В';
commit;
