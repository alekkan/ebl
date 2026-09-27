# ЕБЛ — портал Евразийской банной лиги

Сайт и Telegram-бот лиги: карта бань, турнирная таблица чемпионата по регламенту, журнал походов с модерацией Комиссией,
отзывы, тепловая карта походов за 2023–2026.

- **Сайт:** https://ebl.su — хранилище Yandex Object Storage (резерв — GitHub Pages, см. [docs/operations.md](docs/operations.md#домен-eblsu))
- **Бот:** [@eblsu_bot](https://t.me/eblsu_bot) — отмечать походы прямо в общем чате
- **Код:** https://github.com/alekkan/ebl
- **База и серверные функции:** Supabase, проект `yeerkfdgmhcmvdqzaoio` (Франкфурт)

## Как это устроено — в двух словах

```
Telegram-группа ──@eblsu_bot──▶ tg-bot ─┐
                                        ├─▶ Supabase Postgres ──▶ recompute ──▶ standings (таблица)
Сайт ebl.su (Яндекс) ─────── db.js ───┘        ▲
     └── вход через Telegram ─▶ tg-login ───────┘
```

- **Единица данных — поход** (`visits` + `visit_players`). Всё остальное считается из журнала: недели, места, бонусы, таблица.
- **До портала** данные вёл Виктор из Комиссии в Google-таблице — они загружены как «входящий остаток». Портал считает
  с недели W39 (`cutover_week`, переход 26.09.2026): на ней бани из таблицы и с портала складываются.
- **Засчитывает Комиссия** — на сайте (у Комиссии в ленте сразу кнопки решения, «Стол Комиссии» и правка заявок) или кнопками в Telegram.
- **Кто что видит:** карта, таблица, тепловая карта, отзывы — все. Лента походов и компании — только участники лиги после входа.

Подробно:

| Документ | О чём |
|---|---|
| [docs/architecture.md](docs/architecture.md) | компоненты, модель данных, права доступа, секреты, расписания |
| [docs/scoring.md](docs/scoring.md) | как движок считает очки — по пунктам регламента |
| [docs/bot.md](docs/bot.md) | что умеет бот, как разбирает посты, сценарии |
| [docs/operations.md](docs/operations.md) | регламент работ: выкладка, переход с таблицы, новые участники, домен, ротация токена |
| [docs/data.md](docs/data.md) | откуда данные: Google-таблица, выгрузка, сопоставление бань, геокодинг |
| [docs/workflow.md](docs/workflow.md) | **как мы работаем:** ветки, pull request'ы, проверки, выкладка, откат — для людей и агентов |
| [AGENTS.md](AGENTS.md) | инструкция для ИИ-агентов, которые будут работать с кодом |

## Структура репозитория

```
prototype/            сайт (статический, хранилище Яндекса + резерв на GitHub Pages): index.html, style.css, app.js, db.js, config.js, data/*.json
supabase/migrations/  схема базы, политики доступа, расписания pg_cron
supabase/functions/   edge-функции: tg-login, tg-bot, recompute, sync-avatars, bath-location, _shared/
supabase/seed.sql     входящий остаток из таблицы (генерируется scripts/seed.py)
scripts/              выгрузка таблицы, сопоставление бань, геокодинг, выкладка
tests/                сквозные тесты на локальном стенде Supabase
```

## Быстрый старт для разработчика

Нужны: Docker, [Supabase CLI](https://supabase.com/docs/guides/cli), Python 3, `gh`.

```bash
supabase start                                   # локальный Supabase в Docker
cp supabase/functions/.env.example supabase/functions/.env
supabase functions serve --env-file supabase/functions/.env
python3 -m http.server 8765 --directory prototype
```

Сайт по умолчанию смотрит в боевой Supabase (`prototype/config.js`). Чтобы работать с локальным, временно впиши в `config.js`
адрес `http://127.0.0.1:54321` и publishable-ключ из `supabase status` — и не коммить это.

Тесты (локальный стенд должен быть запущен, настройка — в [docs/workflow.md](docs/workflow.md#рабочее-место--настроить-один-раз)):

```bash
scripts/check.sh                 # всё сразу: бэкенд, бот и сайт в настоящем Chrome (гость, участник, Комиссия, телефон)
```

## Как вносить изменения и выкладывать

В `main` напрямую не коммитим: задача → ветка → pull request → зелёные проверки → merge → выкладка скриптом.
Выкладывают только скрипты и только из актуального `main` — они сами гоняют все тесты:

```bash
scripts/deploy.sh                          # сайт → хранилище Яндекса (+ резерв на GitHub Pages)
scripts/deploy-backend.sh [функция …]      # миграции + функции (без аргументов — все) + пересчёт таблицы
```

Весь порядок по шагам, конфликты, данные на бою и откат — в [docs/workflow.md](docs/workflow.md), грабли — в [docs/operations.md](docs/operations.md).
