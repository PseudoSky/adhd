# Evidence: release-readiness (branch stealth-browser)

Worktree: `/Users/nix/dev/node/adhd/.worktrees/stealth-browser`. Branch `stealth-browser`.

## Gate exit codes

EXIT pnpm check:release-ranges: 0
EXIT pnpm release:dry: 0
EXIT nx affected: 0
EXIT check-test-wiring: 0
EXIT check-skip-expiry: 0
EXIT check-lane-reachability: 0

BASE e21558fc1e735b8eb3c9bfb10d229a48fd8cf9c5

The base is `git merge-base HEAD main`, local main; the affected gate is `npx nx affected --base=$(git merge-base HEAD main) --head=HEAD $(node .githooks/lib/pre-push-flags.mjs)` (resolves to `--target=test`).

APPROVAL-CHECK: tripwire=ok core=ok search=ok
