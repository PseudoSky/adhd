#!/usr/bin/env sh
#
# Writes ~/.npmrc for CI. Both registry tokens come from the environment —
# never hardcode a credential here.
#
# A FontAwesome Pro token was previously hardcoded on line 6 of this file and
# reached `origin/main` on a PUBLIC repository. It must be treated as
# compromised and rotated; removing it from the working tree is NOT sufficient.
# See BACKLOG.md ENV-SEC-001.
#
# Required env:
#   NPM_TOKEN           — registry.npmjs.org auth token
#   FONTAWESOME_TOKEN   — npm.fontawesome.com auth token (FontAwesome Pro)

set -eu

: "${NPM_TOKEN:?setup-npmrc: NPM_TOKEN is not set — refusing to write a half-authenticated .npmrc}"
: "${FONTAWESOME_TOKEN:?setup-npmrc: FONTAWESOME_TOKEN is not set — refusing to write a half-authenticated .npmrc}"

umask 077   # ~/.npmrc holds credentials: owner-read/write only.

cat <<EOF > ~/.npmrc
email = grepthesky@gmail.com
always-auth = true
@adhd:registry=https://registry.npmjs.org/
@fortawesome:registry=https://npm.fontawesome.com/
//npm.fontawesome.com/:_authToken=${FONTAWESOME_TOKEN}

//registry.npmjs.org/:_authToken=${NPM_TOKEN}
EOF
