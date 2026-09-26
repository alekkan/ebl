-- «Отстань» больше ничего не замораживает — просто закрывает вопрос про точку для одного похода.
alter table public.baths drop column if exists geo_mute_until;
