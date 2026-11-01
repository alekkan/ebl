-- Радар для просмотра (01.11, Леха): все найденные бани списком и на карте по категориям — по секретной ссылке, без входа
-- и без действий. Репозиторий открытый, поэтому ключа ссылки нет ни в коде, ни в settings (их видят все): он лежит
-- в radar_view_keys, куда у сайта доступа нет, и ставится на бою руками. Ключ сравнивает radar_view — сама таблица
-- мест по-прежнему видна только Комиссии.
create table public.radar_view_keys (
  key text primary key,
  created_at timestamptz not null default now()
);
alter table public.radar_view_keys enable row level security;
revoke all on public.radar_view_keys from anon, authenticated;
grant all on public.radar_view_keys to service_role;

-- места с точкой, кроме скрытых и закрытых. Массивами, а не объектами: ~3,5 тыс. мест — вдвое легче для телефона.
-- [id, название, город, регион, адрес, широта, долгота, вид, статус, индекс, сайт, ссылка на карту, пример цены, баня лиги, сводка]
create function public.radar_view(p_key text) returns json
language plpgsql stable security definer set search_path = public as $$
begin
  if p_key is null or not exists (select 1 from radar_view_keys where key = p_key) then return null; end if;
  return (select coalesce(json_agg(json_build_array(id, name, city, region, address, round(lat::numeric, 5), round(lng::numeric, 5),
      kind, status, public_index, website, map_url, price_example, bath_id, note) order by public_index desc nulls last), '[]')
    from radar_places
    where lat is not null and lng is not null and status <> 'hidden' and coalesce(kind, '') <> 'closed');
end $$;
revoke execute on function public.radar_view(text) from public;
grant execute on function public.radar_view(text) to anon, authenticated, service_role;
