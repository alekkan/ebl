# Регламент работ

Всё выполняется из корня репозитория. Нужны: Supabase CLI (`supabase login`), `gh` под аккаунтом `alekkan`, Python 3, Docker (для локального стенда).
Боевой проект Supabase: `yeerkfdgmhcmvdqzaoio`. Привязка: `supabase link --project-ref yeerkfdgmhcmvdqzaoio`.

## Выложить изменения

| Что поменял | Команда |
|---|---|
Всё — только из актуального `main` после pull request (скрипты это проверяют) и только с зелёными тестами (`scripts/check.sh`,
нужен локальный стенд).

| Что поменял | Команда |
|---|---|
| Сайт (`prototype/`) | `scripts/deploy.sh` — проверки, затем сборка `gh-pages` из `prototype/` во временной копии (в `main` не пишет) |
| Схему базы, edge-функции | `scripts/deploy-backend.sh [функция …]` — проверки, `supabase db push`, функции (без аргументов — все), пересчёт |
| Движок очков (`_shared/scoring.js`) | `scripts/deploy-backend.sh recompute` |
| `_shared/*` (geo, place, avatar, greetings) | `scripts/deploy-backend.sh` без аргументов — функции, которые их используют, выложатся все |

Все функции деплоятся с `--no-verify-jwt`: Telegram и pg_cron не присылают ключ Supabase, проверка — внутри функций.

**Грабли GitHub Pages:**

- Pages кэширует файлы на 10 минут. `deploy.sh` проставляет `?v=<время>` к `style.css`, `app.js`, `db.js`, `config.js`
  в `index.html`, чтобы новая страница не смешалась со старым скриптом. Не убирать.
- Ветку `gh-pages` GitHub сам дописывает (коммитит `CNAME` при смене домена), поэтому `deploy.sh` перезаписывает её `--force`.
  Это только сборка — ничего ценного там нет.
- Домен задаёт файл `prototype/CNAME`. Если его удалить, сайт переедет обратно на `alekkan.github.io/ebl`.

## Переход с таблицы на портал (сделан 26.09.2026, неделя W39)

До портала таблицу вёл Виктор из Комиссии. Портал считает с W39 (`cutover_week = 39`): итог и бани до W38 — из таблицы,
на W39 бани из таблицы (внесённые до выгрузки 26.09 в 20:14) и засчитанные на портале складываются, места за W39 и дальше
раздаёт портал. После выгрузки в таблицу ничего не вносим — только бот и сайт, иначе поход посчитается дважды.
Таблицу Виктора портал только читает (публичная выгрузка xlsx), ничего в неё не пишет.

Если Виктор дописал в таблицу походы, сделанные до выгрузки, — перевыгрузить можно, пока тех же походов нет на портале:

1. Сверить, что id бань не сдвинулись: id — номер строки в таблице; новая строка в середине сдвинет все следующие
   (сравнить `prototype/data/baths.json` с `select id, name from baths`).
2. Перевыгрузить таблицу и пересобрать остаток:
   ```bash
   curl -sL -o scripts/ebl.xlsx "https://docs.google.com/spreadsheets/d/1lo91bPkR0T4j1Pk3Edp9YtQjrwHt5t8zWWSVq9nNLkY/export?format=xlsx"
   python3 scripts/extract.py
   python3 scripts/seed.py
   supabase db query --linked -f supabase/seed.sql
   curl -X POST https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/recompute
   ```
   `seed.sql` безопасно накатывать повторно: бани и участники не перезаписываются, остаток (`legacy_visits`, `legacy_standings`) обновляется.
3. Сверить таблицу на сайте с таблицей Комиссии (топ и суммы).
4. Проверить `settings.cutover_week` (`select * from settings`) — `seed.sql` ставит его из `CUTOVER_WEEK` в `scripts/seed.py`.

## Участники и Комиссия

- **Назначить в Комиссию:** `supabase db query --linked "update players set is_commission = true where nick = '<ник>'"`.
- **Новый участник лиги:** `insert into players (nick) values ('<ник>')`.
- **Привязка Telegram-аккаунта:**
  - сам участник: входит на сайте, выбирает ник → заявка на «Столе Комиссии» в ленте → Комиссия подтверждает;
  - заранее: `insert into player_accounts (player_id, tg_username) select id, '<username без @>' from players where nick = '<ник>'` —
    при первом входе аккаунт привяжется сам;
  - вручную: `update player_accounts set player_id = (select id from players where nick = '<ник>'), claimed_nick = null where id = '<id аккаунта>'`.
