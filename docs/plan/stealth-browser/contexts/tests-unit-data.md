# tests-unit-data — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** mig-queries · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-data`
**Executor:** `test-automator` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree])
**Parallel with:** tests-unit-core, tests-unit-extract, tests-unit-surface (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

Unit specs exist for the CDP domain wrappers, Chrome profile storage readers and activity queries; SQLite and CDP transports are mocked/faked, never real profiles.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/unit/{domains-storage,queries}/*.spec.ts`.

- **Reference Pattern:** `entrypoint/stealth-browser/src/lib/domains/*.ts`, `entrypoint/stealth-browser/src/lib/storage/*.ts`, `entrypoint/stealth-browser/src/lib/queries/*.ts`.

- **Delta Spec:** Domain specs drive each wrapper through a fake transport (records sent method/params, returns canned results) and assert request shapes. Storage specs build an in-memory/temp-dir SQLite fixture (created inside the test under the OS temp dir) and assert `openDb` uses `mode=ro&immutable=1`. Queries specs compose faked CdpClient/HistoryClient/CookieClient.

- **Invariants:** [inv:unit-purity] [inv:tests-cite]; no real Chrome profile is read (guard rejects `Application Support`). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-unit-data]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-data` — runs every acceptance criterion below (red until the work is done); `--only tests-unit-data.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-data --only tests-unit-data.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-unit-data.1] A spec file exists for every ported source module (index barrels and pure type files excluded).

- [tests-unit-data.2] Every spec cites ticket 8468f7b1 and at least one valid [slug.N] acceptance-criterion id.
- [tests-unit-data.3] Unit purity: specs touching process-spawning or network modules mock child_process/WebSocket/fetch (vi.mock or vi.stubGlobal); no spec reads the real Chrome profile.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/"]
mutates:    ["entrypoint/stealth-browser/src/test/unit/domains-storage/", "entrypoint/stealth-browser/src/test/unit/queries/"]
```

---

## Contract Promise

Added: spec files. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-unit-data]`:

- [ ] After each module spec -- commit by explicit path: `test(stealth-browser): <module> unit spec [psm:tests-unit-data]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Unit lane = no subprocess, no network, no real Chrome, no real profile. Mock `node:child_process`, `fetch`/`ws` WebSocket, and filesystem touch points with `vi.mock` / `vi.stubGlobal`. The guard greps for it ([inv:unit-purity]).
- Each spec file name: `src/test/unit/<bucket>/<module>.spec.ts`; each file begins with a header comment that cites the ticket `8468f7b1` and at least one criterion id `[<state>.N]` ([inv:tests-cite]).
- Have teeth: >= one expect per test and at least one error-path case per module (guard counts). Do not weaken the source to make a test pass.
