# tests-unit-core — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** mig-chrome-manager · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-core`
**Executor:** `test-automator` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** tests-unit-data, tests-unit-extract, tests-unit-surface (when unblocked) (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

Unit specs exist for the foundation, CDP and ChromeManager modules, with all process-spawn and WebSocket/network boundaries mocked; the specs cite ticket 8468f7b1 and their acceptance criteria.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/unit/{foundation,cdp,chrome-manager}/*.spec.ts`.

- **Reference Pattern:** `entrypoint/stealth-browser/src/lib/{types,session,helpers}.ts`, `entrypoint/stealth-browser/src/lib/cdp/*.ts`, `entrypoint/stealth-browser/src/lib/chrome-manager.ts`; unit-lane conventions in `entrypoint/dispatch-cli/src/test/core.spec.ts`.

- **Delta Spec:** One spec per module (manifest buckets foundation, cdp, chrome-manager; index/types barrels excluded). Examples: `cdp/browser.spec.ts` asserts the spawn args contain `--remote-debugging-port` and not `--enable-automation` against a mocked `child_process`; `killChrome` issues the `lsof -ti tcp:<port>` call through a mocked exec; `chrome-manager.spec.ts` covers heartbeat write, bump, idle shutdown tiers using fake timers and mocked fs.

- **Invariants:** [inv:unit-purity] [inv:tests-cite] [inv:live-chrome]; tests live ONLY under the owned `src/test/unit/` subfolders. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-unit-core]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-core` — runs every acceptance criterion below (red until the work is done); `--only tests-unit-core.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-core --only tests-unit-core.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-unit-core.1] A spec file exists for every ported source module (index barrels and pure type files excluded).

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/"]
mutates:    ["entrypoint/stealth-browser/src/test/unit/foundation/", "entrypoint/stealth-browser/src/test/unit/cdp/", "entrypoint/stealth-browser/src/test/unit/chrome-manager/"]
```

---

## Contract Promise

Added: spec files. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-unit-core]`:

- [ ] After each module's spec passes -- commit by explicit path: `test(stealth-browser): <module> unit spec [psm:tests-unit-core]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Unit lane = no subprocess, no network, no real Chrome, no real profile. Mock `node:child_process`, `fetch`/`ws` WebSocket, and filesystem touch points with `vi.mock` / `vi.stubGlobal`. The guard greps for it ([inv:unit-purity]).
- Each spec file name: `src/test/unit/<bucket>/<module>.spec.ts`; each file begins with a header comment that cites the ticket `8468f7b1` and at least one criterion id `[<state>.N]` ([inv:tests-cite]).
- Have teeth: >= one expect per test and at least one error-path case per module (guard counts). Do not weaken the source to make a test pass.
