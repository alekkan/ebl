#!/bin/sh
# Выкладывает серверную часть в боевой Supabase: миграции и edge-функции, затем пересчёт таблицы.
# Только из актуального main и только с зелёными проверками (как scripts/deploy.sh).
# Запуск: scripts/deploy-backend.sh [функция ...]   — без аргументов все функции.
# Первичная настройка проекта и загрузка данных из таблицы — docs/operations.md, здесь их нет.
set -e
cd "$(dirname "$0")/.."
. scripts/_guard.sh
REF=yeerkfdgmhcmvdqzaoio
supabase db push --linked --yes
for f in ${*:-tg-login tg-bot recompute bath-location sync-avatars}; do
  supabase functions deploy "$f" --project-ref "$REF" --no-verify-jwt
done
curl -s -X POST "https://$REF.supabase.co/functions/v1/recompute"; echo
echo "Готово: бэкенд выложен."
