#!/bin/sh
# Разовая настройка ночного бэкапа (docs/operations.md, «Резервные копии»). Запускает владелец облака — выдавать доступы его дело.
#  1. сервисный аккаунт ebl-backup;
#  2. право писать и читать ТОЛЬКО бакет ebl-backups — через ACL бакета, а не роль на каталог: иначе этим ключом можно было бы
#     переписать сайт в бакете ebl.su;
#  3. статический ключ к нему — сразу в секреты Supabase (BACKUP_S3_KEY_ID, BACKUP_S3_SECRET). На экран и в чат ключ не попадает.
# Повторный запуск выпускает новый ключ (старый можно удалить: yc iam access-key list --service-account-name ebl-backup).
set -e
cd "$(dirname "$0")/.."
YC=$(command -v yc || echo "$HOME/yandex-cloud/bin/yc")
SA=ebl-backup
BUCKET=ebl-backups
REF=yeerkfdgmhcmvdqzaoio

"$YC" iam service-account get --name "$SA" >/dev/null 2>&1 \
  || "$YC" iam service-account create --name "$SA" --description "ЕБЛ: ночной бэкап базы в $BUCKET" >/dev/null
SA_ID=$("$YC" iam service-account get --name "$SA" --format json | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Сервисный аккаунт: $SA ($SA_ID)"

"$YC" storage bucket update --name "$BUCKET" \
  --grants "grant-type=grant-type-account,grantee-id=$SA_ID,permission=permission-write" \
  --grants "grant-type=grant-type-account,grantee-id=$SA_ID,permission=permission-read" >/dev/null
echo "Доступ: только бакет $BUCKET (чтение и запись)"

KEY=$("$YC" iam access-key create --service-account-name "$SA" --description "ЕБЛ: ночной бэкап" --format json)
ID=$(printf '%s' "$KEY" | python3 -c "import sys, json; print(json.load(sys.stdin)['access_key']['key_id'])")
SECRET=$(printf '%s' "$KEY" | python3 -c "import sys, json; print(json.load(sys.stdin)['secret'])")
unset KEY
supabase secrets set BACKUP_S3_KEY_ID="$ID" BACKUP_S3_SECRET="$SECRET" --project-ref "$REF" >/dev/null
unset SECRET
echo "Готово: ключ в секретах Supabase (BACKUP_S3_KEY_ID, BACKUP_S3_SECRET). Проверка — scripts/deploy-backend.sh backup, затем"
echo "  curl -s https://$REF.supabase.co/functions/v1/backup"
