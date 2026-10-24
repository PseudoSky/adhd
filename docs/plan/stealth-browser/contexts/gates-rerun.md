# gates-rerun — WORK STATE

**Phase:** remediate · **Kind:** work · **Depends on:** resolve-findings, tripwire-pack · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun`
**Executor:** `qa` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

## Goal

All gates are green again after the findings were resolved; the evidence is against the post-fix tree.

---

## Semantic Distillation

- **Primitive:** RUN the nx gates; WRITE `docs/plan/stealth-browser/evidence/gates-rerun.json`.

- **Reference Pattern:** Same gate set as `gates-first`.

- **Delta Spec:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun` (requires RESOLUTION.json); it re-runs the `stealth-core-browser` and `stealth-search` targets (evidence keys `core:<target>`, `search:<target>`) and the six `resilience-core-tripwire` targets against the post-fix trees (evidence key `tw:<target>`, tree key `tw_tree`). [inv:gate-trees]: gate evidence is keyed by the code trees (src, bin, package.json and project.json of each package), so the docs states that follow `gates-rerun` (README, CHANGELOG, docs/, AGENTS.md, llms.txt) do not invalidate it; any later change to a package's src, bin or manifest does.

- **Invariants:** A red gate returns control to resolve-findings via an amendment; never mark green on a red gate. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:gates-rerun]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun` — runs every acceptance criterion below (red until the work is done); `--only gates-rerun.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py gates-rerun --only gates-rerun.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [gates-rerun.1] `nx run stealth-core-browser:lint` and `nx run stealth-search:lint` exit 0 (includes @nx/dependency-checks)
- [gates-rerun.2] `:typecheck` and `:typecheck-spec` of stealth-core-browser and stealth-search exit 0
- [gates-rerun.3] `:build` of stealth-core-browser and `:build` and `:build-bin` of stealth-search exit 0 (dist/index.js plus the search dist/bin/*)
- [gates-rerun.4] `:test` of stealth-core-browser and stealth-search exits 0 (unit lanes incl. the use-case suites; every spawner and third-party network call is mocked, no live Chrome, no spawned process)
- [gates-rerun.5] `:verify-dist-load` of stealth-core-browser and stealth-search exits 0 (the built dists load the way a consumer loads them)
- [gates-rerun.6] Every spec file of stealth-core-browser and stealth-search cites ticket 8468f7b1 and a valid acceptance-criterion id; evidence JSON records every gate command and exit code
- [gates-rerun.7] `nx run resilience-core-tripwire:lint`, `:typecheck`, `:typecheck-spec`, `:test`, `:build` and `:verify-dist-load` exit 0 (the second approved package is gated with the first; evidence JSON records every command, its exit code and the tripwire tree sha `tw_tree`).

---

## Reservations

```text
read_only:  []
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

- No live-Chrome gate exists (user decision).
