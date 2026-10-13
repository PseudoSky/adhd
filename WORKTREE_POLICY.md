# Worktree Policy

All work that leaves the main checkout happens in a worktree, and worktrees are created, merged, and cleaned up **only** with these scripts. Never by hand, and never by symlinking `node_modules`.

1. **Create** — `scripts/worktree-setup.sh --bl <backlog-id>`. Ticket work gets `plan-<id>` / `task-<id>` as both directory and branch. Use `scripts/worktree-setup.sh <name>` only when no ticket exists.
2. **Work** — edit and commit only inside `.worktrees/<name>`. Do not edit the main checkout for this work; changes already sitting in main belong in the worktree too, so copy them across and restore main's copy. Commit new files with an explicit `git add <path>`.
3. **Merge** — `scripts/worktree-merge.sh <worktree | branch | backlog-id>`. It tests, merges, pushes, and cleans up in one run.
4. **Follow the output** — when a script stops, do what it says and run it again.
5. **Leftovers** — `scripts/worktree-cleanup.sh [<worktree | branch | backlog-id> ...]` removes merged, clean worktrees that merge left behind.

Afterwards, add the changelog entries for the packages you changed and resolve the backlog item, citing the merge commit.

## Caches

- **Nx** shares its cache across every worktree automatically. Never set `cacheDirectory` in `nx.json` or `NX_CACHE_DIRECTORY` / `NX_WORKSPACE_DATA_DIRECTORY` / `NX_PROJECT_GRAPH_CACHE_DIRECTORY`; each turns sharing off.
- **gitnexus** is per checkout (`<worktree>/.gitnexus`). Setup inherits main's index when main is current and not mid-reindex, and merge refreshes main's index afterwards, so a new worktree's `gx` is ready immediately. Cleanup unregisters the index and waits for any running analyze first. Switches: `WORKTREE_SEED_GITNEXUS=0`, `WORKTREE_REFRESH_GITNEXUS=0`.
