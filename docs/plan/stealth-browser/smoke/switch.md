# sp-switch evidence

PUBLISHED: npm view @adhd/sox-service-proxy@0.6.0 version exit=0
VERSION: 0.6.0

Switch: removed the single `@adhd/sox-service-proxy` `file:` entry from root package.json `pnpm.overrides`; `pnpm install --frozen-lockfile --ignore-scripts --prefer-offline` (pnpm 8.15.9) in the worktree; packages/stealth/stealth-core-browser/node_modules/@adhd/sox-service-proxy/package.json version 0.6.0.

Lockfile: no `adhd-dev-tarballs` or `file:/Users` mention remains; `/@adhd/sox-service-proxy@0.6.0` resolves with integrity sha512-Mp8eKTr9KgFuavhIC4JaiVLO06hmrvaDnPrabYuP+7xmHjgFW0z0oxmMXOfPbylVDMBuVYjP+jNkm3IRBmzpPg== (identical to the dev tarball). Core specifier: `~0.6.0`. `git diff` of packages/stealth/stealth-core-browser/src is empty.

BUILD: exit=0
LIFECYCLE-UNIT: exit=0
