# resolve-findings — WORK STATE

**Phase:** remediate · **Kind:** work · **Depends on:** audit-migration-blind · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py resolve-findings`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

ONE implementer resolves EVERY finding: each is `fixed` (with a commit that touches the cited file) or `rejected` (with evidence and a reproduction command). None remain open or deferred.

---

## Semantic Distillation

- **Primitive:** MODIFY `entrypoint/stealth-browser/**` as the findings require; WRITE `docs/plan/stealth-browser/review/RESOLUTION.json`.

- **Reference Pattern:** `docs/plan/stealth-browser/review/FINDINGS.json`.

- **Delta Spec:** For each finding F<n> in order: reproduce, fix (or reject with evidence), commit with `[psm:resolve-findings]`, then record `{ id, status: fixed|rejected, commit, evidence, reproduction }`. `RESOLUTION.json` carries a single `agent` value; all commits share one author. Do not add TODO/FIXME. If `no_findings: true`, write `{ agent, resolutions: [] , note }` after confirming FINDINGS.json.

- **Invariants:** Single implementer (never split findings across agents). [inv:shared-worktree]; this is the only state allowed to touch any file in the package after review. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:resolve-findings]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py resolve-findings` — runs every acceptance criterion below (red until the work is done); `--only resolve-findings.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py resolve-findings --only resolve-findings.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

_No criteria yet._

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/review/FINDINGS.json"]
mutates:    ["entrypoint/stealth-browser/", "docs/plan/stealth-browser/review/RESOLUTION.json"]
```

---

## Contract Promise

Modified: files under `entrypoint/stealth-browser/`. Added: `review/RESOLUTION.json`. Deleted: as findings require.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:resolve-findings]`:

- [ ] After each finding -- commit by explicit path: `fix(stealth-browser): F<n> <summary> [psm:resolve-findings]`
- [ ] After RESOLUTION.json -- commit: `docs(stealth-browser): findings resolution [psm:resolve-findings]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Re-running the gates is the NEXT state; do not skip it by claiming 'tests pass locally'.
- A `rejected` finding needs a reproduction command someone else can run.
