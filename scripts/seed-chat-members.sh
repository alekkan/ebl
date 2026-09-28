#!/bin/sh
# Разово: участники чата для «@eblany» (позвать всех) — список собран в Telegram Web: Telegram ботам его не отдаёт.
# Файл в репозиторий не кладём (личные данные). Формат: {"chat_id": -100…, "members": [{"id": 123, "bot": false}, …]}.
# Имена из файла не берём (там подписи из чьих-то контактов) — настоящее имя бот спросит у Telegram сам при первом сборе.
#   scripts/seed-chat-members.sh <файл.json>          — в локальную базу
#   scripts/seed-chat-members.sh <файл.json> --prod   — в боевую (спросит подтверждение)
set -e
[ -f "$1" ] || { echo "Нет файла: $1"; exit 1; }
SQL=$(python3 - "$1" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
chat = int(d["chat_id"])
ids = sorted({int(m["id"]) for m in d["members"] if not m.get("bot")})
rows = ", ".join(f"({chat}, {i})" for i in ids)
print(f"insert into public.chat_members (chat_id, tg_id) values {rows} on conflict do nothing;")
PY
)
N=$(python3 -c "import json,sys; print(sum(1 for m in json.load(open(sys.argv[1]))['members'] if not m.get('bot')))" "$1")
if [ "$2" = "--prod" ]; then
  printf "Записать %s участников в БОЕВУЮ базу? [y/N] " "$N"; read -r ok; [ "$ok" = "y" ] || exit 1
  supabase db query --linked "$SQL" >/dev/null
else
  printf '%s\n' "$SQL" | docker exec -i supabase_db_ebl psql -q -U postgres -v ON_ERROR_STOP=1
fi
echo "Готово: $N участников (уже известных не трогает)."
