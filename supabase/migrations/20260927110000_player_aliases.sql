-- Клички участников: в чате зовут не по нику из таблицы — «с Мамонтовым» — это Ден. Бот узнаёт клички в компании похода
-- (во всех падежах). Пополняются из бота: Комиссия — командой «кличка Мамонтов = Ден» в личке, участник — кнопкой
-- «💾 Запомнить», когда бот не узнал имя после «с», а участник выбрал человека кнопкой.
create table public.player_aliases (
  alias text primary key,                                                -- как пишут в чате
  player_id uuid not null references public.players(id) on delete cascade,
  added_by uuid references public.players(id) on delete set null,
  created_at timestamptz not null default now()
);
-- одна кличка — один человек: без учёта регистра и ё/е
create unique index player_aliases_norm on public.player_aliases (lower(replace(alias, 'ё', 'е')));
alter table public.player_aliases enable row level security;
create policy "клички видят участники лиги" on public.player_aliases for select to authenticated using (public.me() is not null);
grant select on public.player_aliases to authenticated;
grant all on public.player_aliases to service_role;

-- клички от Комиссии, 27.09.2026
insert into public.player_aliases (alias, player_id)
select a.alias, p.id from (values ('Мамонтов', 'Ден'), ('Демон', 'Фил'), ('Уважаемый', 'Шурик')) a(alias, nick)
join public.players p on p.nick = a.nick
on conflict do nothing;
