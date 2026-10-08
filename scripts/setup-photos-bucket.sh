#!/bin/sh
# Разовая настройка хранилища фото из походов (docs/photos.md). Запускает владелец облака — выдавать доступы его дело.
#  1. бакет ebl-photos: файл открывается по прямой ссылке, а список файлов закрыт — адреса случайные, угадать нельзя,
#     какие фото у какой бани, знает только база (и показывает только участникам лиги);
#     версии включены: случайно удалённое или перезаписанное фото 30 дней можно вернуть;
#  2. сервисный аккаунт ebl-photos с правом писать и читать ТОЛЬКО этот бакет — через ACL бакета, а не роль на каталог:
#     иначе этим ключом можно было бы переписать сайт в бакете ebl.su или бэкапы;
#  3. статический ключ — сразу в секреты Supabase (PHOTOS_S3_KEY_ID, PHOTOS_S3_SECRET). На экран и в чат ключ не попадает.
# Повторный запуск безопасен: бакет и аккаунт не пересоздаёт, только выпускает новый ключ
# (старый можно удалить: yc iam access-key list --service-account-name ebl-photos).
set -e
cd "$(dirname "$0")/.."
YC=$(command -v yc || echo "$HOME/yandex-cloud/bin/yc")
SA=ebl-photos
BUCKET=ebl-photos
REF=yeerkfdgmhcmvdqzaoio

"$YC" storage bucket get "$BUCKET" >/dev/null 2>&1 \
  || "$YC" storage bucket create --name "$BUCKET" --default-storage-class standard --max-size 21474836480 >/dev/null
"$YC" storage bucket update --name "$BUCKET" --public-read --versioning versioning-enabled \
  --lifecycle-rules '{"lifecycleRules":[{"id":"old-versions-30-days","enabled":true,"noncurrentExpiration":{"noncurrentDays":"30"}}]}' >/dev/null
# сайт кладёт фото прямо в бакет по одноразовым ссылкам от функции photos — браузеру нужен CORS на запись с ebl.su
"$YC" storage bucket update --name "$BUCKET" \
  --cors 'allowed-methods=[method-put,method-get,method-head],allowed-origins=[https://ebl.su,https://www.ebl.su],allowed-headers=[*],max-age-seconds=3600' >/dev/null
echo "Бакет: $BUCKET (файлы по ссылке, список закрыт, версии 30 дней, не больше 20 ГБ, запись с сайта — по одноразовым ссылкам)"

"$YC" iam service-account get --name "$SA" >/dev/null 2>&1 \
  || "$YC" iam service-account create --name "$SA" --description "ЕБЛ: фото из походов в $BUCKET" >/dev/null
SA_ID=$("$YC" iam service-account get --name "$SA" --format json | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")
echo "Сервисный аккаунт: $SA ($SA_ID)"

"$YC" storage bucket update --name "$BUCKET" \
  --grants "grant-type=grant-type-account,grantee-id=$SA_ID,permission=permission-write" \
  --grants "grant-type=grant-type-account,grantee-id=$SA_ID,permission=permission-read" >/dev/null
echo "Доступ: только бакет $BUCKET (чтение и запись)"

KEY=$("$YC" iam access-key create --service-account-name "$SA" --description "ЕБЛ: фото из походов" --format json)
ID=$(printf '%s' "$KEY" | python3 -c "import sys, json; print(json.load(sys.stdin)['access_key']['key_id'])")
SECRET=$(printf '%s' "$KEY" | python3 -c "import sys, json; print(json.load(sys.stdin)['secret'])")
unset KEY
supabase secrets set PHOTOS_S3_KEY_ID="$ID" PHOTOS_S3_SECRET="$SECRET" --project-ref "$REF" >/dev/null
unset SECRET
echo "Готово: ключ в секретах Supabase (PHOTOS_S3_KEY_ID, PHOTOS_S3_SECRET)."
