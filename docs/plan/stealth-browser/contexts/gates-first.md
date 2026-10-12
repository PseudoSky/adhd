# gates-first — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** tests-unit-core, tests-unit-data, tests-unit-extract, tests-unit-surface, tracing-namespace-proof, tests-e2e, mig-docs · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-first`
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

Every gate is green on the migrated tree via nx: lint, typecheck, typecheck-spec, build, build-bin, test, verify-dist-load, e2e. The evidence file records each command, exit code and duration against the exact tree sha.

---

## Semantic Distillation

- **Primitive:** RUN the nx gates; WRITE `docs/plan/stealth-browser/evidence/gates-first.json`.

- **Reference Pattern:** Gate target names from `entrypoint/dispatch-cli/project.json`; the pre-push expectations in `/Users/nix/dev/node/adhd/CLAUDE.md`.

- **Delta Spec:** Run `python3 docs/plan/stealth-browser/scripts/guard.py gates-first` -- it executes the eight nx targets and caches the result by git tree sha. Fix failures by returning to the owning state's bucket (a gate failure is a regression in this branch, not 'pre-existing'): lint/type errors in ported files are fixed in place within this state ONLY if the fix is mechanical and the file is listed below; otherwise record which state owns it and escalate.

- **Invariants:** Never run `tsc` directly (use nx). A red gate halts the plan; there is no deferral. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:gates-first]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-first` — runs every acceptance criterion below (red until the work is done); `--only gates-first.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py gates-first --only gates-first.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [gates-first.1] `nx run stealth-browser:lint` exits 0 (includes @nx/dependency-checks)

- [gates-first.2] `nx run stealth-browser:typecheck` and `:typecheck-spec` exit 0
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/"]
mutates:    ["docs/plan/stealth-browser/evidence/"]
```

---

## Contract Promise

Added: `docs/plan/stealth-browser/evidence/gates-first.json`. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:gates-first]`:

- [ ] After all gates are green -- commit the evidence file by explicit path: `chore(stealth-browser): first gates green [psm:gates-first]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- This state writes only evidence; code fixes are made by re-opening the owning state via an amendment, so ownership stays clean.
- The e2e gate needs Chrome (HB-CHROME-BINARY) and takes minutes.
