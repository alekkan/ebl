-- Сверка (20.10): Комиссия знает, где баня, лучше агентов — вставляет в карточке сверки свою ссылку на карты, адрес или
-- координаты. Точку ставит обычный путь (bath-location: точная, как «перенести точку» в карточке бани), а предложение
-- агентов уходит в «Решено» с причиной own_point: их место не то — их данные (часы, цены) на портал не идут.
alter table public.catalog_proposals drop constraint catalog_proposals_reject_reason_check;
alter table public.catalog_proposals add constraint catalog_proposals_reject_reason_check
  check (reject_reason in ('other_bath', 'wrong_point', 'not_public', 'closed', 'duplicate', 'own_point', 'other'));
