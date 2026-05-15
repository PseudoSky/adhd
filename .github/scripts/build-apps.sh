# REF: https://tane.dev/2020/05/publishing-npm-appraries-using-nx-and-github-actions/
set -o errexit -o noclobber -o nounset -o pipefail

# This script uses the parent version as the version to publish a apprary with

PARENT_DIR="$PWD"
ROOT_DIR="."
DRY_RUN=${DRY_RUN:-"False"}

AFFECTED=$(node node_modules/.bin/nx affected:apps --plain --base=origin/master~1)
if [ "$AFFECTED" != "" ]; then
  cd "$PARENT_DIR"
  while IFS= read -r -d $' ' app; do
    echo "Building $app"
    yarn build "$app" --with-deps
    wait
  done <<<"$AFFECTED " # leave space on end to generate correct output

  cd "$PARENT_DIR"
  while IFS= read -r -d $' ' app; do
    if [ "$DRY_RUN" == "False" ]; then
      echo "Releasing $app"
      BUILD_APP=$app ./$ROOT_DIR/sentry-release
    else
      echo "Dry Run, not releasing $app"
    fi
    wait
  done <<<"$AFFECTED " # leave space on end to generate correct output
else
  echo "No apps to release"
fi