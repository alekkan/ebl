#!/bin/sh
# Выкладывает серверную часть в боевой Supabase: миграции и edge-функции, затем пересчёт таблицы.
# Только из актуального main и только с зелёными проверками (как scripts/deploy.sh).
# Запуск: scripts/deploy-backend.sh [функция ...]   — без аргументов функции, изменённые с прошлой выкладки этим скриптом
#         (не знаем, что выкладывали, или менялись _shared/config.toml — все); ALL=1 — все функции в любом случае.
# Первичная настройка проекта и загрузка данных из таблицы — docs/operations.md, здесь их нет.
set -e
cd "$(dirname "$0")/.."
. scripts/_guard.sh
REF=yeerkfdgmhcmvdqzaoio
FUNCS="tg-login tg-bot recompute bath-location sync-avatars week-results backup photos"
# коммит последней выкладки функций — в общей папке git (как ebl-checked), не в репозитории
DEPLOYED="$(git rev-parse --git-common-dir)/ebl-deployed-functions"
if [ $# -gt 0 ]; then
  funcs="$*"
else
  last=$(cat "$DEPLOYED" 2>/dev/null || true)
  # 30.10: каждая правка бота перевыкладывала все восемь функций по очереди — выкладываем только изменённые
  if [ -z "$ALL" ] && [ -n "$last" ] && git merge-base --is-ancestor "$last" HEAD 2>/dev/null; then
    changed=$(git diff --name-only "$last" HEAD -- supabase/functions supabase/config.toml)
    if echo "$changed" | grep -q -E '^supabase/(functions/_shared/|functions/[^/]+$|config\.toml)'; then
      funcs=$FUNCS
    else
      funcs=$(for f in $FUNCS; do echo "$changed" | grep -q "^supabase/functions/$f/" && printf '%s ' "$f"; done; true)
    fi
  else
    funcs=$FUNCS
  fi
fi
supabase db push --linked --yes
if [ -n "$funcs" ]; then
  echo "Функции: $funcs"
  supabase functions deploy $funcs --project-ref "$REF" --no-verify-jwt
else
  echo "Функции с прошлой выкладки ($(git rev-parse --short "$last")) не менялись — не выкладываю."
fi
[ $# -gt 0 ] || git rev-parse HEAD > "$DEPLOYED"
curl -s -X POST "https://$REF.supabase.co/functions/v1/recompute"; echo
echo "Готово: бэкенд выложен."
