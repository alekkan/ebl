-- Откат datafix_2026-11-28_shirako.sql: как было до слияния (28.11).
begin;
update public.legacy_visits set n = 1 where bath_id = 1028 and year = 2023 and nick = 'Женёк В';
insert into public.legacy_visits (bath_id, year, nick, n) values (1129, 2023, 'Женёк В', 1);
update public.baths set status = 'ok' where id = 1129;
commit;
