# core-seam — WORK STATE

**Phase:** migrate · **Kind:** work · **Depends on:** core-scaffold, chrome-lifecycle, sp-link, surface-api · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py core-seam`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The core library owns one shared, host-neutral manager seam: `configureManagers`, `managerFor` and `chromeExitTarget` in `src/lib/managers.ts`, reachable from the package root as `lifecycle.*`, so any host (the `stealth-search` entrypoint) configures idle shutdown, keep-alive and the reaper entry once and wires process exit hooks to the live managers without constructing a ChromeManager itself. This is the manager-seam half of the retired `surface-hosts` state; the host half lives in `search-hosts`.

---

## Semantic Distillation

- **Primitive:** CREATE `packages/stealth/stealth-core-browser/src/lib/managers.ts` and `src/test/unit/seam/*.spec.ts`; MODIFY `src/api.ts` (manager construction moves to `managers.ts`; header comment), `src/lib/chrome-manager.ts` (two host options), `src/lib/lifecycle/index.ts` (one re-export line and its header comment) and `src/index.ts` (the root `lifecycle` namespace).

- **Reference Pattern:** `SPEC-stealth-search.md` sections 2.1 and 5.2 ([ref:stealth-search-spec]); the retired `surface-hosts` criteria 14-16 (history in `contexts/surface-hosts.md`, `docs/plan/stealth-browser/evidence/`); chrome-lifecycle CL26 (the public `ChromeManagerOptions` shape) and `src/lib/lifecycle/exit-hooks.ts`.

- **Delta Spec:** (1) `managers.ts` holds the one module-level manager map: `configureManagers({ idleTimeoutMs, keepAlive, entryPath, checkHistory, logger })` stores host-supplied settings (a second call replaces them for managers created afterwards), `managerFor(host, port, userDataDir)` returns the cached manager (the only `new ChromeManager(` in non-test source), `chromeExitTarget` is the `{ release(), shutdownIfIdle() }` object that reaches every live manager (the shape `installProcessExitHooks` expects). Defaults reproduce today's behavior exactly (no setting means the current idle timeout and history check). (2) `ChromeManagerOptions` gains `keepAlive?: boolean` (true never arms the idle timer; every other shutdown path unchanged) and `entryPath?: string` (passed to `createProxyReaperLink` so the detached reaper loads `runChromeReaper` through the package entry the HOST loaded). Do not add a `reaper` option (CL26 retired it). (3) `api.ts` imports `managerFor` from `./lib/managers.js`; its header says the verbs are projected by consumers. (4) `lifecycle/index.ts` re-exports the three seam names from `../managers.js`; `src/index.ts` keeps `export * as lifecycle from './lib/lifecycle/index.js'`. (5) No `process.env` in `managers.ts` or `src/lib/lifecycle/`, no proxy package name in `managers.ts` (chrome-lifecycle.22/.23 scan for both). (6) One module instance: hosts load the BUILT root entry and take the verbs and the seam from that one object; the unit specs drive `managers.ts` directly with the process boundary mocked.

- **Invariants:** [inv:one-new-package] [inv:greenfield] [inv:no-features-removed] [inv:unit-purity] [inv:tests-cite] [inv:typed-errors]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:core-seam]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py core-seam` — runs every acceptance criterion below (red until the work is done); `--only core-seam.N` runs one. `.3` builds the package and loads `dist/index.js`; `.2` runs only the seam specs.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guards/core.py` (`python3 docs/plan/stealth-browser/scripts/guard.py core-seam --only core-seam.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [core-seam.1] (P7) src/lib/managers.ts exports `configureManagers({ idleTimeoutMs, keepAlive, entryPath, checkHistory, logger })`, `managerFor` and `chromeExitTarget` and is the only non-test file under src/ that constructs a ChromeManager (`new ChromeManager(`); src/api.ts imports managerFor from './lib/managers.js' and holds no manager map of its own; `ChromeManagerOptions` declares `keepAlive?` and `entryPath?` and chrome-manager.ts passes `entryPath` to createProxyReaperLink.
- [core-seam.2] (P7) The seam is unit-tested through the real functions: spec files under src/test/unit/seam/ cite ticket 8468f7b1 and a valid core-seam.N id, import no node:child_process, and assert that `keepAlive: true` never arms the idle timer, that `checkHistory: false` reaches the manager, that `release()` and `shutdownIfIdle()` through `chromeExitTarget` reach every live manager, and an error path; `nx run stealth-core-browser:test -- src/test/unit/seam` exits 0.
- [core-seam.3] (P8) The built package exposes the seam at the root: after `nx run stealth-core-browser:build` exits 0, `require()` of dist/index.js has `lifecycle.configureManagers`, `lifecycle.managerFor`, `lifecycle.chromeExitTarget`, `lifecycle.installProcessExitHooks` and `lifecycle.runChromeReaper` as functions/objects; src/index.ts has `export * as lifecycle from './lib/lifecycle/index.js'` and src/lib/lifecycle/index.ts re-exports from '../managers.js'.
- [core-seam.4] (P7) The seam is host-neutral and env-free: managers.ts and every file under src/lib/lifecycle/ contain no `process.env`, managers.ts names neither the proxy package (@adhd/sox-service-proxy) nor any apigen, commander or host package, and the core package manifest has no @adhd/apigen-* dependency; only owned paths changed by [psm:core-seam] commits (src/lib/managers.ts, chrome-manager.ts, lifecycle/index.ts, src/index.ts, the src/api.ts header and src/test/unit/seam/).

- [core-seam.5] (backlog e093636f) The legacy heartbeat reader stays out of the core: src/lib/managers.ts exists and its options carry no heartbeat setting, and a seam spec under src/test/unit/seam/ asserts at the type level (`// @ts-expect-error`) that `ChromeManagerOptions` has no `legacyHeartbeatPath` or `heartbeatPath` and that configuring the seam reads no heartbeat file; the static absence scan stays chrome-lifecycle.24. Titles carry `legacyHeartbeatPath`, `@ts-expect-error` and the uid e093636f, and the spec cites [core-seam.5].
---

## Reservations

```text
read_only:  ["packages/stealth/stealth-core-browser/src/lib/chrome-manager.ts", "packages/stealth/stealth-core-browser/src/lib/lifecycle/index.ts"]
mutates:    ["packages/stealth/stealth-core-browser/src/lib/managers.ts", "packages/stealth/stealth-core-browser/src/lib/chrome-manager.ts", "packages/stealth/stealth-core-browser/src/lib/lifecycle/index.ts", "packages/stealth/stealth-core-browser/src/index.ts", "packages/stealth/stealth-core-browser/src/api.ts", "packages/stealth/stealth-core-browser/src/test/unit/seam/"]
```

---

## Contract Promise

Added: `src/lib/managers.ts`, `src/test/unit/seam/*.spec.ts`. Modified: `src/api.ts` (manager map moved, header), `src/lib/chrome-manager.ts` (`keepAlive?`, `entryPath?`), `src/lib/lifecycle/index.ts` (seam re-export, header), `src/index.ts` (root `lifecycle` namespace if not yet exported). Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:core-seam]`:

- [ ] After the seam and its specs pass — commit: `feat(stealth-core-browser): shared manager seam [psm:core-seam]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Hosts configure the seam once at startup; a library caller who never calls `configureManagers` gets today's behavior.
- The unit lane spawns no process: mock `node:child_process` and the CDP boundary with `vi.mock`; every spec file starts with a header citing `8468f7b1` and `core-seam.N`.
