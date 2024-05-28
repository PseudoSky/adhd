# REF: https://tane.dev/2020/05/publishing-npm-libraries-using-nx-and-github-actions/
set -o errexit -o noclobber -o nounset -o pipefail
PARENT_DIR="$PWD"
ROOT_DIR="."
echo "Removing Dist"
rm -rf "${ROOT_DIR:?}/dist"
DRY_RUN=${DRY_RUN:-"False"}
AFFECTED=$(node node_modules/.bin/nx show projects --affected --base=origin/master~1)
if [ "$AFFECTED" != "" ]; then
  cd "$PARENT_DIR"
  while IFS= read -r -d $' ' lib; do
    cd "$PARENT_DIR"
    echo "versioning, building, and publishing $lib"
    {
      yarn nx run "$lib":publish && {
        echo "Successfully published $lib"
        git push --force --follow-tags
      }
    } || {
      VERSION=$(npm run env | grep npm_package_version | cut -d '=' -f 2)
      echo "Failed to publish $lib-$VERSION"
    }
    wait
  done <<<"$AFFECTED "
else
  echo "No Libraries to publish"
fi