# artifact-cleanup — commit/relocate the initiative closeout artifacts under docs/plan/agent-registry/

**Phase:** superseded-scope · **Kind:** work · **Depends on:** (none) · **Guard:** `python3 docs/plan/agent-registry-migration/scripts/audit_migration.py --phase cleanup`

See `contexts/_shared.md` for definitions and invariants.

> ⚠️ **Reconciliation note (2026-07-15, plan-builder update mode).** This state was
> inherited from `agent-registry-release` dod.4 (artifact-cleanup): the merge and publish
> happened out-of-band, but the initiative's closeout artifacts under
> `docs/plan/agent-registry/` were never committed/relocated. **That premise now appears
> STALE** — `docs/plan/agent-registry/{CLOSEOUT,COVERAGE,DEMO}.md` and `demo/` are all
> present and **git-tracked** (working tree clean). **This state therefore appears
> already-satisfied.** The criteria below have teeth against that observable (the
> artifacts exist AND are tracked, not stray untracked files), so they PASS on the current
> tree and FAIL if an artifact is missing or untracked. A human should decide whether to
> mark this state complete rather than execute it fresh.
>
> **Latent guard note:** the declared guard `audit_migration.py --phase cleanup` has **no
> matching `phase_cleanup()`** in `scripts/audit_migration.py` (only architecture / migration
> / final exist). The criteria below are what actually verifies this state; the guard needs
> either a `phase_cleanup()` added or a re-point before this plan is executed. Flagged for the
> human/orchestrator decision — not fixed here to avoid expanding an audit script the plan
> may not run.

---

## Goal

Bring the agent-registry initiative's closeout documentation into a committed,
canonical state: the closeout summary (`CLOSEOUT.md`), the coverage matrix
(`COVERAGE.md`), and the demo script + harness (`DEMO.md`, `demo/`) must be tracked
in git under `docs/plan/agent-registry/`, not left as stray untracked working-tree
artifacts. No initiative deliverable is orphaned outside version control.

---

## Acceptance criteria

<!-- Criteria have teeth against the committed-artifact observable. -->

- [artifact-cleanup.1] the closeout summary `docs/plan/agent-registry/CLOSEOUT.md` exists
- [artifact-cleanup.2] the coverage matrix `docs/plan/agent-registry/COVERAGE.md` and the demo script `docs/plan/agent-registry/DEMO.md` exist
- [artifact-cleanup.3] the initiative closeout artifacts are git-TRACKED (not stray untracked files) — `git ls-files --error-unmatch` resolves CLOSEOUT.md, COVERAGE.md, and DEMO.md

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/agent-registry/CLOSEOUT.md", "docs/plan/agent-registry/COVERAGE.md", "docs/plan/agent-registry/DEMO.md", "docs/plan/agent-registry/demo/"]
```

---

## References & interfaces

- [inv:cross-repo] — initiative source artifacts vs. in-repo docs distinction (`_shared.md`).

---

## Notes for executor

- **This state likely needs no new work** — verify the artifacts are present and
  tracked (`git ls-files --error-unmatch <path>` exits 0 for each) and close the state
  against the current tree if so. Only `git add` a genuinely-untracked artifact; do NOT
  rewrite committed docs.
- **Never chain file removals; never `git clean -f`** (project CLAUDE.md). Cleanup here
  means *bring into version control*, not delete.
- The demo harness at `docs/plan/agent-registry/demo/` (incl. `live-test-mcp.mjs`) is
  part of the tracked closeout; keep it.