- Посмотреть заявки: `select id, tg_username, tg_name, claimed_nick from player_accounts where player_id is null`.

## Бот

- Добавить в группу: добавить `@eblsu_bot` участником. Режим приватности у бота должен быть выключен (см. [bot.md](bot.md)).
- Перерегистрировать вебхук (после смены токена или секрета):
  ```bash
  WS=$(openssl rand -hex 24)
  supabase secrets set TELEGRAM_WEBHOOK_SECRET="$WS" --project-ref yeerkfdgmhcmvdqzaoio
  curl -s "https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/tg-bot?setup=$WS"
  ```
- **Сменить токен бота** (если утёк): @BotFather → `/revoke` → новый токен. Владелец вписывает его сам — в чат и в код токен не попадает:
  ```bash
  read -s "T?Токен: " && supabase secrets set TELEGRAM_BOT_TOKEN="$T" --project-ref yeerkfdgmhcmvdqzaoio && unset T
  ```
  Затем перерегистрировать вебхук (выше).
- Диагностика: `curl -s "https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/tg-bot?diag=1"`.

## Домен ebl.su

- Регистратор Reg.ru, DNS-серверы `ns1/ns2.reg.ru`. Зона: четыре A-записи `@` → `185.199.108.153`, `.109.153`, `.110.153`, `.111.153`;
  CNAME `www` → `alekkan.github.io.`
- Домен сайта — `prototype/CNAME` и настройки Pages (`gh api repos/alekkan/ebl/pages`). Сертификат выпускает GitHub;
  если долго нет — перепривязать домен: `cname: null`, затем `cname: ebl.su`. Потом включить HTTPS:
  `gh api -X PUT repos/alekkan/ebl/pages -F https_enforced=true`.
- При смене адреса сайта: `/setdomain` у бота, `SITE_URL` в секретах, `ALLOWED_ORIGINS` (если задан).
- Когда появится HTTPS — поменять `og:image` в `prototype/index.html` на `https://ebl.su/og.png` (пока http: без сертификата
  Telegram картинку превью не скачает).

## Убрать тестовые данные

> ⚠️ **Только по явным id.** С W39 в журнале настоящие походы с портала — удаление по дате (`posted_at < …`) снесёт их
> вместе с очками. Тестовые походы в боевой базе — id 1–5. Сначала посмотри, что удаляешь.

```bash
supabase db query --linked "select v.id, p.nick, v.posted_at, v.status, v.source from visits v join players p on p.id = v.created_by where v.id in (1, 2, 3, 4, 5)"
supabase db query --linked "delete from visits where id in (1, 2, 3, 4, 5)"
# новые бани без походов — тоже сначала список: среди них может быть настоящая заявка
supabase db query --linked "select id, name, created_at from baths where status = 'pending' and not exists (select 1 from visits v where v.bath_id = baths.id)"
supabase db query --linked "delete from baths where id in (<id тестовых бань из списка>)"
curl -X POST https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/recompute
```

Точки бань, поставленные во время тестов, остаются — они настоящие.

## Резервные копии

База — в Supabase (на бесплатном тарифе ежедневные копии хранятся ограниченно). Для ручной копии:
`supabase db dump --linked -f backup.sql` (схема) и `supabase db dump --linked --data-only -f data.sql` (данные).
Фото — в Storage, бакеты `proofs` и `avatars`.

## Локальный стенд

```bash
supabase start
supabase db reset                                   # схема + seed.sql
docker exec supabase_db_ebl psql -U postgres -c "select cron.unschedule(jobname) from cron.job"   # иначе локальный cron дёргает боевые функции
docker exec supabase_db_ebl psql -U postgres -c "update settings set value = '\"http://supabase_kong_ebl:8000/functions/v1\"' where key = 'functions_url'"   # триггер вердикта — на локального бота
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve --env-file supabase/functions/.env
python3 tests/test_backend.py && python3 tests/test_bot.py
```
