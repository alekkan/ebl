-- Регион и страну берём только по координатам бани через геокодер, не по соседним баням (решение Лехи, 30.09) —
-- запасной путь nearest_place из 20260930200000 не нужен. Ночная дозаливка ebl-fill-places остаётся.
drop function public.nearest_place(double precision, double precision, double precision);
