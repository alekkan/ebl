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
# версия скрипта или стиля — по его содержимому: не поменялся файл — тот же адрес, и браузер берёт его из кэша
# даже после следующих выкладок (кэш на год, см. ниже); поменялся — новый адрес, старое из кэша не подхватится
ASSETS="style.css app.js db.js config.js vendor/leaflet.min.css vendor/MarkerCluster.min.css vendor/leaflet.min.js vendor/leaflet.markercluster.min.js vendor/supabase.js"
# новый скрипт или стиль, которого нет в списке, ниже не зальётся вовсе (сайт сломается молча) — останавливаемся сразу
for f in $(cd "$tmp" && find . -type f \( -name "*.js" -o -name "*.css" \) | sed 's#^\./##'); do
  case " $ASSETS " in *" $f "*) ;; *) echo "Новый файл $f — допиши его в ASSETS в scripts/deploy.sh (версия, сжатие, кэш)" >&2; exit 1 ;; esac
done
for f in $ASSETS; do
  h=$(shasum -a 256 "$tmp/$f" | cut -c1-10)
  re=$(printf '%s' "$f" | sed 's/[.]/\\./g')
  sed -i '' -E "s#\"$re(\\?v=[0-9a-z]+)?\"#\"$f?v=$h\"#g" "$tmp/index.html"
  grep -q "\"$f?v=$h\"" "$tmp/index.html" || { echo "В index.html нет ссылки на $f — версия не проставлена" >&2; exit 1; }
done

# 1) Яндекс. Хранилище само не сжимает — отдаём заранее сжатое (gzip, Content-Encoding): файлы сайта ~700 КБ шли секундами
#    до первого запроса к базе, заставка висела (15.10). Сначала всё, кроме страницы, потом страница: новая index.html
#    не должна сослаться на ещё не залитый скрипт. Страница — без кэша (новая выкладка видна сразу); скрипты и стили
#    с версией — на год (адрес меняется вместе с содержимым); остальное (иконки, данные витрины) — 10 минут.
gz=$(mktemp -d); trap 'rm -rf "$tmp" "$idxdir" "$gz"' EXIT
cp -R "$tmp/." "$gz/"
find "$gz" -type f \( -name "*.js" -o -name "*.css" -o -name "*.html" -o -name "*.json" \) -exec gzip -9 -n {} \; -exec sh -c 'mv "$1.gz" "$1"' _ {} \;
up() { "$YC" storage s3 cp --only-show-errors "$@"; }
for f in $ASSETS; do up --content-encoding gzip --cache-control "public, max-age=31536000, immutable" "$gz/$f" "s3://ebl.su/$f"; done
up --recursive --exclude "*.html" --exclude "CNAME" --exclude ".nojekyll" --exclude "*.js" --exclude "*.css" --exclude "*.json" \
  --cache-control "public, max-age=600" "$tmp/" s3://ebl.su/
up --recursive --exclude "*" --include "data/*.json" --content-encoding gzip --cache-control "public, max-age=600" "$gz/" s3://ebl.su/
up --content-encoding gzip --cache-control "no-cache" "$gz/index.html" s3://ebl.su/index.html

# 2) GitHub Pages — резерв. gh-pages — только сборка; GitHub сам коммитит туда CNAME, поэтому перезаписываем
GIT_INDEX_FILE="$idx" git --work-tree="$tmp" add -A
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
commit=$(git commit-tree "$tree" -m "Сборка сайта $v из $(git rev-parse --short HEAD)")
git push -q --force origin "$commit":refs/heads/gh-pages
echo "Готово: https://ebl.su/ (Яндекс, страница обновляется сразу; резерв на GitHub Pages — через ~1 минуту)"
