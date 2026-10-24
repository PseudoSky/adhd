# tests-unit-surface — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** surface-api, core-seam · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-surface`
**Executor:** `test-automator` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])
**Parallel with:** tests-unit-core, tests-unit-data, tests-unit-extract, prod-errors (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

Unit specs prove the core library surface: each of the six verbs delegates to the library with the right arguments and returns the documented shape, the root barrel exports every namespace and verb, the manager seam (`lifecycle.configureManagers`, `managerFor`, `chromeExitTarget`) is reachable from the root, and a public-API snapshot spec fails on any export drift. The CLI and MCP hosts are NOT tested here: they belong to `@adhd/stealth-search` (`search-hosts`, `search-usecases`).

---

## Semantic Distillation

- **Primitive:** CREATE `packages/stealth/stealth-core-browser/src/test/unit/surface/{api,index,public-api}.spec.ts`.

- **Reference Pattern:** `packages/stealth/stealth-core-browser/src/api.ts`, `packages/stealth/stealth-core-browser/src/index.ts`, `packages/stealth/stealth-core-browser/src/lib/managers.ts` (the seam, after `core-seam`), `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts` (expected export names).

- **Delta Spec:** `api.spec.ts` mocks `ChromeManager`/clients and asserts each verb's result (including `managed: boolean` always present). `index.spec.ts` asserts the named exports (`ChromeManager`, `CdpClient`, `HistoryClient`, `CookieClient`, the six verbs) exist through the root entry (namespaces and flat verbs; there is no subpath). `public-api.spec.ts` is the SINGLE OWNER of the export snapshot: it lists the sorted root export names (the five core namespaces `cdp`, `storage`, `capture`, `parsers`, `chromeManager`, the `lifecycle` namespace from `core-seam`, the six verbs) and the sorted member names of each namespace, compared with `toEqual`. Because `prod-errors` runs in parallel and adds `recording`, `StealthCoreBrowserError`, `ERROR_CODES` and `exitCodeFor`, the spec treats those four names (and the members of `recording`) as ONE all-or-none group: it computes the actual names, removes the group if all four are present, fails if only some are present, and compares the remainder with `toEqual`, so it passes before and after `prod-errors` and fails on any other drift. `prod-errors` never edits this file; it asserts its own exports by source checks only (superset, `contains`).

- **Invariants:** [inv:unit-purity] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-unit-surface]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-surface` — runs every acceptance criterion below (red until the work is done); `--only tests-unit-surface.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-surface --only tests-unit-surface.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-unit-surface.1] src/test/unit/surface/api.spec.ts and index.spec.ts exist and assert all six verbs and the five root namespaces (cdp, storage, capture, parsers, chromeManager).
- [tests-unit-surface.2] Surface specs cite 8468f7b1 and a valid surface-api.N id; process/network boundaries are mocked.
- [tests-unit-surface.3] `nx run stealth-core-browser:test` exits 0 and only owned paths changed by [psm:tests-unit-surface] commits.
- [tests-unit-surface.5] (PA3.1, greenfield) This state OWNS the public-API export snapshot: src/test/unit/surface/public-api.spec.ts lists every root export name of src/index.ts (the five core namespaces, the `lifecycle` namespace wired by core-seam and the six verbs) and the member names of each namespace and fails on drift (toEqual of the sorted names); the names added by prod-errors (`recording`, StealthCoreBrowserError, ERROR_CODES, exitCodeFor) are an all-or-none group, so the spec passes both before and after prod-errors lands and fails on any other drift; it cites ticket 8468f7b1, a valid tests-unit-surface.N id and PA3.1, and `nx run stealth-core-browser:test -- src/test/unit/surface/public-api` exits 0.
- [tests-unit-surface.6] [inv:no-features-removed] every failsafe-inventory row owned by tests-unit-surface is pinned: its pin file exists under src/test, cites the row id `[fs-NNN]` and contains the named test; the feature is kept (no row may be removed or narrowed).

---

## Reservations

```text
read_only:  ["packages/stealth/stealth-core-browser/src/api.ts", "packages/stealth/stealth-core-browser/src/index.ts"]
mutates:    ["packages/stealth/stealth-core-browser/src/test/unit/surface/"]
```

---

## Contract Promise

Added: three spec files. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-unit-surface]`:

- [ ] After both specs pass -- commit: `test(stealth-core-browser): core surface unit specs [psm:tests-unit-surface]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Unit lane = no subprocess, no network, no real Chrome, no real profile. Mock `node:child_process`, `fetch`/`ws` WebSocket, and filesystem touch points with `vi.mock` / `vi.stubGlobal`. The guard greps for it ([inv:unit-purity]).
- Each spec file name: `src/test/unit/<bucket>/<module>.spec.ts`; each file begins with a header comment that cites the ticket `8468f7b1` and at least one criterion id `[<state>.N]` ([inv:tests-cite]).
- Have teeth: >= one expect per test and at least one error-path case per module (guard counts). Do not weaken the source to make a test pass.
