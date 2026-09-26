#!/bin/sh
# Коммитит свежие данные и выкладывает prototype/ на GitHub Pages (ветка gh-pages).
set -e
cd "$(dirname "$0")/.."
# GitHub Pages кэширует файлы на 10 минут: версия в ссылках, чтобы страница и скрипт всегда были из одной выкладки
v=$(date +%Y%m%d%H%M%S)
sed -i '' -E "s/(style\.css|app\.js|db\.js|config\.js)\?v=[0-9]+/\1?v=$v/g" prototype/index.html
git add -A
git diff --cached --quiet || git commit -q -m "Обновление данных $(date +%Y-%m-%d)"
git push -q origin main
# gh-pages — только сборка сайта из prototype/; GitHub сам коммитит туда CNAME при смене домена, поэтому перезаписываем
git push -q --force origin "$(git subtree split --prefix prototype)":refs/heads/gh-pages
echo "Готово: https://ebl.su/ (обновится через ~1 минуту; запасной адрес — https://alekkan.github.io/ebl/)"
