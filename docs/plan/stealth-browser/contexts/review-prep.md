# review-prep — WORK STATE

**Phase:** review · **Kind:** work · **Depends on:** gates-first · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py review-prep`
**Executor:** `qa` (sonnet/low) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

The blind-review input is assembled: the migration diff and the one-word brief, with an integrity hash. The reviewer will receive nothing else.

---

## Semantic Distillation

- **Primitive:** WRITE `docs/plan/stealth-browser/review/{migration.diff,INPUT.sha256,BRIEF.txt}`.

- **Reference Pattern:** `git diff <scaffold start_ref>..HEAD -- entrypoint/stealth-browser tsconfig.base.json` (excludes docs/plan and the lockfile).

- **Delta Spec:** `git diff $(jq -r .states.scaffold.start_ref docs/plan/stealth-browser/state.json) HEAD -- entrypoint/stealth-browser tsconfig.base.json > review/migration.diff`; `shasum -a 256 review/migration.diff | cut -d' ' -f1 > review/INPUT.sha256`; `printf 'Review\n' > review/BRIEF.txt`.

- **Invariants:** Blind review: the reviewer gets the diff and the word `Review` -- no rationale, no plan, no prior findings ([inv:blind-review]). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:review-prep]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py review-prep` — runs every acceptance criterion below (red until the work is done); `--only review-prep.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py review-prep --only review-prep.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [review-prep.1] review/migration.diff exists, is non-empty and covers entrypoint/stealth-browser + tsconfig.base.json since the scaffold start_ref.

- [review-prep.2] review/INPUT.sha256 equals sha256(migration.diff) and the diff contains no docs/plan or pnpm-lock paths (reviewer sees the migration only).
- [review-prep.3] review/BRIEF.txt is exactly the single word `Review` (blind review: no context, rationale or review points).
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/review/migration.diff", "docs/plan/stealth-browser/review/INPUT.sha256", "docs/plan/stealth-browser/review/BRIEF.txt"]
```

---

## Contract Promise

Added: three files under `docs/plan/stealth-browser/review/`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:review-prep]`:

- [ ] After the three files exist -- commit by explicit path: `chore(stealth-browser): blind review input [psm:review-prep]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Do not paste plan text, ticket text, the previous review or any hint into BRIEF.txt. The guard requires the file to be the single word.
