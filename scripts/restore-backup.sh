#!/bin/sh
# Восстановить данные из ночного бэкапа (бакет ebl-backups в Яндексе, функция backup).
#   scripts/restore-backup.sh 2026-09-28            — в локальную базу (supabase start): проверить копию, разобрать инцидент
#   scripts/restore-backup.sh 2026-09-28 --prod     — в боевую базу (только если всё потеряно; спросит подтверждение)
# Схема — из миграций: сначала supabase db reset (локально) или новый проект + supabase db push, потом этот скрипт.
# Нужен yc с доступом к каталогу ebl. Таблицы очищаются и заполняются из копии с выключенными триггерами (session_replication_role),
# счётчики id выставляются по данным; ссылки на пользователей Supabase Auth обнуляются — участники просто войдут заново.
set -e
cd "$(dirname "$0")/.."
DAY=${1:?дата копии, например 2026-09-28 — список: yc storage s3api list-objects --bucket ebl-backups --delimiter /}
if [ -d "$DAY" ]; then
  DIR=$(cd "$DAY" && pwd)   # уже скачанная копия (и тест восстановления в tests/test_backend.py)
else
  YC=$(command -v yc || echo "$HOME/yandex-cloud/bin/yc")
  DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
  "$YC" storage s3 cp --recursive --only-show-errors "s3://ebl-backups/$DAY/" "$DIR/"
fi
[ -f "$DIR/manifest.json" ] || { echo "Копии за $DAY нет или она неполная (нет manifest.json)." >&2; exit 1; }
SQLF=$(mktemp); trap 'rm -f "$SQLF"' EXIT
python3 - "$DIR" > "$SQLF" <<'PY'
import gzip, json, pathlib, sys
d = pathlib.Path(sys.argv[1]); m = json.loads((d / "manifest.json").read_text())
print("begin;\nset session_replication_role = replica;")
# все таблицы — одним truncate: по одной с cascade очистка следующей стирала уже залитые зависимые (поймал тест восстановления)
print("truncate " + ", ".join(f'public."{t}"' for t in m["tables"]) + ";")
for t in m["tables"]:
    data = gzip.decompress((d / f"public.{t}.json.gz").read_bytes()).decode()
    tag = "$ebl_backup$"
    assert tag not in data
    print(f'insert into public."{t}" select * from json_populate_recordset(null::public."{t}", {tag}{data}{tag});')
print("""update public.player_accounts set auth_user = null where auth_user is not null and auth_user not in (select id from auth.users);
do $$ declare r record; begin
  for r in select table_name, column_name from information_schema.columns where table_schema = 'public' and is_identity = 'YES' loop
    execute format('select setval(pg_get_serial_sequence(%L, %L), coalesce((select max(%I) from public.%I), 0) + 1, false)',
                   'public.' || r.table_name, r.column_name, r.column_name, r.table_name);
  end loop; end $$;
set session_replication_role = origin;
commit;""")
print(f"-- копия {m['day']}: " + ", ".join(f"{k} {v}" for k, v in m["tables"].items()), file=sys.stderr)
PY
if [ "$2" = "--prod" ]; then
  printf "Перезаписать БОЕВУЮ базу копией за %s? Напиши «да»: " "$DAY"; read -r ok; [ "$ok" = "да" ] || exit 1
  supabase db query --linked -f "$SQLF" >/dev/null
  curl -s -X POST https://yeerkfdgmhcmvdqzaoio.supabase.co/functions/v1/recompute; echo
else
  docker exec -i supabase_db_ebl psql -q -U postgres -v ON_ERROR_STOP=1 < "$SQLF"
fi
echo "Восстановлено из копии за $DAY."
