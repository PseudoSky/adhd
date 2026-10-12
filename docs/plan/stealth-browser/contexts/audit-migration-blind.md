# audit-migration-blind — AUDIT STATE

**Phase:** review · **Kind:** audit · **Depends on:** review-prep · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-migration-blind`
**Executor:** `code-reviewer` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

ONE blind review round: the reviewer sees only the migration diff and the word `Review`, and returns structured findings (or an explicit no-findings verdict with rationale).

---

## Semantic Distillation

- **Primitive:** REVIEW `docs/plan/stealth-browser/review/migration.diff`; WRITE `docs/plan/stealth-browser/review/FINDINGS.json`.

- **Reference Pattern:** `docs/plan/stealth-browser/review/migration.diff` only.

- **Delta Spec:** Dispatch the reviewer with exactly the prompt `Review` and the diff attached (nothing else -- [inv:blind-review]). Record `{ review_round: 1, reviewer_prompt: 'Review', reviewer_input_sha256: <INPUT.sha256>, findings: [{id:'F1', severity:'blocker|major|minor|nit', file, line, summary, evidence}] }` or `{ review_round: 1, ..., no_findings: true, rationale }`. The dispatcher (not the reviewer) copies the structured result into FINDINGS.json. This is an audit hold point: nothing advances until the file validates.

- **Invariants:** Exactly one round; the reviewer is never told what was intended, what changed since, or what to look for. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:audit-migration-blind]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-migration-blind` — runs every acceptance criterion below (red until the work is done); `--only audit-migration-blind.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py audit-migration-blind --only audit-migration-blind.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

_No criteria yet._

---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/review/FINDINGS.json"]
```

---

## Contract Promise

Added: `review/FINDINGS.json`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:audit-migration-blind]`:

- [ ] After FINDINGS.json validates -- commit by explicit path: `docs(stealth-browser): blind review findings [psm:audit-migration-blind]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Do not iterate: a second round would be a convergent review, which the process forbids.
- Every cited file must exist in the reviewed tree (guard).
