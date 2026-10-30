#!/bin/sh
# Все проверки перед выкладкой: бэкенд, бот и сайт в настоящем браузере (гость, участник, Комиссия, телефон, витрина).
# Нужен локальный стенд: supabase start + supabase functions serve (см. AGENTS.md). В интернет тесты не ходят (tests/stub.py),
# проверки с пометкой [сеть] без сети пропускаются.
# Запуск: scripts/check.sh              — все наборы; зелёный прогон запоминается для выкладки (_guard.sh)
#         scripts/check.sh bot site     — только эти наборы (backend, bot, site): быстро, пока правишь
#         scripts/check.sh changed      — только наборы, которые задевают правки ветки относительно origin/main
# Неполный прогон для выкладки не засчитывается: перед pull request и выкладкой — полный.
set -e
cd "$(dirname "$0")/.."
# Мак не засыпает от бездействия, пока идут проверки (19.10: выкладка «шла час» — проверки стояли, пока Мак спал).
# Закрытую крышку на батарее это не держит — во время проверок и выкладки её не закрывай
if [ -z "$EBL_AWAKE" ] && command -v caffeinate >/dev/null 2>&1; then EBL_AWAKE=1 exec caffeinate -i "scripts/$(basename "$0")" "$@"; fi
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^supabase_db_ebl$'; then
  echo "Локальный стенд не запущен: supabase start && supabase functions serve --env-file supabase/functions/.env" >&2
  exit 1
fi
ALL="backend bot site"

# какие наборы задевает файл (30.10: каждая мелкая правка бота ждала все 6,5 минуты). Сомнения — все наборы
sets_for() {
  case "$1" in
    *.md|docs/*|scripts/datafix_*|scripts/*.sql|.github/*) ;;
    prototype/*) echo site ;;
    supabase/functions/tg-bot/*|supabase/functions/week-results/*) echo bot ;;
    scripts/radar/*|scripts/catalog/*) echo backend ;;
    tests/test_backend.py) echo backend ;;
    tests/test_bot.py) echo bot ;;
    tests/test_site.py) echo site ;;
    *) echo "$ALL" ;;
  esac
}

case "$1" in
  "") sets=$ALL ;;
  changed)
    git fetch -q origin 2>/dev/null || true
    files=$( (git diff --name-only "$(git merge-base origin/main HEAD)"; git ls-files --others --exclude-standard) | sort -u)
    sets=$(for f in $files; do sets_for "$f"; done | tr ' ' '\n' | sort -u | tr '\n' ' ')
    sets=$(for t in $ALL; do case " $sets " in (*" $t "*) printf '%s ' "$t" ;; esac; done)
    [ -n "$sets" ] || { echo "Правки не задевают ни один набор проверок — проверять нечего."; exit 0; }
    echo "Правки задевают: $sets(полный прогон — scripts/check.sh без аргументов)" ;;
  *)
    sets=""
    for a in "$@"; do
      t=${a#test_}; t=${t%.py}
      case " $ALL " in *" $t "*) sets="$sets $t" ;; *) echo "Нет набора «$a»: есть $ALL, changed" >&2; exit 1 ;; esac
    done ;;
esac

for s in $sets; do
  t=test_$s
  echo "== $t"
  start=$(date +%s)
  python3 -u "tests/$t.py" > "/tmp/ebl-$t.log" 2>&1 || { grep -E "✗|Error|Traceback" "/tmp/ebl-$t.log" | head -20; echo "ПРОВАЛ: tests/$t.py (лог: /tmp/ebl-$t.log)" >&2; exit 1; }
  echo "   $(grep -c '✓' "/tmp/ebl-$t.log") проверок — ок, $(( $(date +%s) - start )) с"
  grep -- '– пропущено' "/tmp/ebl-$t.log" | sed 's/^ */   /' || true   # сетевые проверки без сети — видно, что пропущено
done
if [ "$(echo $sets)" != "$ALL" ]; then
  echo "Пройдены только: $(echo $sets). Для pull request и выкладки — полный scripts/check.sh."
  exit 0
fi
echo "Все проверки пройдены."
# запоминаем, какой код проверен (по содержимому файлов): выкладка того же кода второй раз проверки не гоняет (_guard.sh).
# Только без незакоммиченных правок — иначе проверяли не то, что в коммите
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then
  echo "$(git rev-parse 'HEAD^{tree}') $(date '+%d.%m %H:%M')" > "$(git rev-parse --git-common-dir)/ebl-checked"
fi
