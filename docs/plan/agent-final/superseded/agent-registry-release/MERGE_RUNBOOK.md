# MERGE_RUNBOOK — land agent-registry-execution → main

> Gated on the agent-mcp back-out guarantee. Run from the MAIN checkout
> (`/Users/nix/dev/node/adhd`) unless noted. See `decisions.md` R1 for the merge
> strategy (`--no-ff`) and the explicit no-merge fallback.

## Precondition (HARD GATE)

```bash
# From the worktree, the agent-mcp back-out guarantee MUST be intact:
cd /Users/nix/dev/node/adhd-agent-registry
python3 docs/plan/agent-registry-release/scripts/check_agent_mcp_baseline.py   # must exit 0
```

If this exits non-zero, an agent-mcp src file changed outside Plan 8's modification
manifest — **do not merge**. Reconcile (revert the stray change, or amend Plan 8's
manifest by planner amendment) until the gate is green.

Also confirm Plans 6, 7, 8 are `done` and green (each plan's `audit-final`).

## Merge (default: --no-ff)

```bash
cd /Users/nix/dev/node/adhd
git fetch
git switch main
git pull --ff-only
git merge --no-ff agent-registry-execution -m "feat(agent-registry): land registry initiative (plans 1-9)"
```

A single `--no-ff` merge commit keeps the initiative revertible as one unit. **To
back out agent-mcp after merge:** `git revert -m 1 <merge-commit>` restores `main`
including agent-mcp's pre-initiative bytes (the back-out gate guaranteed no
out-of-manifest drift, so the revert is clean).

## No-merge fallback (owner's choice)

If the owner prefers to keep shipping from the worktree, record that in
`decisions.md` R1; this runbook becomes documentation-only and publish (next)
proceeds from `agent-registry-execution`.

## Post-merge

```bash
npx nx reset           # clear any stale cache deliberately (never --skip-nx-cache)
npx nx run-many -t build test lint -p agent-registry agent-tool-registry agent-provider agent-policy agent-compiler agent-mcp
```

Proceed to `PUBLISH_RUNBOOK.md`.
