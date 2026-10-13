# surface-hosts — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** surface-api, chrome-lifecycle, sp-link · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The same six verbs are reachable from three surfaces: the library (`src/index.ts`), a CLI (`stealth-browser`) and a stdio MCP server (`stealth-browser-mcp`), both generated from `api.ts` by apigen and both built into `dist/bin/`.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-browser/src/server.ts`, `entrypoint/stealth-browser/src/cli.ts`, `entrypoint/stealth-browser/bin/cli.ts`, `entrypoint/stealth-browser/bin/mcp.ts`; MODIFY `entrypoint/stealth-browser/package.json`.

- **Reference Pattern:** `entrypoint/backlog/src/server.ts` and `src/cli.ts` (MCP/CLI host shape, [ref:apigen-host]); `entrypoint/dispatch-cli/bin/cli.ts` (bin fallback rationale); `/Users/nix/dev/ai/scratch/agent-browser/server.mjs` (the current MCP host).

- **Delta Spec:** `server.ts` builds the apigen MCP server over `api.ts` with `@adhd/apigen-plugin-mcp`; `cli.ts` the CLI host with the cli-output plugin; `bin/cli.ts` and `bin/mcp.ts` are the executable entry shims (shebang, import from `../src/...js`). package.json: `bin: { stealth-browser: ./dist/bin/cli.js, stealth-browser-mcp: ./dist/bin/mcp.js }` and dependencies on the apigen packages (`@adhd/apigen-core-client`, `@adhd/apigen-engine-runtime`, `@adhd/apigen-plugin-mcp`, cli-output plugin) as used by `entrypoint/backlog`. The `usePlugins` arrays are authored here WITHOUT tracing; tracing-plugin adds it next. Productization (PRODUCT-REVIEW.md) adds, all at the host layer: (P1) the host input allowlist: the generated MCP tool and CLI command for `launchChrome` expose only `port` and `userDataDir`, a call carrying `extraArgs`/`chromePath` is rejected and spawns nothing; (P2) `src/host-projection.ts` exports `redactCookieValues`, applied to `getPageContext` output in BOTH `server.ts` and `cli.ts` (names and counts stay, value strings are dropped; the library result in `api.ts` is untouched); (P3) `package.json` `exports['./legacy']` pointing at the built `src/legacy.ts` output (the file is `prod-public-api`'s), the built root `index.d.ts` free of Google/Search names, `verify-dist-load` green; (P4) tool descriptions >= 40 chars, `--help` text with the default port, and the CLI-verb/MCP-tool naming decision recorded in `evidence/naming-decision.md` (resolves U1 and U2: compare sibling `dispatch-cli`/`backlog` conventions and the built `--help`/`tools/list`); (P5) host mapping of `classifyError` from `src/errors.ts` (CLI: non-zero exit, one-line message with the code on stderr, no stack trace; MCP: `isError: true`, code in the content) and a Node >= 22.5 preflight in `bin/cli.ts` and `bin/mcp.ts`; (P6) `--port` and `--user-data-dir` flags on both bins, with `--help` printing the defaults (config stays typed options in the library; no env reads in `api.ts`).

- **Invariants:** [inv:esm-js-specifiers]; stdout of the MCP bin carries only JSON-RPC (logs go to stderr); stealth flags unchanged. Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:surface-hosts]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts` — runs every acceptance criterion below (red until the work is done); `--only surface-hosts.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py surface-hosts --only surface-hosts.N`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [surface-hosts.1] src/server.ts (MCP stdio host via @adhd/apigen-plugin-mcp), src/cli.ts and bin/cli.ts, bin/mcp.ts exist.
- [surface-hosts.2] package.json declares bin entries stealth-browser and stealth-browser-mcp pointing into ./dist/bin/ and depends on the apigen core-client/engine-runtime/plugin-mcp/plugin-cli-output packages.
- [surface-hosts.3] `nx run stealth-browser:build-bin` exits 0 and emits dist/bin/cli.js and dist/bin/mcp.js.
- [surface-hosts.4] `node dist/bin/cli.js --help` exits 0 and lists all six verbs (the apigen extraction does not crash on the zod/$ref class of failure).
- [surface-hosts.5] `node dist/bin/cli.js chrome-status --json` (or the chromeStatus verb) against an unused port prints running=false with exit 0 - the CLI reaches the real library, not a stub.
- [surface-hosts.6] Only owned paths changed by [psm:surface-hosts] commits.
- [surface-hosts.7] (PA1.2, PA1.3) The built MCP bin's tools/list schema for launchChrome has no chromePath or extraArgs property, and a tools/call for launchChrome with extraArgs is rejected with no process spawned (port stays closed) and no profile dir created.
- [surface-hosts.8] (PA2.1) src/host-projection.ts exports redactCookieValues (names and counts kept, value strings dropped) and BOTH src/server.ts and src/cli.ts route getPageContext output through it; the library result in api.ts is unchanged (parity).
- [surface-hosts.9] (PA3.3, PA3.4, ADR-0003) package.json has NO `exports` map and NO `module` field, `main` is ./dist/index.js and `types` ./dist/index.d.ts; the built root index.d.ts (namespaces included) exports no Google- or Search-named symbol; `require()` of the built dist/index.js exposes the five namespaces and the six verbs; `nx run stealth-browser:verify-dist-load` exits 0.
- [surface-hosts.10] (PA4.1, PA4.2) tools/list returns a description of at least 40 characters for each of the six tools; `cli --help` and `cli launchChrome --help` each show a description and the default port 9222.
- [surface-hosts.11] (PA4.3, PA4.4, resolves U1/U2) evidence/naming-decision.md records `CLI-STYLE: camelCase|kebab-case`, `MCP-NAMES: <the six tool names>`, `U1: resolved` and `U2: resolved`; the built tools/list names and the CLI verb style match the record.
- [surface-hosts.13] (PA6.1) Both bins accept --port and --user-data-dir and print the defaults in --help (9222 and the Chrome-CDP profile path).
- [surface-hosts.14] (gap G2, F23 F24) the hosts wire the lifecycle: src/server.ts and src/cli.ts call `installProcessExitHooks` (from the lifecycle namespace) with the shared ChromeManager, the CLI accepts `--idle-shutdown <ms>` (default 120000) and `--keep-alive` mapped onto the ChromeManager options (`--keep-alive` disables the idle reaper, `reaper` detached by default), the MCP host installs the hooks with `stdinEof: true` (orphan detection), and both bins print the two flags and the defaults in --help.

---

## Reservations

```text
read_only:  ["entrypoint/stealth-browser/src/api.ts", "entrypoint/stealth-browser/src/index.ts", "entrypoint/stealth-browser/src/legacy.ts", "entrypoint/stealth-browser/src/errors.ts", "entrypoint/backlog/src/", "entrypoint/dispatch-cli/bin/"]
mutates:    ["entrypoint/stealth-browser/src/server.ts", "entrypoint/stealth-browser/src/cli.ts", "entrypoint/stealth-browser/src/host-projection.ts", "entrypoint/stealth-browser/bin/", "entrypoint/stealth-browser/package.json", "docs/plan/stealth-browser/evidence/naming-decision.md"]
```

---

## Contract Promise

Added: server.ts, cli.ts, bin/cli.ts, bin/mcp.ts. Modified: package.json (bin + deps). Deleted: none.

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
- Early assertions: `surface-hosts.7` and `.12` probe the BUILT bins (tools/list schema, extraArgs rejection, dead-port error shape on port 19999/19997) so the two claims product could not verify (do launchChrome options reach the MCP schema; does getPageContext return cookie values) are settled by evidence, not assumption; read `evidence/product-claims.json` (from `surface-api.8`) first.
- Do not launch a persistent Chrome in this state; `chromeStatus` against an unused port is the cheap probe.
- Lifecycle wiring (surface-hosts.14, gap G2 of EVAL-service-proxy.md): `chrome-lifecycle` is now an ancestor. Call `lifecycle.installProcessExitHooks(manager, { stdinEof: true })` in the MCP host (orphan detection) and in the CLI, add `--idle-shutdown <ms>` (default 120000) and `--keep-alive` to the CLI and map them onto the ChromeManager options (`--keep-alive` turns the idle reaper off), and print `status()` (sibling warning) where the hosts report health. The hooks themselves live in the package (chrome-lifecycle.14); do not reimplement them.
- `sp-link` is an ancestor on purpose: it is the single editor of the proxy dependency line, so the stealth-browser `package.json` owners are serialized. This state edits `bin`, `exports`/`module` removal and the apigen dependencies only; it never touches the `@adhd/sox-service-proxy` line.
- The lifecycle wiring (`installProcessExitHooks`, `--idle-shutdown`, `--keep-alive`, `status()`) reads only the public manager shape of CL26 (`ChromeManagerOptions { cdpHost, idleTimeoutMs, checkHistory, shutdownGraceMs, orphanWindowMs, stateDir, reaperScope, link, logger }`, `release()`, `status()`); `--keep-alive` builds the manager so that it never asks the reaper host to reap.
