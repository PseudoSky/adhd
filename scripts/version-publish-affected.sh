# REF: https://tane.dev/2020/05/publishing-npm-libraries-using-nx-and-github-actions/
set -o errexit -o noclobber -o nounset -o pipefail
PARENT_DIR="$PWD"
ROOT_DIR="."
echo "Removing Dist"
rm -rf "${ROOT_DIR:?}/dist"
DRY_RUN=${DRY_RUN:-"False"}
AFFECTED=$(node node_modules/.bin/nx show projects --affected --base=origin/main~1)
if [ "$AFFECTED" != "" ]; then
  cd "$PARENT_DIR"
  while IFS= read -r -d $' ' lib; do
    cd "$PARENT_DIR"
    # NOTE: this assumes that the publish task of each lib is configured to handle versioning, building, and publishing. Adjust as necessary.
    echo "versioning, building, and publishing $lib"
    {
      npx nx run "$lib":publish && {
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