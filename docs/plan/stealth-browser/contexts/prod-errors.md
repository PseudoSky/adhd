# prod-errors — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** tracing-plugin, tests-unit-core, tests-unit-data, tests-unit-extract, capture-upgrade, chrome-lifecycle · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-errors`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

Every failure a user can hit is a typed, documented error: one `StealthBrowserError` carrying a stable `code`, a remediation message, a CLI exit code and an MCP `isError` payload, including the CaptureError (8 codes) and LifecycleError (7 codes) of the new capture and lifecycle layers. No untyped `Error` escapes the library, the CLI or the MCP host (user decision: 100% typed errors). Failure modes were enumerated from the code's throw sites and the two specs, not guessed.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/errors.ts`, `docs/ERRORS.md`, `src/test/unit/errors/`; MODIFY the `src/lib/**` throw sites, `src/server.ts`, `src/cli.ts`, `src/index.ts` (re-export `./errors.js`) and `bin/*.ts`.

- **Reference Pattern:** Library throw sites: `cdp/browser.ts` (start timeout, CDP unreachable), `cdp/targets.ts` (unreachable, bad JSON, target not found), `cdp/session.ts` (connect, not connected, timeout, remote error, closed, send failed), `cdp/settle.ts` (settle failure, navigation failure, abort), `capture/network.ts` (remote error, closed, no match, ban), `capture/dom.ts` (selector timeout), `domains/transport.ts` (remote error, timeout), plus the product-defined host codes.

- **Delta Spec:** Codes (exactly, 4 host codes CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD, CHROME_NOT_RUNNING; 14 library codes CHROME_START_TIMEOUT, CDP_UNREACHABLE, CDP_BAD_RESPONSE, TARGET_NOT_FOUND, CDP_CONNECT_FAILED, CDP_NOT_CONNECTED, CDP_TIMEOUT, CDP_REMOTE_ERROR, CDP_SESSION_CLOSED, CDP_SEND_FAILED, NAVIGATION_FAILED, PAGE_SETTLE_FAILED, OPERATION_ABORTED, SELECTOR_TIMEOUT; 8 CaptureError codes CAPTURE_CONNECT_FAILED, CAPTURE_NAVIGATE_FAILED, CAPTURE_TIMEOUT, CAPTURE_NO_MATCH, CAPTURE_BAN_DETECTED, CAPTURE_SESSION_CLOSED, CAPTURE_SINK_FAILED, CAPTURE_SINK_UNAVAILABLE; 6 LifecycleError codes LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, REAPER_UNAVAILABLE, ISOLATED_CONTEXT_FAILED (32 in all; CaptureError and LifecycleError declare exactly these)). `errors.ts` exports `StealthBrowserError` (readonly `code`, a remediation message naming a concrete next step), `ERROR_CODES` and `exitCodeFor`. Replace every `new Error(...)`/untyped reject in non-test `src/` and `bin/` with the matching code, preserving existing message text where specs depend on it. `CaptureError` (recording) and `LifecycleError` (lifecycle) are re-based to extend `StealthBrowserError`; a classifier maps a `LAUNCH_FAILED` cause of ENOENT to CHROME_NOT_FOUND and EADDRINUSE to PORT_IN_USE. The CLI prints `<CODE>: <message>` to stderr and exits with `exitCodeFor(code)`; the MCP host returns `isError: true` with the code and message in the content; both bins preflight Node >= 22.5 (NODE_TOO_OLD). `docs/ERRORS.md` documents each code, its exit code and remediation. One unit test per code, reached through the real library path (`rejects.toMatchObject({ code })`). Root wiring (amendment A3): `src/index.ts` exports the `recording` and `lifecycle` namespaces, with `captureAllNetworkResponses` inside `capture`.

