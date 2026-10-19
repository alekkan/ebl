#!/bin/sh
# Все проверки перед выкладкой: бэкенд, бот и сайт в настоящем браузере (гость, участник, Комиссия, телефон, витрина).
# Нужен локальный стенд: supabase start + supabase functions serve (см. AGENTS.md). В интернет тесты не ходят (tests/stub.py),
# проверки с пометкой [сеть] без сети пропускаются.
set -e
cd "$(dirname "$0")/.."
# Мак не засыпает от бездействия, пока идут проверки (19.10: выкладка «шла час» — проверки стояли, пока Мак спал).
# Закрытую крышку на батарее это не держит — во время проверок и выкладки её не закрывай
if [ -z "$EBL_AWAKE" ] && command -v caffeinate >/dev/null 2>&1; then EBL_AWAKE=1 exec caffeinate -i "scripts/$(basename "$0")" "$@"; fi
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^supabase_db_ebl$'; then
  echo "Локальный стенд не запущен: supabase start && supabase functions serve --env-file supabase/functions/.env" >&2
  exit 1
fi
for t in test_backend test_bot test_site; do
  echo "== $t"
  python3 "tests/$t.py" > "/tmp/ebl-$t.log" 2>&1 || { grep -E "✗|Error|Traceback" "/tmp/ebl-$t.log" | head -20; echo "ПРОВАЛ: tests/$t.py (лог: /tmp/ebl-$t.log)" >&2; exit 1; }
  echo "   $(grep -c '✓' "/tmp/ebl-$t.log") проверок — ок"
  grep -- '– пропущено' "/tmp/ebl-$t.log" | sed 's/^ */   /' || true   # сетевые проверки без сети — видно, что пропущено
done
echo "Все проверки пройдены."
# запоминаем, какой код проверен (по содержимому файлов): выкладка того же кода второй раз проверки не гоняет (_guard.sh).
# Только без незакоммиченных правок — иначе проверяли не то, что в коммите
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$(git rev-parse 'HEAD^{tree}') $(date '+%d.%m %H:%M')" > "$(git rev-parse --git-common-dir)/ebl-checked"
fi
