set -o errexit -o noclobber -o nounset -o pipefail

export SENTRY_PROJECT="${SENTRY_PROJECT:-yieldx}"
# Strip slashes from branch name
export COMMIT_REF=`echo $NX_COMMIT_REF | sed 's/.*\///g'`
export BUILD_OUTPUT="${BUILD_OUTPUT:-./dist/apps}"

export BUILD_APP="${BUILD_APP:-inpaas}"
export SENTRY_ENVIRONMENT="${SENTRY_ENVIRONMENT:-production}"
export NX_RELEASE="uno-$BUILD_APP-$COMMIT_REF-$NX_COMMIT_SHA"
if [ -d "$BUILD_OUTPUT" -a ! -h "$BUILD_OUTPUT" ]
then
  echo "SENTRY RELEASE: config"
  echo "  SENTRY_PROJECT: $SENTRY_PROJECT";
  echo "  RELEASE: $NX_RELEASE";
  echo "  BUILD_OUTPUT: $BUILD_OUTPUT";
  echo "  SENTRY_ENVIRONMENT: $SENTRY_ENVIRONMENT";
  echo "SENTRY RELEASE: start"

  npx sentry-cli releases --org=$SENTRY_PROJECT new -p $SENTRY_PROJECT $NX_RELEASE
  npx sentry-cli releases --org=$SENTRY_PROJECT set-commits $NX_RELEASE --auto
  npx sentry-cli releases --org=$SENTRY_PROJECT files $NX_RELEASE upload-sourcemaps "$BUILD_OUTPUT/$BUILD_APP"
  npx sentry-cli releases --org=$SENTRY_PROJECT files $NX_RELEASE upload-sourcemaps "./dist/libs"
  npx sentry-cli releases --org=$SENTRY_PROJECT finalize $NX_RELEASE
  npx sentry-cli releases --org=$SENTRY_PROJECT deploys $NX_RELEASE new -e $SENTRY_ENVIRONMENT

  echo "SENTRY RELEASE: complete"
else
  echo "SENTRY RELEASE: $BUILD_OUTPUT is empty"
fi