- **Invariants:** [inv:typed-errors] [inv:greenfield] [inv:esm-js-specifiers] [inv:unit-purity] [inv:tests-cite]. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:prod-errors]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py prod-errors` — runs every acceptance criterion below (red until the work is done); `--only prod-errors.N` runs one. `.5` is the audit criterion: it scans non-test source for any untyped error construction.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py prod-errors --only prod-errors.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [prod-errors.1] (PA5.1, widened to 100%) src/errors.ts defines one `StealthBrowserError extends Error` with a readonly stable `code`, an exported `ERROR_CODES` const naming EVERY failure mode of the library, an `exitCodeFor(code)` mapping and a remediation message per code; the codes are exactly the 32 enumerated from the code and the two specs (4 host codes CHROME_NOT_FOUND, PORT_IN_USE, NODE_TOO_OLD, CHROME_NOT_RUNNING; 14 library codes CHROME_START_TIMEOUT, CDP_UNREACHABLE, CDP_BAD_RESPONSE, TARGET_NOT_FOUND, CDP_CONNECT_FAILED, CDP_NOT_CONNECTED, CDP_TIMEOUT, CDP_REMOTE_ERROR, CDP_SESSION_CLOSED, CDP_SEND_FAILED, NAVIGATION_FAILED, PAGE_SETTLE_FAILED, OPERATION_ABORTED, SELECTOR_TIMEOUT; the 8 CaptureError codes CAPTURE_CONNECT_FAILED, CAPTURE_NAVIGATE_FAILED, CAPTURE_TIMEOUT, CAPTURE_NO_MATCH, CAPTURE_BAN_DETECTED, CAPTURE_SESSION_CLOSED, CAPTURE_SINK_FAILED, CAPTURE_SINK_UNAVAILABLE; the 6 LifecycleError codes LAUNCH_FAILED, LAUNCH_LOCK_TIMEOUT, CHROME_UNREACHABLE_AFTER_LAUNCH, LAUNCH_CIRCUIT_OPEN, REAPER_UNAVAILABLE, ISOLATED_CONTEXT_FAILED), and every code's message names a concrete next step.
- [prod-errors.2] (PA5.4, widened) src/test/unit/errors/ has a unit test PER CODE: each code of the registry (all 32 codes) is asserted (`code` and a remediation message; CaptureError and LifecycleError instances are `instanceof StealthBrowserError`) and each of the 14 library codes is reached through the real library path (`rejects.toMatchObject({ code: '<CODE>' })` or `.code).toBe('<CODE>')` against the in-process fake server/stubs), citing ticket 8468f7b1, a valid prod-errors.N id and PA5.1 / PA5.4.
- [prod-errors.3] Only owned paths changed by [psm:prod-errors] commits (errors.ts, src/index.ts, the lib files whose throw sites it types, the host wiring files and the error specs); errors.ts reads no process.env; the existing unit lane still passes (`nx run stealth-browser:test` exits 0, messages preserved).
- [prod-errors.4] (PA5.2, PA5.3, PA5.5, widened) the CLI and the MCP host map EVERY code consistently: bin/cli.ts and bin/mcp.ts preflight Node >= 22.5 (NODE_TOO_OLD, one-line message); src/cli.ts exits through `exitCodeFor(error.code)` printing `<CODE>: <message>` on stderr with no stack trace; src/server.ts returns `isError: true` with the code and message in the content for any StealthBrowserError; against a dead port the built CLI exits non-zero (the CHROME_NOT_RUNNING exit code) and the built MCP returns isError with CHROME_NOT_RUNNING.
- [prod-errors.5] (audit criterion) No untyped error escapes: no `new Error(`, `new TypeError(`, `Promise.reject('...')` or `throw '...'` exists in non-test src/ or bin/ outside src/errors.ts (every throw site raises a StealthBrowserError code).
- [prod-errors.6] docs/ERRORS.md lists every code with its CLI exit code, its MCP isError code and its remediation, in the order of `ERROR_CODES`, and the root of the package exports StealthBrowserError, ERROR_CODES and exitCodeFor (src/index.ts re-exports ./errors.js).
- [prod-errors.7] (amendment A3, greenfield root) src/index.ts exports the `recording` and `lifecycle` namespaces (`export * as recording from './lib/recording/index.js'`, `export * as lifecycle from './lib/lifecycle/index.js'`); `recording` exposes NetworkRecorder, CaptureError, MemoryRecordingSink, StoreRecordingSink, openStoreRecordingSink and redactHeaders, `capture` exposes captureAllNetworkResponses, `lifecycle` exposes LifecycleError, openIsolatedPage, withIsolatedPage, installProcessExitHooks, runChromeReaper and createProxyReaperLink (the detached reaper loads runChromeReaper through the package entry).
- [prod-errors.8] (amendment A4) CaptureError (src/lib/recording/errors.ts) and LifecycleError (src/lib/lifecycle/errors.ts) extend StealthBrowserError, so one `instanceof` covers every package error; `exitCodeFor` and docs/ERRORS.md cover every code; a classifier maps a launch failure whose cause is ENOENT to CHROME_NOT_FOUND and EADDRINUSE to PORT_IN_USE (unit-tested).

---

## Reservations

```text
read_only:  ["docs/plan/stealth-browser/specs/"]
mutates:    ["entrypoint/stealth-browser/src/errors.ts", "entrypoint/stealth-browser/src/lib/", "entrypoint/stealth-browser/src/server.ts", "entrypoint/stealth-browser/src/cli.ts", "entrypoint/stealth-browser/src/index.ts", "entrypoint/stealth-browser/bin/", "entrypoint/stealth-browser/docs/ERRORS.md", "entrypoint/stealth-browser/src/test/unit/errors/"]
```

---

## Contract Promise

Added: `src/errors.ts`, `docs/ERRORS.md`, `src/test/unit/errors/**`. Modified: the lib throw sites, `src/server.ts`, `src/cli.ts`, `src/index.ts`, `bin/*.ts`. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:prod-errors]`:

- [ ] After errors.ts and the lib throw sites — commit: `feat(stealth-browser): typed errors across the library [psm:prod-errors]`
- [ ] After the host mapping and docs — commit: `feat(stealth-browser): CLI exit codes and MCP error payloads [psm:prod-errors]`
- [ ] After the per-code specs — commit: `test(stealth-browser): one unit test per error code [psm:prod-errors]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- `tests-unit-core`, `-data`, `-extract`, `capture-upgrade` and `chrome-lifecycle` are ancestors on purpose: their specs protect existing messages while you retype the throw sites and re-base the two error classes.
- `tests-unit-surface` runs in parallel; its public-API snapshot covers the core exports only (this state adds the errors, `recording` and `lifecycle` exports).
