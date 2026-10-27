-- Как вернуть datafix_2026-10-27_kamata.sql: 1067 снова баня лиги, поход 2023 Женька В — обратно в неё.
begin;
update public.baths set status = 'ok' where id = 1067;
update public.legacy_visits set bath_id = 1067 where bath_id = 1053 and year = 2023 and nick = 'Женёк В';
commit;
