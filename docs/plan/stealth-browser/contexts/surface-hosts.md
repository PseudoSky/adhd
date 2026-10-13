# surface-hosts — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** surface-api, chrome-lifecycle, sp-link · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The same six verbs are reachable from three surfaces: the library (`src/index.ts`), a CLI (`stealth-browser`) and a stdio MCP server (`stealth-browser-mcp`), both generated from `api.ts` by apigen and both built into `dist/bin/`.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/server.ts`, `src/cli.ts`, `src/host-projection.ts`, `src/lib/managers.ts`, `bin/cli.ts`, `bin/mcp.ts`, the host unit specs under `src/test/unit/hosts/` and `docs/plan/stealth-browser/evidence/naming-decision.md`; MODIFY `entrypoint/stealth-browser/package.json`, `pnpm-lock.yaml` (the apigen dependencies only), `src/api.ts` (manager construction moves to `managers.ts`), `src/lib/chrome-manager.ts` (two host options), `src/lib/lifecycle/index.ts` (one re-export line and its header comment) and `src/index.ts` (the root `lifecycle` namespace).

- **Reference Pattern:** `entrypoint/backlog/src/server.ts` and `src/cli.ts` (MCP/CLI host shape, [ref:apigen-host]); `entrypoint/dispatch-cli/bin/cli.ts` (bin fallback rationale); `/Users/nix/dev/ai/scratch/agent-browser/server.mjs` (the current MCP host).

