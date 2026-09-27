# Общее для выкладки: только из актуального main (то, что прошло pull request) и только с зелёными проверками.
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = main ] || { echo "Выкладываем только из main (сейчас ветка $branch): сначала pull request и merge." >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "В рабочей копии есть незакоммиченные изменения — выкладывать нечего/не то." >&2; exit 1; }
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "Локальный main не совпадает с origin/main — сделай git pull." >&2; exit 1; }
if [ -z "$SKIP_CHECKS" ]; then scripts/check.sh || { echo "Выкладка отменена: проверки не прошли." >&2; exit 1; }; fi
