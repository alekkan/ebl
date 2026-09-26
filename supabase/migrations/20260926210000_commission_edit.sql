-- Комиссия правит любую заявку: в том числе дополняет компанию уже засчитанного похода.
create policy "Комиссия дополняет компанию" on public.visit_players for insert to authenticated
  with check (public.is_commission());
