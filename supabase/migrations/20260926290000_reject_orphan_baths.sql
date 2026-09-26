-- Новая баня (кандидат, status = pending) заводится вместе с походом. Если Комиссия этот поход отклонила
-- (или при правке перенесла его в другую баню) и живых походов в бане не осталось — баня тоже отклоняется:
-- иначе отказанная «новая баня» висит на карте и на Столе Комиссии. Вернули поход — баня снова ждёт решения.
create function public.sync_candidate_bath() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  orphan bigint;
begin
  if new.status = 'rejected' and old.status is distinct from 'rejected' then orphan := new.bath_id;
  elsif new.bath_id is distinct from old.bath_id then orphan := old.bath_id;
  end if;
  if orphan is not null then
    update baths b set status = 'rejected'
    where b.id = orphan and b.status = 'pending'
      and not exists (select 1 from visits v where v.bath_id = b.id and v.status <> 'rejected');
  end if;
  -- поход вернули из отказа — его баня-кандидат снова на модерации
  if new.status <> 'rejected' and old.status = 'rejected' then
    update baths set status = 'pending' where id = new.bath_id and status = 'rejected' and created_by is not null;
  end if;
  return new;
end $$;

create trigger visits_sync_candidate_bath after update of status, bath_id on public.visits
for each row execute function public.sync_candidate_bath();

-- уже висящие: новые бани, все походы в которые отклонены
update public.baths b set status = 'rejected'
where b.status = 'pending'
  and exists (select 1 from public.visits v where v.bath_id = b.id)
  and not exists (select 1 from public.visits v where v.bath_id = b.id and v.status <> 'rejected');
