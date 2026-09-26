-- Исправления справочника бань по аудиту данных 26.09.2026. Откат — scripts/datafix_2026-09-26_backup.sql.
-- На очки прошлых недель не влияет (остаток из таблицы зафиксирован), только на будущие походы и карту.
begin;
-- регион: одно написание (иначе ложный «новый регион» у того, кто был в том же регионе под другим названием)
update baths set region = 'Мекленбург-Передняя Померания' where region = 'Mecklenburg-Vorpommern';
update baths set region = 'Гамбург' where id in (58, 59, 60, 61) and name like 'Гамбург,%';
update baths set region = 'Шлезвиг-Гольштейн' where region = 'Schleswig-Holstein';
update baths set region = 'Московская обл' where region = 'Московская обл.';
update baths set region = 'Свердловская обл.' where region = 'Свердловская обл';
update baths set region = 'Саратовская обл' where region = 'Саратовская область';
update baths set region = 'Калужская обл.' where region = 'Калужская обл';
update baths set region = 'Рязанская обл' where region = 'Рязанская обл.';
update baths set region = 'Тульская обл' where region = 'Тульская обл.';
-- страна или регион перепутаны
update baths set country = 'Литва' where id = 125 and name = 'Латвия, Клайпедские';
update baths set country = 'Эстония' where id = 133 and name like 'Литва, Sillam%';
update baths set country = 'Бельгия' where id = 997 and name = 'Швейцария, Льеж спа';
update baths set region = 'Измир' where id = 958 and name like 'Стамбул%Cesme';
-- тип по названию: частные — частные, хуитнесы и аквапарки — не общественные
update baths set type = 'private' where id in (1004, 648, 668, 757, 819, 845) and name ilike '%частн%';
update baths set type = 'spa' where id in (65, 120, 131, 465, 466, 144) and (name ilike '%хуитнес%' or name ilike '%аквапарк%');
-- «точные» точки, которые на деле — центр города стопкой: пусть будут примерными, бот попросит настоящую точку
update baths set precision = 'city' where precision = 'exact' and id in (784, 764, 765, 180, 181, 739, 740, 741, 742, 212, 213, 192, 193, 194,
  225, 226, 227, 174, 175, 864, 865, 866, 867, 868, 820, 822, 823, 824, 107, 876, 877, 300, 301, 302, 303, 304, 305, 306, 307, 308, 273, 274, 275, 649, 650, 651);
-- «по городу», но город не тот (Кёльн под Галле, Дубровник в Загребе, Цюрих в Саксонии) — честнее «по стране»
update baths set precision = 'country' where precision = 'city' and id in (64, 65, 66, 67, 68, 122, 123, 124, 125, 126, 127, 128, 129, 989, 990, 993, 997, 998, 999, 1000, 1001);
-- названия: двойные пробелы, запятая в конце, латинская «ë»
update baths set name = regexp_replace(regexp_replace(btrim(name), '\s{2,}', ' ', 'g'), '[,\s]+$', '') where name ~ '\s{2,}' or name ~ '[,\s]+$' or name <> btrim(name);
update baths set name = replace(name, 'ë', 'ё') where name like '%ë%';
-- баня из похода Шурика (аккаунт перепривязан с «Саня С» на Шурика)
update baths set created_by = (select id from players where nick = 'Шурик') where id = 1145;
commit;
