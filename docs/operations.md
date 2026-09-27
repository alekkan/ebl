# Регламент работ

Всё выполняется из корня репозитория. Нужны: Supabase CLI (`supabase login`), `gh` под аккаунтом `alekkan`, Python 3, Docker (для локального стенда).
Боевой проект Supabase: `yeerkfdgmhcmvdqzaoio`. Привязка: `supabase link --project-ref yeerkfdgmhcmvdqzaoio`.

## Выложить изменения

Всё — только из актуального `main` после pull request (скрипты это проверяют) и только с зелёными тестами (`scripts/check.sh`,
нужен локальный стенд). Порядок работы целиком — ветки, PR, «выкладываю» в чат, откат — в [workflow.md](workflow.md).

| Что поменял | Команда |
|---|---|
| Сайт (`prototype/`) | `scripts/deploy.sh` — проверки, затем сборка во временной копии → хранилище Яндекса `ebl.su` и резерв `gh-pages` (в `main` не пишет; нужен `yc`) |
| Схему базы, edge-функции | `scripts/deploy-backend.sh [функция …]` — проверки, `supabase db push`, функции (без аргументов — все), пересчёт |
| Движок очков (`_shared/scoring.js`) | `scripts/deploy-backend.sh recompute` |
| `_shared/*` (geo, place, avatar, greetings) | `scripts/deploy-backend.sh` без аргументов — функции, которые их используют, выложатся все |
| И сайт, и бэкенд | сначала `scripts/deploy-backend.sh`, потом `scripts/deploy.sh` |

Все функции деплоятся с `--no-verify-jwt`: Telegram и pg_cron не присылают ключ Supabase, проверка — внутри функций.

**Грабли статики:**

- В Яндексе `index.html` заливается последним и с `Cache-Control: no-cache`, остальное — `max-age=600`. Старые файлы из хранилища
  `deploy.sh` не удаляет — если переименовал или убрал файл, удали его: `yc storage s3 rm s3://ebl.su/<путь>`.
- GitHub Pages кэширует файлы на 10 минут. `deploy.sh` проставляет `?v=<время>` к `style.css`, `app.js`, `db.js`, `config.js`
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

Сайт живёт в Yandex Cloud: облако `cloud-cumulus-511`, каталог `ebl` (владелец — Леха). Переезд с GitHub Pages — 27.09.2026:
GitHub больше суток не выпускал сертификат, а Cloudflare в России тормозят провайдеры.

- **Регистратор** — Reg.ru (там только продление домена). DNS-серверы — `ns1.yandexcloud.net`, `ns2.yandexcloud.net`:
  зона `ebl-su` в Cloud DNS. Посмотреть: `yc dns zone list-records --name ebl-su`.
- **Записи зоны:**
  - `@` ANAME → `ebl.su.website.yandexcloud.net` — сайт в хранилище;
  - `www` CNAME → `www.ebl.su.website.yandexcloud.net` — хранилище `www.ebl.su` перенаправляет на https://ebl.su;
  - `_acme-challenge…` CNAME — проверка Let's Encrypt. **Не удалять:** по ним сертификат продлевается сам;
  - `_github-pages-challenge-alekkan` TXT — подтверждение домена на GitHub.
- **Хранилища** (Object Storage): `ebl.su` — сайт (публичное чтение, хостинг сайта, главная и страница ошибки — `index.html`);
  `www.ebl.su` — только перенаправление. Выкладывает `scripts/deploy.sh`.
- **HTTPS** — сертификат Let's Encrypt `ebl-su` в Certificate Manager на `ebl.su` и `www.ebl.su`, продлевается сам;
  http → https Яндекс перенаправляет сам. Проверить: `yc certificate-manager certificate list`.
- **Деньги** — около 45 ₽ в месяц, почти всё — DNS-зона (0,0592 ₽/час); хранение, запросы и трафик сайта в бесплатных лимитах.
  Первые 60 дней — стартовый грант. ⚠️ **До конца гранта** — консоль → «Биллинг» → «Перейти на платную версию»,
  иначе после гранта Яндекс остановит ресурсы и сайт ляжет.
- **Доступ для выкладки** — `yc` (см. [workflow.md](workflow.md#рабочее-место--настроить-один-раз)) и роль `storage.editor`
  на каталог `ebl`. Выдаёт Леха: `yc resource-manager folder add-access-binding ebl --role storage.editor --subject userAccount:<id>`.
- **Откат на GitHub Pages** (если у Яндекса проблемы). Домен ebl.su на GitHub оставлен, и `deploy.sh` при каждой выкладке
  обновляет и резерв. Вернуть сайт на GitHub (без https) — заменить ANAME на A-записи, TTL 5 минут:
  ```bash
  yc dns zone delete-records --name ebl-su --record "@ 300 ANAME ebl.su.website.yandexcloud.net."
  yc dns zone add-records --name ebl-su --record "@ 300 A 185.199.108.153" --record "@ 300 A 185.199.109.153" \
    --record "@ 300 A 185.199.110.153" --record "@ 300 A 185.199.111.153"
  ```
  Вернуть на Яндекс — наоборот.
- При смене адреса сайта: `/setdomain` у бота, `SITE_URL` в секретах, `ALLOWED_ORIGINS` (если задан).

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
scripts/check.sh                                    # бэкенд, бот и сайт в Chrome (нужен pip3 install playwright)
```
