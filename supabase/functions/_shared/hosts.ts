// Внешние сервисы, в которые ходят функции. На бою переменные не заданы — там настоящие адреса.
// На локальном стенде тесты подставляют свою заглушку (supabase/functions/.env.example, tests/stub.py):
// проверки не зависят от интернета и не висят на медленной сети.
const url = (key: string, real: string) => (Deno.env.get(key) || real).replace(/\/+$/, "");

export const TELEGRAM_API = url("TELEGRAM_API_URL", "https://api.telegram.org");
export const NOMINATIM = url("NOMINATIM_URL", "https://nominatim.openstreetmap.org");
export const NPM_CDN = url("NPM_CDN_URL", "https://cdn.jsdelivr.net/npm");
export const YANDEX_S3 = url("S3_URL", "https://storage.yandexcloud.net");
