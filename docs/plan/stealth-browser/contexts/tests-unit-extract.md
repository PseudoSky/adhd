# tests-unit-extract — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** mig-capture-parsers · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-extract`
**Executor:** `test-automator` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** tests-unit-core, tests-unit-data, tests-unit-surface (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

Unit specs exist for capture (bans, dom, network) and parsers, using in-test HTML/XML fixtures; third-party parsing libraries run for real (they are pure) while any network use is mocked.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/unit/capture-parsers/*.spec.ts`.

- **Reference Pattern:** `entrypoint/stealth-browser/src/lib/capture/*.ts`, `entrypoint/stealth-browser/src/lib/parsers.ts`.

- **Delta Spec:** `bans.spec.ts` covers `decideRetry` branches; `dom.spec.ts` feeds a synthetic CDP DOM tree to the walker; `network.spec.ts` uses a fake session emitting Network.* events; `parsers.spec.ts` parses fixture HTML with xpath/xmldom/node-html-parser.

- **Invariants:** [inv:unit-purity] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-unit-extract]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-extract` — runs every acceptance criterion below (red until the work is done); `--only tests-unit-extract.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-extract --only tests-unit-extract.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-unit-extract.1] A spec file exists for every ported source module (index barrels and pure type files excluded).

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/"]
mutates:    ["entrypoint/stealth-browser/src/test/unit/capture-parsers/"]
```

---

## Contract Promise

Added: spec files. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-unit-extract]`:

- [ ] After each module spec -- commit by explicit path: `test(stealth-browser): <module> unit spec [psm:tests-unit-extract]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Unit lane = no subprocess, no network, no real Chrome, no real profile. Mock `node:child_process`, `fetch`/`ws` WebSocket, and filesystem touch points with `vi.mock` / `vi.stubGlobal`. The guard greps for it ([inv:unit-purity]).
- Each spec file name: `src/test/unit/<bucket>/<module>.spec.ts`; each file begins with a header comment that cites the ticket `8468f7b1` and at least one criterion id `[<state>.N]` ([inv:tests-cite]).
- Have teeth: >= one expect per test and at least one error-path case per module (guard counts). Do not weaken the source to make a test pass.
