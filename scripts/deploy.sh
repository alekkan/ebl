#!/bin/sh
# Выкладывает сайт (prototype/). Только из актуального main и только с зелёными проверками.
#  - основной адрес — хранилище Yandex Object Storage `ebl.su` (https — сертификат из Certificate Manager);
#  - горячий резерв — GitHub Pages (ветка gh-pages, домен ebl.su там оставлен): откат — вернуть A-записи GitHub
#    в DNS-зоне ebl-su (docs/operations.md, «Домен ebl.su»).
# В main ничего не пишет: версии ?v= проставляются во временной копии. Обойти проверки: SKIP_CHECKS=1 (только в крайнем случае).
set -e
cd "$(dirname "$0")/.."
. scripts/_guard.sh
YC=$(command -v yc || echo "$HOME/yandex-cloud/bin/yc")
[ -x "$YC" ] || { echo "Нет yc (Yandex Cloud CLI) — поставь и войди, см. docs/workflow.md «Рабочее место»." >&2; exit 1; }
v=$(date +%Y%m%d%H%M%S)
tmp=$(mktemp -d); idxdir=$(mktemp -d); idx="$idxdir/index"   # индекс git — несуществующий файл, не пустой
trap 'rm -rf "$tmp" "$idxdir"' EXIT
cp -R prototype/. "$tmp/"
find "$tmp" -name .DS_Store -delete
sed -i '' -E "s/(style\.css|app\.js|db\.js|config\.js)\?v=[0-9]+/\1?v=$v/g" "$tmp/index.html"

# 1) Яндекс. Сначала всё, кроме страницы, потом страница: новая index.html не должна сослаться на ещё не залитый скрипт.
#    Страница — без кэша (новая выкладка видна сразу), остальное — 10 минут: CSS и JS и так с ?v=.
"$YC" storage s3 cp --recursive --only-show-errors --exclude "*.html" --exclude "CNAME" --exclude ".nojekyll" \
  --cache-control "public, max-age=600" "$tmp/" s3://ebl.su/
"$YC" storage s3 cp --only-show-errors --cache-control "no-cache" "$tmp/index.html" s3://ebl.su/index.html

# 2) GitHub Pages — резерв. gh-pages — только сборка; GitHub сам коммитит туда CNAME, поэтому перезаписываем
GIT_INDEX_FILE="$idx" git --work-tree="$tmp" add -A
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
commit=$(git commit-tree "$tree" -m "Сборка сайта $v из $(git rev-parse --short HEAD)")
git push -q --force origin "$commit":refs/heads/gh-pages
echo "Готово: https://ebl.su/ (Яндекс, страница обновляется сразу; резерв на GitHub Pages — через ~1 минуту)"
