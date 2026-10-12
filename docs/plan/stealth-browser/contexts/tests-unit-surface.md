# tests-unit-surface — WORK STATE

**Phase:** verify · **Kind:** work · **Depends on:** surface-api, surface-hosts, tracing-plugin · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-surface`
**Executor:** `test-automator` (sonnet/medium) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])
**Parallel with:** tests-unit-core, tests-unit-data, tests-unit-extract, tracing-plugin (disjoint owned paths, proven by `check-disjoint.py`)

---

## Goal

Unit specs prove the six verbs and the barrel: each verb delegates to the library with the right arguments and returns the documented shape; `index.ts` exports a superset of the old barrel.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/test/unit/surface/{api,index}.spec.ts`.

- **Reference Pattern:** `entrypoint/stealth-browser/src/api.ts`, `entrypoint/stealth-browser/src/index.ts`, `/Users/nix/dev/ai/scratch/agent-browser/cdp-query-client.ts` (expected export names).

- **Delta Spec:** `api.spec.ts` mocks `ChromeManager`/clients and asserts each verb's result (including `managed: boolean` always present). `index.spec.ts` asserts the named exports (`ChromeManager`, `CdpClient`, `HistoryClient`, `CookieClient`, the six verbs) exist (root or `./legacy`). `host.spec.ts` (host-level, in-process, `child_process`/`ChromeManager` mocked, no subprocess) asserts, citing the PA ids: the generated `launchChrome` tools/list schema has no `chromePath`/`extraArgs` (PA1.3); a tools/call with `extraArgs` is rejected and spawns nothing (PA1.2); a fixture cookie value `SECRET123` is absent from the MCP JSON and the CLI stdout of `getPageContext` while names and counts remain (PA2.2). Build the host under test through the exported factories of `server.ts`/`cli.ts` and `host-projection.ts`; if none exist, record that as a `surface-hosts` defect instead of spawning a process.

- **Invariants:** [inv:unit-purity] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:tests-unit-surface]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-surface` — runs every acceptance criterion below (red until the work is done); `--only tests-unit-surface.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py tests-unit-surface --only tests-unit-surface.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [tests-unit-surface.1] src/test/unit/surface/api.spec.ts and index.spec.ts exist and assert all six verbs and the five root namespaces (cdp, storage, capture, parsers, chromeManager).
- [tests-unit-surface.2] Surface specs cite 8468f7b1 and a valid surface-api.N id; process/network boundaries are mocked.
- [tests-unit-surface.3] `nx run stealth-browser:test` exits 0 and only owned paths changed by [psm:tests-unit-surface] commits.
- [tests-unit-surface.4] (PA1.2, PA1.3, PA2.2) An in-process host spec under src/test/unit/surface/ (child_process / ChromeManager mocked, no subprocess) asserts: the launchChrome tools/list schema has no chromePath or extraArgs, a tools/call with extraArgs is rejected and spawns nothing, and the fixture cookie value SECRET123 is absent from the MCP JSON and the CLI stdout; it cites the PA ids and ticket 8468f7b1.
- [tests-unit-surface.5] (PA3.1, greenfield) A public-API export snapshot spec under src/test/unit/surface/ lists every root export name of src/index.ts (the five namespaces and the six verbs) and the member names of each namespace, and fails on drift (toEqual / inline snapshot of the sorted names); it cites ticket 8468f7b1, a valid tests-unit-surface.N id and PA3.1.
- [tests-unit-surface.6] [inv:no-features-removed] every failsafe-inventory row owned by tests-unit-surface is pinned: its pin file exists under src/test, cites the row id `[fs-NNN]` and contains the named test; the feature is kept (no row may be removed or narrowed).

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/index.ts"]
mutates:    ["entrypoint/stealth-browser/src/test/unit/surface/"]
```

---

## Contract Promise

Added: two spec files. Modified: none. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:tests-unit-surface]`:

- [ ] After both specs pass -- commit: `test(stealth-browser): surface unit specs [psm:tests-unit-surface]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Unit lane = no subprocess, no network, no real Chrome, no real profile. Mock `node:child_process`, `fetch`/`ws` WebSocket, and filesystem touch points with `vi.mock` / `vi.stubGlobal`. The guard greps for it ([inv:unit-purity]).
- Each spec file name: `src/test/unit/<bucket>/<module>.spec.ts`; each file begins with a header comment that cites the ticket `8468f7b1` and at least one criterion id `[<state>.N]` ([inv:tests-cite]).
- Have teeth: >= one expect per test and at least one error-path case per module (guard counts). Do not weaken the source to make a test pass.
