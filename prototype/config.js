/* Боевой режим: адрес API и публичный (publishable) ключ Supabase — его можно держать в открытом коде,
   доступ к данным ограничен политиками в базе. Пустые значения — режим витрины.
   supabaseUrl — шлюз в Яндекс Облаке (infra/api-gateway.yaml), а не *.supabase.co напрямую: Supabase стоит за Cloudflare,
   а его в России режут провайдеры — без VPN сайт висел на «Грею парилку…» (28.09.2026). */
window.EBL_CONFIG = {
  supabaseUrl: "https://d5dnnk74ilrgsf0r6t22.628pfjdx.apigw.yandexcloud.net",
  supabaseKey: "sb_publishable_o9O2S8NXOlWQ2Wkyk7aIUw_p-AVyq29",
  directUrl: "https://yeerkfdgmhcmvdqzaoio.supabase.co",   // запасной путь напрямую — для VPN, которые не пускают к Яндексу
  authKey: "sb-yeerkfdgmhcmvdqzaoio-auth-token",   // ключ сессии в браузере — прежний, чтобы после смены адреса никого не разлогинило
  telegramBot: "eblsu_bot",   // username бота без @; домен входа задан в BotFather (/setdomain)
  telegramBotId: 8889070315,  // числовой id бота — публичный, это не токен
};
