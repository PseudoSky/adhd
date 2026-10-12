# audit-final — AUDIT STATE

**Phase:** release · **Kind:** audit · **Depends on:** readme-rewrite · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-final`
**Executor:** `architect-reviewer` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

---

## Goal

Final audit: every Definition-of-Done clause is proven against the real tree, and every cited reference pattern is checked for conformance.

---

## Semantic Distillation

- **Primitive:** AUDIT the whole branch; WRITE the ticked `docs/plan/stealth-browser/final-review.md`.

- **Reference Pattern:** README Definition of Done; `scripts/guard.py audit-final` checks; references.json.

- **Delta Spec:** Run `python3 docs/plan/stealth-browser/scripts/guard.py audit-final`. Tick `final-review.md` line by line only after the corresponding check passes. No deferrals.

- **Invariants:** Hold point: nothing advances to merge-readiness while any criterion fails. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:audit-final]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py audit-final` — runs every acceptance criterion below (red until the work is done); `--only audit-final.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py audit-final --only audit-final.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [audit-final.1] [dod.1] structural: exactly one new package exists, entrypoint/stealth-browser, named @adhd/stealth-browser, built by the generator (scaffold evidence) and parity-clean.

- [audit-final.2] [dod.2] behavioral: `nx run stealth-browser:verify-dist-load` and the e2e library/CLI/MCP surfaces pass on the final tree (gates-rerun evidence all green, tree == HEAD tree).
---

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/stealth-browser/final-review.md"]
```

---

## Contract Promise

Modified: `final-review.md`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:audit-final]`:

- [ ] After the audit passes -- commit: `docs(stealth-browser): final audit [psm:audit-final]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Criterion ids `audit-final.ref-*` are the reference-pattern audit checks cited from references.json.
