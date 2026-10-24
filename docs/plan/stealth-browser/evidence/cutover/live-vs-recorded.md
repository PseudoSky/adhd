# Cutover: live versus recorded

LIVE: the consumer node_modules content equals the three tarballs packed from this worktree: @adhd/resilience-core-tripwire = cutover-tripwire-0.1.0.tgz sha256 a681d6df1d839a6b76ae41735740c4668ee7441851c09dfc8f95ccdf77fff7b0, @adhd/stealth-core-browser = cutover-core-0.1.0.tgz sha256 c5649caf3ad3e5613f45d6112118c87fface21b4f30ddfccd45c463e7035f93a, @adhd/stealth-search = cutover-search-0.1.0.tgz sha256 3c16af41485020bd8772976ed549887eee6cdea1aad8612bcccc4128c9ee3dfb; each dist/index.js is byte-identical to its tarball member and the three are real directories.

RECORDED: the dependency ranges of the three packages are ^0.1.0 (stealth-search depends on @adhd/resilience-core-tripwire ^0.1.0 and @adhd/stealth-core-browser ^0.1.0), which resolve only once the packages are released; the proof consumer bypasses the registry for them with pnpm overrides to the tarballs.

LIVE (supplementary): @adhd/apigen-engine-runtime 0.3.5 is also installed from a worktree tarball (sha256 8616868d382007ae30a1c60a52d91e031bcff680cce8beb3d6da455bd60b0203) because the published 0.3.5 lacks buildApigenPackage, which the unreleased stealth-search requires; all other third-party dependencies came from the registry.

NOT-CHANGED: pnpm-lock.yaml of the adhd checkout (the main checkout and this worktree) is not modified by this state; the consumer has its own lockfile outside every repository.
