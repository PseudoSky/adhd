# gates-rerun — WORK STATE

**Phase:** remediate · **Kind:** work · **Depends on:** resolve-findings · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun`
**Executor:** `qa` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])

> **PREREQUISITE — human action required.** This state depends on `HB-CHROME-BINARY` from `human-blockers.json`. Before starting, verify:
>
> ```bash
> test -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
> ```
>
> If it fails, **halt this state as `blocked` (not `failed`) and surface the blocker to the human.** Do not work around it.

---

## Goal

All gates are green again after the findings were resolved; the evidence is against the post-fix tree.

---

## Semantic Distillation

- **Primitive:** RUN the nx gates; WRITE `docs/plan/stealth-browser/evidence/gates-rerun.json`.

- **Reference Pattern:** Same gate set as `gates-first`.

- **Delta Spec:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun` (requires RESOLUTION.json).

- **Invariants:** A red gate returns control to resolve-findings via an amendment; never mark green on a red gate. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:gates-rerun]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun` — runs every acceptance criterion below (red until the work is done); `--only gates-rerun.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun --only gates-rerun.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

_No criteria yet._

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/"]
mutates:    ["docs/plan/stealth-browser/evidence/"]
```

---

## Contract Promise

Added: `evidence/gates-rerun.json`.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:gates-rerun]`:

- [ ] After all gates green -- commit by explicit path: `chore(stealth-browser): gates re-run green [psm:gates-rerun]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Needs Chrome for e2e (HB-CHROME-BINARY).
