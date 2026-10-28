-- Походы 2026 Арса и Женька В из листа Комиссии («Saunas», Токио) были не в Shibuya Saunas (1018),
-- а в 高輪SAUNAS (28.10, Женёк В). Заводим баню «Takanawa Saunas 高輪» с точкой и переносим туда оба похода 2026;
-- в 1018 остаются походы 2023/2024. region = null — регион/страну дозаполнит геокодер. После — пересчёт таблицы.
begin;
with b as (
  insert into public.baths (name, country, lat, lng, precision, status)
  values ('Takanawa Saunas 高輪', 'Япония', 35.63709048735781, 139.73995736007888, 'exact', 'ok')
  returning id
)
update public.legacy_visits set bath_id = (select id from b)
 where bath_id = 1018 and year = 2026 and nick in ('Арс', 'Женёк В');
commit;