- **Delta Spec:** `server.ts` builds the apigen MCP server over `api.ts` with `@adhd/apigen-plugin-mcp`; `cli.ts` the CLI host with the cli-output plugin; `bin/cli.ts` and `bin/mcp.ts` are the executable entry shims (shebang, import from `../src/...js`). package.json: `bin: { stealth-browser: ./dist/bin/cli.js, stealth-browser-mcp: ./dist/bin/mcp.js }` and dependencies on the apigen packages (`@adhd/apigen-core-client`, `@adhd/apigen-engine-runtime`, `@adhd/apigen-plugin-mcp`, cli-output plugin) as used by `entrypoint/backlog`. The `usePlugins` arrays are authored here WITHOUT tracing; tracing-plugin adds it next. Productization (PRODUCT-REVIEW.md) adds, all at the host layer: (P1) the host input allowlist: the generated MCP tool and CLI command for `launchChrome` expose only `port` and `userDataDir`, a call carrying `extraArgs`/`chromePath` is rejected and spawns nothing; (P2) `src/host-projection.ts` exports `redactCookieValues`, applied to `getPageContext` output in BOTH `server.ts` and `cli.ts` (names and counts stay, value strings are dropped; the library result in `api.ts` is untouched); (P3) the ADR-0003 manifest shape: `package.json` has NO `exports` map and NO `module` field (delete the existing `"module": "./dist/index.mjs"` line; no subpath, no `./legacy`), `main` stays `./dist/index.js` and `types` `./dist/index.d.ts`, the built root `index.d.ts` is free of Google/Search names, `verify-dist-load` green; (P4) tool descriptions >= 40 chars, `--help` text with the default port, and the CLI-verb/MCP-tool naming decision recorded in `evidence/naming-decision.md` (resolves U1 and U2: compare sibling `dispatch-cli`/`backlog` conventions and the built `--help`/`tools/list`); (P5) a Node >= 22.5 preflight in `bin/cli.ts` and `bin/mcp.ts` (exit non-zero with a one-line stderr message naming the required version) and a GENERIC code-based error mapping at the host layer: an error carrying a string `code` is reported as `<code>: <message>` (CLI: one stderr line, non-zero exit, no stack trace; MCP: `isError: true` with the code and message in the content), any other error as its message. `src/errors.ts` (`StealthBrowserError`, `ERROR_CODES`, `exitCodeFor`, `classifyError`) does not exist yet: `prod-errors` creates it later and replaces the generic mapping with the typed one, so nothing here imports `src/errors.ts`; (P6) `--port` and `--user-data-dir` flags on both bins, with `--help` printing the defaults (config stays typed options in the library; no environment variable is read anywhere in `src/` or `bin/`, ADR-0013). (P7) The shared manager seam, so a host can configure the managers the verbs use without the configure functions becoming MCP tools: `src/lib/managers.ts` (a non-apigen module) owns the process-wide `Map<cdpHost, ChromeManager>` that moves out of `api.ts` and exports `configureManagers({ idleTimeoutMs?, keepAlive?, entryPath? })` (host-level defaults for every manager built afterwards; hosts call it once at startup before the first verb), `managerFor(cdpHost)` (the ONLY place a `ChromeManager` is constructed) and `chromeExitTarget`, an `ExitHookTarget` aggregate whose `release()` and `shutdownIfIdle()` fan out over every live manager. `api.ts` imports `managerFor` from `./lib/managers.js` and exports nothing new (its exports are MCP tools). `ChromeManagerOptions` gains `keepAlive?: boolean` (default false; true never arms the idle timer, so no idle soft-reap fires; explicit `shutdownChrome`, `shutdown()`, the exit-hook soft shutdown and the reaper host's grace close after the last client releases are unchanged) and `entryPath?: string` (forwarded to `createProxyReaperLink`'s `entryPath`). (P8) Root wiring: `src/index.ts` gains `export * as lifecycle from './lib/lifecycle/index.js'` (the detached reaper runs `require(<dist/index.js>).lifecycle.runChromeReaper`, so the hosts' reaper cannot start without it), and `src/lib/lifecycle/index.ts` gains `export { configureManagers, managerFor, chromeExitTarget } from '../managers.js'` (no lifecycle module imports `chrome-manager` or the barrel, so there is no cycle) and its header comment says the namespace is wired at the root by `surface-hosts`.

- **Invariants:** [inv:esm-js-specifiers]; stdout of the MCP bin carries only JSON-RPC (logs go to stderr); stealth flags unchanged. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:surface-hosts]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts` — runs every acceptance criterion below (red until the work is done); `--only surface-hosts.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts --only surface-hosts.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [surface-hosts.1] src/server.ts (MCP stdio host via @adhd/apigen-plugin-mcp), src/cli.ts and bin/cli.ts, bin/mcp.ts exist.
- [surface-hosts.2] package.json declares bin entries stealth-browser and stealth-browser-mcp pointing into ./dist/bin/ and depends on the apigen core-client/engine-runtime/plugin-mcp/plugin-cli-output packages.
- [surface-hosts.3] `nx run stealth-browser:build-bin` exits 0 and emits dist/bin/cli.js and dist/bin/mcp.js.
- [surface-hosts.4] `node dist/bin/cli.js --help` exits 0 and lists all six verbs (the apigen extraction does not crash on the zod/$ref class of failure).
- [surface-hosts.5] `node dist/bin/cli.js chromeStatus --port 19999` (or `chrome-status --port 19999`) against the unused port 19999 prints running=false with exit 0 - the CLI reaches the real library through the `--port` flag (no environment variable), not a stub.
- [surface-hosts.6] Only owned paths changed by [psm:surface-hosts] commits.
- [surface-hosts.7] (PA1.2, PA1.3) The built MCP bin's tools/list schema for launchChrome has no chromePath or extraArgs property, and a tools/call for launchChrome with extraArgs is rejected with no process spawned (port stays closed) and no profile dir created.
- [surface-hosts.8] (PA2.1) src/host-projection.ts exports redactCookieValues (names and counts kept, value strings dropped) and BOTH src/server.ts and src/cli.ts route getPageContext output through it; the library result in api.ts is unchanged (parity).
- [surface-hosts.9] (PA3.3, PA3.4, ADR-0003) package.json has NO `exports` map and NO `module` field, `main` is ./dist/index.js and `types` ./dist/index.d.ts; the built root index.d.ts (namespaces included) exports no Google- or Search-named symbol; `require()` of the built dist/index.js exposes the five namespaces, the `lifecycle` namespace and the six verbs; `nx run stealth-browser:verify-dist-load` exits 0.
- [surface-hosts.10] (PA4.1, PA4.2) tools/list returns a description of at least 40 characters for each of the six tools; `cli --help` and `cli launchChrome --help` each show a description and the default port 9222.
- [surface-hosts.11] (PA4.3, PA4.4, resolves U1/U2) evidence/naming-decision.md records `CLI-STYLE: camelCase|kebab-case`, `MCP-NAMES: <the six tool names>`, `U1: resolved` and `U2: resolved`; the built tools/list names and the CLI verb style match the record.
- [surface-hosts.13] (PA6.1) Both bins accept --port and --user-data-dir and print the defaults in --help (9222 and the Chrome-CDP profile path).
- [surface-hosts.14] (gap G2, F23 F24) the hosts wire the lifecycle: src/server.ts and src/cli.ts call `installProcessExitHooks` (from the lifecycle namespace) with the shared manager seam `chromeExitTarget`, both hosts accept `--idle-shutdown <ms>` (default 120000) and `--keep-alive` and pass them to `configureManagers` as `idleTimeoutMs` and `keepAlive` (`--keep-alive` never arms the idle timer; every other shutdown path is unchanged), the MCP host installs the hooks with `stdinEof: true` (orphan detection), and both bins print the two flags and the defaults in --help.
- [surface-hosts.15] (P7, P8) the manager seam is shared and reachable from the root: src/lib/managers.ts exports configureManagers, managerFor and chromeExitTarget and is the only non-test file under src/ that constructs a ChromeManager (`new ChromeManager(`); src/api.ts imports managerFor from './lib/managers.js' and neither file reads process.env; `ChromeManagerOptions` declares `keepAlive?` and `entryPath?` and chrome-manager.ts passes entryPath to createProxyReaperLink; src/index.ts exports `lifecycle` from './lib/lifecycle/index.js' and src/lib/lifecycle/index.ts re-exports from '../managers.js'; `require()` of the built dist/index.js exposes lifecycle.configureManagers, lifecycle.managerFor, lifecycle.chromeExitTarget, lifecycle.installProcessExitHooks and lifecycle.runChromeReaper.
- [surface-hosts.16] Host unit specs simulate real use in-process: spec files under src/test/unit/hosts/ cite ticket 8468f7b1 and [surface-hosts.16], import no node:child_process, and drive the real configureManagers, managerFor and chromeExitTarget (`keepAlive` true never arms the idle timer, `release()` and `shutdownIfIdle()` reach every live manager) and the host flag mapping of `--port`, `--user-data-dir`, `--idle-shutdown` and `--keep-alive`; `nx run stealth-browser:test -- src/test/unit/hosts` exits 0.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/lib/lifecycle/exit-hooks.ts", "entrypoint/stealth-browser/src/lib/lifecycle/reaper-link.ts", "entrypoint/stealth-browser/src/test/unit/lifecycle/fake-reaper-link.ts", "entrypoint/backlog/src/", "entrypoint/dispatch-cli/bin/"]
mutates:    ["entrypoint/stealth-browser/src/server.ts", "entrypoint/stealth-browser/src/cli.ts", "entrypoint/stealth-browser/src/host-projection.ts", "entrypoint/stealth-browser/bin/", "entrypoint/stealth-browser/package.json", "docs/plan/stealth-browser/evidence/naming-decision.md", "pnpm-lock.yaml", "entrypoint/stealth-browser/src/lib/managers.ts", "entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/lib/chrome-manager.ts", "entrypoint/stealth-browser/src/lib/lifecycle/index.ts", "entrypoint/stealth-browser/src/index.ts", "entrypoint/stealth-browser/src/test/unit/hosts/"]
```

---

## Contract Promise

Added: `src/server.ts`, `src/cli.ts`, `src/host-projection.ts`, `src/lib/managers.ts`, `bin/cli.ts`, `bin/mcp.ts`, `src/test/unit/hosts/*.spec.ts`, `evidence/naming-decision.md`. Modified: `package.json` (bin, apigen dependencies, `module` field removed), `pnpm-lock.yaml` (the stealth-browser importer's apigen dependencies only), `src/api.ts` (manager map moved to `managers.ts`), `src/lib/chrome-manager.ts` (`keepAlive?`, `entryPath?`), `src/lib/lifecycle/index.ts` (seam re-export, header comment), `src/index.ts` (root `lifecycle` namespace). Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:surface-hosts]`:

- [ ] After the CLI host works -- commit: `feat(stealth-browser): cli host [psm:surface-hosts]`
- [ ] After the MCP host works -- commit: `feat(stealth-browser): mcp host [psm:surface-hosts]`
- [ ] **After the guard passes** (mandatory) — commit the source changes and the `state.json` update together by explicit path.

---

## Notes for executor

- Known apigen failure class: optional booleans in return types break extraction (see surface-api). If `--help` crashes, fix the type, not the host.
- Use dependency ranges and package names exactly as `entrypoint/backlog/package.json` resolves them in this workspace; `nx run stealth-browser:lint` enforces dependency-checks.
- Early assertions: `surface-hosts.7` and `.5` probe the BUILT bins (tools/list schema and extraArgs rejection on port 19997, `chromeStatus --port 19999` on a dead port) so the two claims product could not verify (do launchChrome options reach the MCP schema; does getPageContext return cookie values) are settled by evidence, not assumption; read `evidence/product-claims.json` (from `surface-api.8`) first.
- Do not launch a persistent Chrome in this state; `chromeStatus` against an unused port is the cheap probe.
- Lifecycle wiring (surface-hosts.14, gap G2 of EVAL-service-proxy.md): `chrome-lifecycle` is now an ancestor. Call `lifecycle.installProcessExitHooks(lifecycle.chromeExitTarget, { stdinEof: true })` in the MCP host (orphan detection) and `installProcessExitHooks(lifecycle.chromeExitTarget)` in the CLI, add `--idle-shutdown <ms>` (default 120000) and `--keep-alive` to both bins and pass them to `lifecycle.configureManagers({ idleTimeoutMs, keepAlive, entryPath })` once at startup, and print `status()` (sibling warning) where the hosts report health. The hooks themselves live in the package (chrome-lifecycle.14); do not reimplement them.
- `sp-link` is an ancestor on purpose: it is the single editor of the proxy dependency line, so the stealth-browser `package.json` owners are serialized. This state edits `bin`, the `module` removal and the apigen dependencies only; it never touches the `@adhd/sox-service-proxy` line. Add the four apigen packages at the ranges `entrypoint/backlog/package.json` uses (`@adhd/apigen-core-client`, `@adhd/apigen-engine-runtime`, `@adhd/apigen-plugin-mcp`, `@adhd/apigen-plugin-cli-output`; never `link:`/`file:`) and run the worktree install so `pnpm-lock.yaml` resolves them; the lockfile diff is confined to the `entrypoint/stealth-browser` importer (no other importer or package version changes).
- The lifecycle wiring (`installProcessExitHooks`, `--idle-shutdown`, `--keep-alive`, `status()`) reads only the public manager shape of CL26 (`ChromeManagerOptions { cdpHost, idleTimeoutMs, checkHistory, shutdownGraceMs, orphanWindowMs, stateDir, reaperScope, link, logger }` plus this state's `keepAlive` and `entryPath`, `release()`, `status()`). Do not add a `reaper` option (CL26 retires it); `keepAlive: true` is the only keep-alive mechanism.
- One module instance (load-bearing): `build-bin` compiles `src/` again into `dist/src/` with tsc, a SECOND copy of `api.ts` and `managers.ts` whose manager map the bundled verbs never see and whose `__filename` is not the reaper entry. The hosts therefore load the built root CommonJS entry (`dist/index.js`) at runtime and take the live verb functions AND `lifecycle.configureManagers` / `lifecycle.chromeExitTarget` / `lifecycle.installProcessExitHooks` from that one object, with schemas extracted from `dist/api.d.ts` (the `entrypoint/backlog/src/server.ts` extraction path). They never import `../src/api.js` or `../src/lib/managers.js` for live use. Pass `entryPath` = the absolute path of the `dist/index.js` they loaded.
- Host unit specs live in `src/test/unit/hosts/` (excluded from `tsconfig.lib.json`, so `build-bin` does not compile them; a spec under `bin/` would be). Export the flag parser and the host factories (`server.ts` / `cli.ts`) so these specs and `tests-unit-surface`'s `host.spec.ts` build hosts in-process; no spec spawns a process, launches Chrome or touches port 9222. `src/test/unit/surface/` stays `tests-unit-surface`'s.
- The proxy package name must not appear in `managers.ts` (chrome-lifecycle.22 scans every `src/lib/**/*.ts` but `sp.ts`), and `process.env` must not appear in `src/lib/lifecycle/` (chrome-lifecycle.23).
