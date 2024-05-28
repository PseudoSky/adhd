set -e
# DEPENDS ON: "jq" "npx + semver"
# version <package: required> <lib_path: optional = "packages/*package*"> <org: optional = @uno>

PROJECT_BASE_DIR=`pwd`
PKG="$1"
LIB_BASE_DIR="${2:-packages/$PKG}"
ORG="${3:-@adhd}"
PUBLISH_NAME=$ORG/$PKG
# The most recent stable release of the package (default to 0.0.0)
LATEST_RELEASE=`npm view $PUBLISH_NAME version 2>/dev/null || echo "0.0.0"`

echo "PUBLISH_NAME: \t$PUBLISH_NAME"
echo "LATEST_RELEASE: $LATEST_RELEASE"
echo "LIB_BASE_DIR: \t$LIB_BASE_DIR\n"

# If GH Action - use env variable - otherwise use git cli
# BRANCH_TAG: 
#     name of the current branch with 
#     non alphanum characters replaced by "-"
VERSION_TAG=`echo $VERSION_TAG | sed 's/[^a-zA-Z0-9_-]/-/g'`
if [ "$VERSION_TAG" = "" ]; then
    if [ -z "$CI" ]; then
        # LOCAL: uses git cli
        BRANCH_TAG="$(git branch | grep "*" | cut -d " " -f 2 | sed 's/[^a-zA-Z0-9_-]/-/g')"
    else
        # CI: uses github action env var
        BRANCH_TAG="$(echo $GITHUB_HEAD_REF | sed 's/[^a-zA-Z0-9_-]/-/g')"
    fi
else
    BRANCH_TAG="$VERSION_TAG"
    echo "OVERRIDING TAG: $VERSION_TAG"
fi

echo "BRANCH_TAG: \t$BRANCH_TAG"

# List all published versions from Artifactory
VERSIONS=`npm view $PUBLISH_NAME versions --json`

if [ "$BRANCH_TAG" = 'master' ]; then
    MATCH_VERSION="";
elif [ "$BRANCH_TAG" = 'staging' ]; then
    MATCH_VERSION="| select(contains(\"rc\"))"
else
    MATCH_VERSION="| select(contains(\"${BRANCH_TAG}\"))"
fi
echo "$MATCH_VERSION"
# Filter to versions matching the branch based name
PUBLISHED_VERSIONS=`echo $VERSIONS | jq -r ".[] $MATCH_VERSION"`
echo "MATCHING: \t$PUBLISHED_VERSIONS"
# Sort & take the most recent branch based version


# Default the branch preid (happens for new branches)
#   <latest_master_version>-<branch_name>.0
MOST_RECENT=$LATEST_RELEASE;
STATUS="(status: new)"
if [ ! -z "$PUBLISHED_VERSIONS" ]; then
    MOST_RECENT=`npx semver $PUBLISHED_VERSIONS | tail -n 1`
    STATUS="(status: bump)"
fi
echo "STATUS: \t$STATUS \t$MOST_RECENT"

# Bump the target versions for different environments
# 
# master
#   -> PATCH  a.b.X
# staging
#   -> NEW:   a.X.1-rc.0
#   -> MINOR: a.X.1-rc.X
# preview
#   -> PRE    a.b.c-BRANCH.X
if [ "$BRANCH_TAG" = 'master' ]; then
    echo "ENVIRONMENT: DEV"
    NEXT_VERSION=`npx semver -i patch $LATEST_RELEASE`
elif [ "$BRANCH_TAG" = 'staging' ]; then
    echo "ENVIRONMENT: RELEASE CANDIDATE"
    if [ "$STATUS" = "(status: new)" ];then
        MOST_RECENT=`npx semver -i minor $LATEST_RELEASE`
    fi
    NEXT_VERSION=`npx semver -i prerelease --preid rc $MOST_RECENT `
else
    echo "ENVIRONMENT: PREVIEW"
    NEXT_VERSION=`npx semver -i prerelease --preid $BRANCH_TAG $MOST_RECENT`
fi
echo "NEXT: \t\t$NEXT_VERSION"

# Apply the new version to the "dist/{package_path}/package.json" version entry
# Why: 
#   running "npm version" modifies the package.json file
#   nx build cache is ignored when package.json is modified
#   instead we'll update the dist copy so we don't blow the cache
#   1. CD into the dist rather than libs
#   2. Update the package.json version of the dist
#   3. Any subsequent build operation can use the compute cache without issue
cd dist/$LIB_BASE_DIR > /dev/null
echo "VERSIONING: \t$PUBLISH_NAME@$NEXT_VERSION\n";
npm version --commit-hooks false --allow-same-version "$NEXT_VERSION"

# git tag -a "$PKG-$NEXT_VERSION" -m '@adhd/$PKG@$NEXT_VERSION'
cd $PROJECT_BASE_DIR > /dev/null
echo "\nUpdating $PUBLISH_NAME" 
echo "\tbefore:\t$MOST_RECENT"
echo "\tafter:\t$NEXT_VERSION"
touch /tmp/versions.txt
touch /tmp/upgrade.txt
echo "$PUBLISH_NAME@$NEXT_VERSION" >> /tmp/upgrade.txt
echo " \`\"$PUBLISH_NAME\": \"$NEXT_VERSION\",\`" >> /tmp/versions.txt
