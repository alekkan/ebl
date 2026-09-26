#!/bin/sh
# Все проверки перед выкладкой: бэкенд, бот и сайт в настоящем браузере (гость, участник, Комиссия, телефон, витрина).
# Нужен локальный стенд: supabase start + supabase functions serve (см. AGENTS.md).
set -e
cd "$(dirname "$0")/.."
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^supabase_db_ebl$'; then
  echo "Локальный стенд не запущен: supabase start && supabase functions serve --env-file supabase/functions/.env" >&2
  exit 1
fi
for t in test_backend test_bot test_site; do
  echo "== $t"
  python3 "tests/$t.py" > "/tmp/ebl-$t.log" 2>&1 || { grep -E "✗|Error|Traceback" "/tmp/ebl-$t.log" | head -20; echo "ПРОВАЛ: tests/$t.py (лог: /tmp/ebl-$t.log)" >&2; exit 1; }
  echo "   $(grep -c '✓' "/tmp/ebl-$t.log") проверок — ок"
done
echo "Все проверки пройдены."
