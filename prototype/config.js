/* Боевой режим: адрес проекта Supabase и публичный (publishable) ключ — его можно держать в открытом коде,
   доступ к данным ограничен политиками в базе. Пустые значения — режим витрины. */
window.EBL_CONFIG = {
  supabaseUrl: "https://yeerkfdgmhcmvdqzaoio.supabase.co",
  supabaseKey: "sb_publishable_o9O2S8NXOlWQ2Wkyk7aIUw_p-AVyq29",
  telegramBot: "eblsu_bot",   // username бота без @; домен входа задан в BotFather (/setdomain)
  telegramBotId: 8889070315,  // числовой id бота — публичный, это не токен
};
