#!/bin/sh
# Выкладывает сайт (prototype/) на GitHub Pages — ветка gh-pages. Только из актуального main и только с зелёными проверками.
# В main ничего не пишет: версии ?v= проставляются во временной копии (Pages кэширует файлы на 10 минут — без версий
# новая страница подхватывала старый скрипт). Обойти проверки: SKIP_CHECKS=1 (только в крайнем случае).
set -e
cd "$(dirname "$0")/.."
. scripts/_guard.sh
v=$(date +%Y%m%d%H%M%S)
tmp=$(mktemp -d); idxdir=$(mktemp -d); idx="$idxdir/index"   # индекс git — несуществующий файл, не пустой
trap 'rm -rf "$tmp" "$idxdir"' EXIT
cp -R prototype/. "$tmp/"
find "$tmp" -name .DS_Store -delete
sed -i '' -E "s/(style\.css|app\.js|db\.js|config\.js)\?v=[0-9]+/\1?v=$v/g" "$tmp/index.html"
GIT_INDEX_FILE="$idx" git --work-tree="$tmp" add -A
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
commit=$(git commit-tree "$tree" -m "Сборка сайта $v из $(git rev-parse --short HEAD)")
# gh-pages — только сборка; GitHub сам коммитит туда CNAME при смене домена, поэтому перезаписываем
git push -q --force origin "$commit":refs/heads/gh-pages
echo "Готово: https://ebl.su/ (обновится через ~1 минуту; запасной адрес — https://alekkan.github.io/ebl/)"
