# Общее для выкладки: только из актуального main (то, что прошло pull request) и только с зелёными проверками.
# Мак не засыпает от бездействия, пока идёт выкладка (закрытую крышку на батарее это не держит)
if [ -z "$EBL_AWAKE" ] && command -v caffeinate >/dev/null 2>&1; then EBL_AWAKE=1 exec caffeinate -i "scripts/$(basename "$0")" "$@"; fi
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || { echo "Выкладываем только из main (сейчас ветка $branch): сначала pull request и merge." >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "В рабочей копии есть незакоммиченные изменения — выкладывать нечего/не то." >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Локальный main не совпадает с origin/main — сделай git pull." >&2; exit 1; }
# тот же код (по содержимому файлов) уже прошёл все проверки — например, на pull request перед слиянием: второй раз не гоняем
# (19.10: проверки на PR + те же при выкладке — вдвое дольше). Код хоть в чём-то другой — проверки, как всегда
checked=$(cut -d' ' -f1 "$(git rev-parse --git-common-dir)/ebl-checked" 2>/dev/null || true)
if [ -z "$SKIP_CHECKS" ] && [ -n "$checked" ] && [ "$checked" = "$(git rev-parse 'HEAD^{tree}')" ]; then
  echo "Этот код уже прошёл все проверки ($(cut -d' ' -f2- "$(git rev-parse --git-common-dir)/ebl-checked")) — второй раз не гоняю."
  SKIP_CHECKS=1
fi
if [ -z "$SKIP_CHECKS" ]; then scripts/check.sh || { echo "Выкладка отменена: проверки не прошли." >&2; exit 1; }; fi
