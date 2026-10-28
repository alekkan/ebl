-- Как вернуть datafix_2026-10-28_takanawa.sql: походы 2026 — обратно в 1018, «Takanawa Saunas 高輪» удаляем.
begin;
update public.legacy_visits set bath_id = 1018
 where bath_id = (select id from public.baths where name = 'Takanawa Saunas 高輪') and year = 2026;
delete from public.baths where name = 'Takanawa Saunas 高輪';
commit;
