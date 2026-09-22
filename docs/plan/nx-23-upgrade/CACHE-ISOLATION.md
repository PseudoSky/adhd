# Cache Isolation (`cache-isolation`)

**State:** `cache-isolation` · **Plan:** `nx-23-upgrade` · **Branch:** `perf/nx-upgraded`

## What changed

`nx.json` now declares:

```json
"cacheDirectory": ".nx/cache"
```

The value is **relative** on purpose. Nx resolves it against the root of whichever
checkout is running (`absolutePath(root, cacheDirectory)` in
`nx/dist/src/utils/cache-directory.js`), so every worktree gets its own cache
directory inside itself. An **absolute** path would resolve to the same location
for every checkout and re-pool the cache — the exact failure this state exists to
prevent.

## The hazard (upstream: nrwl/nx#36675)

Nx >= 23 pools the task cache **and** its workspace-data sqlite database across
sibling checkouts of the same workspace, under `~/.nx/<workspace-id>/`. This repo
runs ~35 concurrent worktrees of one workspace id, and `nx.json` previously set
no `cacheDirectory` — so every worktree read and wrote one shared pool.

Observed before the change on this checkout:

```
~/.nx/232dc9326daffd54/cache        # ~900 pooled task-cache entries
~/.nx/232dc9326daffd54/databases    # shared workspace-data DB
```

The failure mode is a **cached PASS replayed across checkouts**: a test target
reports success from a cache entry written by a *different* worktree whose suite
never ran here. Filed as `BUG-NX-CACHE-003`.

Pooling is **deliberate upstream** — a maintainer has stated the shared per-user
location is intentional (so checkouts of one workspace share artifacts, and so an
agent sandbox can be granted one committed `~/.nx` path rather than a
machine-specific absolute checkout path). It is not a bug to be fixed upstream;
it is a design trade the consumer has to opt out of.

## The trade — made explicitly

| | |
|---|---|
| **Benefit given up** | Cross-worktree task-cache sharing — the upgrade's headline speed win. A task built in worktree A no longer warms worktree B; each of ~35 checkouts now re-runs its own first build/test and keeps its own copy on disk. |
| **Hazard defused** | A measured correctness hazard: a cached PASS belonging to another worktree being replayed as a pass in this checkout (`BUG-NX-CACHE-003`, nrwl/nx#36675). |
| **Choice** | **Isolate.** Correctness beats cache speed. A wrong green is unbounded — it ships broken artifacts past every downstream gate — while the cost here is bounded and one-time per task per checkout. |

## Verification (resolved path, not just the key)

Resolved through Nx's own resolution API
(`nx/src/utils/cache-directory`), run from this checkout:

```
resolved cacheDir   : /Users/nix/dev/node/adhd/.worktrees/nx-perf-upgraded/.nx/cache
cacheDirectoryForWS : /Users/nix/dev/node/adhd/.worktrees/nx-perf-upgraded/.nx/cache
workspaceDataDir    : /Users/nix/dev/node/adhd/.worktrees/nx-perf-upgraded/.nx/workspace-data
```

Both paths are inside this checkout, not under `~/.nx/<workspace-id>/`.

Empirical confirmation — `nx build agent-base-types` after the change wrote its
cache entries **only** to the local directory:

```
hash 14366332645378538554  local=yes  shared=no
hash 8011887749495049182   local=yes  shared=no
```

A second invocation was a 100% cache hit (`2/2`), confirming the local cache is
the one being read.

## Residual risk (what this does **not** fix)

- **The cache and the DB move together, by Nx's own design.** A single predicate
  (`resolveSharedDataLocation`) decides both, because the DB's `cache_outputs`
  rows index the cache directory's contents. So setting `cacheDirectory` also
  relocates this checkout's workspace-data DB to `.nx/workspace-data`. This is
  the intended coupling, not a side effect.
- **Daemon and CPU contention remain unaddressed.** ~35 worktrees still share one
  machine and one Nx daemon tier (`.nx/workspace-data/daemon` sockets are
  per-checkout, but CPU, disk, and memory are not). This state isolates the
  *cache*, not the *load*.
- **A one-time `DB transaction error: SqliteFailure(... FOREIGN KEY constraint
  failed)`** was printed (non-fatal, exit 0, cache still written correctly) on the
  first task run after the relocation — the fresh local DB being created. It did
  not recur; the second run was a clean 100% cache hit. Recorded here for
  visibility.

## Interaction with `[inv:no-cache-bypass]`

This change makes the cache *trustworthy per checkout*; it does not license
bypassing it. The invariant stands: **never `--skip-nx-cache`**. A clean rebuild is
`nx reset` (which now removes this checkout's `.nx/cache`) or a changed input. The
isolated cache is correct — its inputs already hash `package.json`, `README.md`,
and all source — so it should be trusted, not bypassed.

## Files

- `nx.json` — added `"cacheDirectory": ".nx/cache"`.
- `docs/plan/nx-23-upgrade/CACHE-ISOLATION.md` — this record.
