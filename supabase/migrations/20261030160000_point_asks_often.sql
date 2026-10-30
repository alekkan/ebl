-- «Где была баня?» чаще (30.10, Леха): каждый час с 10 до 22 по Москве (ночью не пишем). Ответил на прошлую — получит
-- следующую в ближайший заход; молчит — новых не шлём (через три дня его баню спросим у другого)
select cron.schedule('ebl-point-asks', '0 7-19 * * *', $$
  select net.http_post(
    url := (select value #>> '{}' from public.settings where key = 'functions_url') || '/tg-bot?asks=1',
    headers := '{"Content-Type": "application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 60000)
$$);
