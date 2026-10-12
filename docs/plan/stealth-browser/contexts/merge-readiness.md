# merge-readiness — WORK STATE

**Phase:** release · **Kind:** work · **Depends on:** audit-final · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py merge-readiness`
**Executor:** `dispatcher` (human/dispatcher) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

> **PREREQUISITE — human action required.** This state depends on `HB-RELEASE-DECISION` from `human-blockers.json`. Before starting, verify:
>
> ```bash
> python3 docs/plan/stealth-browser/scripts/guard.py merge-readiness --only merge-readiness.2
> ```
>
> If it fails, **halt this state as `blocked` (not `failed`) and surface the blocker to the human.** Do not work around it.

---

## Goal

DISPATCHER-OWNED. The branch is ready to fast-forward into main: the pre-push gates are recorded, main has not moved past the branch (or the branch was rebased), and the release decision (publish per PUBLISHING.md, or defer) is recorded.

---

## Semantic Distillation

- **Primitive:** WRITE `docs/plan/stealth-browser/RELEASE-DECISION.md`; MERGE ff-only to main (dispatcher action).

- **Reference Pattern:** `PUBLISHING.md` (release procedure), `/Users/nix/dev/node/adhd/CLAUDE.md` (pre-push gates), `git merge-base --is-ancestor main HEAD`.

- **Delta Spec:** The dispatcher: (1) runs `npx nx affected -t lint typecheck test build` and records commands and exit codes in RELEASE-DECISION.md; (2) writes `DECISION: publish` or `DECISION: defer` and, for the cutover, `CONSUME: @adhd/stealth-browser@<version>` (published) or `CONSUME: link:<abs path in the MERGED main checkout>` (deferred); (3) merges with `git merge --ff-only stealth-browser` from the main checkout; (4) if publishing, follows PUBLISHING.md. No executor agent performs this state.

- **Invariants:** ff-only merge; no force push; release is the dispatcher's decision. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:merge-readiness]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py merge-readiness` — runs every acceptance criterion below (red until the work is done); `--only merge-readiness.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py merge-readiness --only merge-readiness.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [merge-readiness.1] HEAD is a fast-forward of main: `git merge-base --is-ancestor main HEAD` exits 0 (rebase onto main first if main moved).

---

## Reservations

```text
read_only:  ["PUBLISHING.md"]
mutates:    ["docs/plan/stealth-browser/RELEASE-DECISION.md"]
```

---

## Contract Promise

Added: `RELEASE-DECISION.md`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:merge-readiness]`:

- [ ] After the decision is written -- commit by explicit path: `chore(stealth-browser): release decision [psm:merge-readiness]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- HB-RELEASE-DECISION is the gate; the plan never publishes on its own.
