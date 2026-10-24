# sync-global readiness: @adhd/stealth-search

Source: `entrypoint/stealth-search/package.json` (version 0.1.0).
Bins: `stealth-search` -> `./dist/bin/cli.js`, `stealth-search-mcp` -> `./dist/bin/mcp.js`.

## Step 3.5 outcomes that fail a release

From `PUBLISHING.md`, Step 3.5 (lines 153-172), `sync-global.mjs` reports one row per bin-shipping package per global root:

- `refused`: the global install was refused. A release with this row exits non-zero.
- `unverifiable`: the installed bin could not be verified after install. A release with this row exits non-zero.
- `legacy-pending`: a legacy shim with an old bin name shadows the package. It is reported with `verified:false`, fails Step 3.5, and must be quarantined after human approval.

## Pre-existing global shim

None. Read-only checks, run 2026-10-23 from the worktree:

- `command -v stealth-search stealth-search-mcp` printed nothing, so neither bin is on PATH.
- `pnpm bin -g` is `/Users/nix/Library/pnpm`. Its contents include `backlog`, `backlog.bak`, and `backlog.pre-sync-*` entries, and no `stealth-search` or `stealth-search-mcp`.
- `node tools/nx-plugins/build/executors/sync-global/sync-global.mjs --dry-run --projects=stealth-search` exited 0 (its output is recorded in `docs/plan/stealth-browser/evidence/release-readiness.md`). It scanned three roots: pnpm `/Users/nix/Library/pnpm`, npm `/Users/nix/.nvm/versions/node/v24.11.1`, and nvm `v20.20.2`. Each root reported `not-installed (no bin shim(s) found)` for `stealth-search` with `verified=n/a`.

## Expected outcome

- The expected outcome while no shim is present: both bins show as `not-installed` in every root. That is not a Step 3.5 failure, and no `legacy-pending` row is expected because neither bin has a legacy predecessor shim.
- After `pnpm release` installs the bins, the rows should become `synced` with `verified:true`.

## Remedy

- `legacy-pending` for either bin: get human approval, then quarantine the shim (`mv <bin-dir>/<name> <bin-dir>/<name>.quarantined-<date>`) and re-point any consumer that invokes the old name. Do not mark the row fixed by hand.
- `refused`: read the sync-global error for that root, fix the install cause, then re-run `pnpm release:sync-global`.
- `unverifiable`: re-run `pnpm release:sync-global`, then confirm the installed version. Do not treat the row as success until it reports `verified:true`.
- Preview at any time with `pnpm release:sync-global:dry`, which changes nothing.
