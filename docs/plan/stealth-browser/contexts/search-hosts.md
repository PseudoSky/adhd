# search-hosts — WORK STATE

**Phase:** surface · **Kind:** work · **Depends on:** search-verbs, search-tracing, core-seam · **Guard:** `python3 docs/plan/stealth-browser/scripts/guard.py search-hosts`
**Executor:** `typescript-pro` (sonnet/high) · **Worktree:** `/Users/nix/dev/node/adhd/.worktrees/stealth-browser` on branch `stealth-browser` (shared by every state, [inv:shared-worktree], [inv:worktree-required], [inv:no-ai-attribution])

---

## Goal

The same eleven operations of `src/api.ts` are reachable from two hosts built on apigen: the human CLI `stealth-search` and the MCP server `stealth-search-mcp` (stdio, sse, streaming-http). Both mount the single `adhd` tracing plugin from `src/tracing.ts`, take every setting from typed host flags (no environment variable), wire the core Chrome lifecycle, fail with typed codes and run on Node >= 22.5.

---

## Semantic Distillation

- **Primitive:** CREATE `entrypoint/stealth-search/src/server.ts`, `src/cli.ts`, `src/host-flags.ts`, `src/host-errors.ts`, `bin/cli.ts`, `bin/mcp.ts`, `src/test/unit/hosts/*.spec.ts` and `docs/plan/stealth-browser/evidence/naming-decision.md`; MODIFY `entrypoint/stealth-search/package.json` and `pnpm-lock.yaml` (the stealth-search importer only) when the probe drops or adds a dependency.

- **Reference Pattern:** `entrypoint/backlog/src/{server,cli}.ts`, `entrypoint/dispatch-cli/bin/cli.ts` ([ref:apigen-host], [ref:entrypoint-structure]); SPEC 2.3-2.4 ([ref:stealth-search-spec]).

- **Delta Spec:** FIRST STEPS (probes, record before writing hosts): (a) O12: does `cliPlugin.run` parse the host flags itself? Record `O12: commander|cliPlugin` in `naming-decision.md` and drop `commander` from package.json if cliPlugin suffices; (b) U1/U2: build once, read the built `--help` and `tools/list`, record `CLI-STYLE: camelCase|kebab-case`, `MCP-NAMES:` (the eleven `stealth_*` names) and `U1: resolved` / `U2: resolved`. `server.ts` exports `buildStealthSearchPackage()` (extract from the BUILT `dist/api.d.ts`, compose, live functions from `api.js`) and runs `mcpPlugin.run` with `usePlugins: [tracingPlugin]` for `--transport stdio|sse|streaming-http` (default stdio); `cli.ts` runs `cliPlugin` over the same package and plugin; neither calls `initTelemetry` (the bins call `src/telemetry.ts`). `host-flags.ts` parses the SPEC 2.3 flag table into a typed `SearchHostConfig` (defaults in `--help`). `host-errors.ts` holds `HOST_FLAG_INVALID`, `HOST_TRANSPORT_UNSUPPORTED`, `HOST_BOOT_FAILED` as `StealthSearchError` subclasses (extends the registry of `search-errors`, which owns `src/errors.ts`) and the mapping: CLI `<CODE>: <message>` on one stderr line, MCP `isError: true`. Bins run the Node >= 22.5 preflight first. Boot behaviour ported from `server.mjs` (I-33/I-34): boot trace file, pid registry with sibling warning, crash handlers doing a soft Chrome shutdown then exit 1, bounded shutdown (5000 ms forced exit), stdin-EOF orphan detection (1000 ms grace, stdio only), `installProcessExitHooks(chromeExitTarget, {stdinEof})`, `configureManagers({idleTimeoutMs, keepAlive, checkHistory, entryPath, logger})` once at startup, `--restart-browser` -> `shutdownChrome`. The hosts use the BUILT core (one module instance); P1 is inherited from core `LaunchChromeInput` and re-proven on the built `tools/list`.

- **Invariants:** [inv:search-over-core] [inv:trace-namespace] [inv:typed-errors] [inv:greenfield] [inv:pnpm-only] [inv:esm-js-specifiers]; MCP stdout carries only JSON-RPC (logs go to stderr). Also: [inv:shared-worktree] (commit only your own explicit paths, tag every commit `[psm:search-hosts]`), [inv:owned-paths-only], [inv:no-main-writes].

- **Validation:** `python3 docs/plan/stealth-browser/scripts/guard.py search-hosts` runs every acceptance criterion below (red until the work is done); `--only search-hosts.N` runs one.

---

## Acceptance criteria

Each criterion is a deterministic check in `docs/plan/stealth-browser/scripts/guard.py` (`python3 docs/plan/stealth-browser/scripts/guard.py search-hosts --only search-hosts.N`, loaded from `scripts/guards/search_b.py`). None may be deferred. Tests written by this plan cite ticket `8468f7b1` and these ids ([inv:tests-cite]).

- [search-hosts.1] src/server.ts, src/cli.ts, src/host-flags.ts, src/host-errors.ts, bin/cli.ts and bin/mcp.ts exist in entrypoint/stealth-search.
- [search-hosts.2] package.json declares bins stealth-search and stealth-search-mcp into ./dist/bin/, depends on the apigen core-client/engine-runtime/plugin-mcp/plugin-cli-output/plugin-tracing packages, the core, tripwire and sox-telemetry packages, has no link:/file: value and no exports/module field.
- [search-hosts.3] `nx run stealth-search:build-bin` exits 0 and emits dist/bin/cli.js and dist/bin/mcp.js.
- [search-hosts.4] `node dist/bin/cli.js --help` exits 0 and lists all eleven operations by the style recorded in naming-decision.md (the apigen extraction does not crash on SearchInput: probe U-BOOL).
- [search-hosts.5] The CLI reaches the real core through the --cdp-port flag: `chromeStatus --cdp-port 19999` against an unused port prints running=false and exits 0 (no environment variable, no stub).
- [search-hosts.6] Both bins print the whole host-flag table in --help, each flag with its default where it has one (cdp-port 9222, listen-port 3100, listen-host 127.0.0.1, transport stdio, idle-shutdown 120000, tripwire-ttl-ms 7200000, cooldowns 30000/20000/60000, max-concurrent 2, max-siblings 4).
- [search-hosts.7] The built MCP bin's tools/list names equal naming-decision.md MCP-NAMES (all stealth_*), every description is at least 40 characters, the launchChrome schema has no chromePath or extraArgs property, and a launchChrome call carrying extraArgs is rejected with nothing spawned (port 19997 stays closed, no profile dir).
- [search-hosts.8] evidence/naming-decision.md records `CLI-STYLE: camelCase|kebab-case`, `MCP-NAMES:` the eleven stealth_* tool names, `U1: resolved`, `U2: resolved` and `O12: commander|cliPlugin` (the first-step probe: whether cliPlugin parses the host flags itself, which decides whether `commander` stays a dependency; package.json agrees with the record).
- [search-hosts.9] Node >= 22.5 preflight in both bins: each of bin/cli.ts and bin/mcp.ts compares process.versions.node against 22.5 and fails with the typed NODE_TOO_OLD code (one stderr line `NODE_TOO_OLD: <message>`, non-zero exit).
- [search-hosts.10] Host errors are typed (100%): src/host-errors.ts defines HOST_FLAG_INVALID, HOST_TRANSPORT_UNSUPPORTED, HOST_BOOT_FAILED (NODE_TOO_OLD is core-owned and reused) as StealthSearchError subclasses, the host files hold no bare `new Error(`, and `cli --cdp-port notanumber <chromeStatus>` fails non-zero with a stderr line starting `HOST_FLAG_INVALID:` and no stack trace.
- [search-hosts.11] No environment variable is read anywhere in src/ or bin/ of stealth-search (ADR-0001: every former SEARCH_* toggle is a typed option or host flag) and no tsx runtime import remains.
- [search-hosts.12] All three MCP transports boot from the built stealth-search-mcp bin: stdio answers tools/list, and `--transport sse` and `--transport streaming-http` bind --listen-port on an unused port (probe by connect) and exit cleanly on SIGTERM; an unknown transport fails with HOST_TRANSPORT_UNSUPPORTED.
- [search-hosts.13] The lifecycle is wired in both hosts: server.ts and cli.ts call the core `lifecycle.installProcessExitHooks` with `chromeExitTarget`, the MCP host passes `stdinEof: true`, both call `configureManagers` with idleTimeoutMs, keepAlive, checkHistory:false-by-default-of-search (the search host passes the option explicitly), entryPath and a stderr logger, and --restart-browser maps to shutdownChrome.
- [search-hosts.14] Boot behaviours of server.mjs are ported as flag-driven code: --trace-file boot trace, --pid-file registry with the --max-siblings warning, uncaughtException and unhandledRejection handlers doing a soft Chrome shutdown then exit 1, a bounded shutdown with a 5000 ms forced exit, and stdin-EOF orphan detection with a 1000 ms grace for stdio only.
- [search-hosts.15] Tracing is mounted, not configured, by the hosts: server.ts and cli.ts import `tracingPlugin` from './tracing.js' and list it in `usePlugins`; no host or bin file holds a serviceName literal or imports the apigen package singleton `tracingPlugin`; each bin reaches telemetry only through './telemetry.js' (the one initTelemetry stays in src/telemetry.ts).
- [search-hosts.16] Host unit specs simulate real use in-process: spec files under src/test/unit/hosts/ cite ticket 8468f7b1 and [search-hosts.16], import no child_process, and drive the real flag parser (every flag of the table, defaults, HOST_FLAG_INVALID for bad values), the extraArgs rejection, the NODE_TOO_OLD preflight function, the transport selection and exit-hook wiring through the exported host factories; `nx run stealth-search:test -- src/test/unit/hosts` exits 0.
- [search-hosts.17] Only owned paths changed by [psm:search-hosts] commits.

- [search-hosts.18] (backlog abeedba8) The CLI exits as soon as its JSON is written: the host closes every browser handle, flushes stdout, then exits 0. Proven by (a) a spec under src/test/unit/hosts/ on the exported CLI runner with an injected stdout sink and exit function asserting the order write, flush, handles closed, exit(0), and that no timer or socket handle is left open (the idle-shutdown child is detached with stdio ignored and never inherits stdout), and (b) a real-process probe run by this guard: three `node dist/bin/cli.js chromeStatus --cdp-port 19999` processes started together with stdout redirected to files each exit 0 within 15 s and each file holds one parseable JSON document with running=false (a 0-byte output fails). Titles carry `flush`, `exit`, `detached`, `idleShutdown`, `stdout` and the uid abeedba8, and the spec cites [search-hosts.18].
- [search-hosts.19] (backlog 657bd597) Human-in-the-loop prompts never hang on a closed or non-interactive stdin: the CLI's `InteractionPort` implementation checks `process.stdin.isTTY` and the stream end; with a closed stdin or no TTY the gate prompt and the solved confirmation reject immediately with StealthSearchError HITL_ABORTED (no new code; the exit code comes from `exitCodeFor`, stable and non-zero) within 1000 ms and the tripped provider stays tripped. A spec under src/test/unit/hosts/ simulates a closed stdin stream and a non-TTY stdin through the real prompter with fake streams and fake timers; titles carry `isTTY`, `closed stdin`, `HITL_ABORTED`, `1000` and the uid 657bd597, and the spec cites [search-hosts.19].
- [search-hosts.20] (backlog 9d05e8b2) The CLI and the MCP host report the same tripwire status: both route `tripwireStatus` through the one verb (neither src/cli.ts nor src/server.ts holds an expiry or TTL predicate of its own), and a spec under src/test/unit/hosts/ seeds a data dir with one live and one expired lock and asserts that the CLI projection and the MCP tool result list exactly the same tripped set (the expired lock in neither). Titles carry `tripwireStatus`, `expired`, `CLI`, `MCP`, `same` and the uid 9d05e8b2, and the spec cites [search-hosts.20].
- [search-hosts.21] (backlog 86ed154e) The CLI never exits 0 with empty output: every operation writes one non-empty JSON document to stdout before exit 0, and an empty or undefined verb result becomes a typed HOST_BOOT_FAILED failure with a non-zero exit (`HOST_BOOT_FAILED: <message>` on one stderr line) instead of a silent exit 0. A spec under src/test/unit/hosts/ runs three CLI runner invocations concurrently with fake verbs (one returning undefined) and asserts three stdout documents or a typed failure each; titles carry `empty`, `undefined`, `HOST_BOOT_FAILED`, `stdout`, `concurrent` and the uid 86ed154e, and the spec cites [search-hosts.21].
- [search-hosts.22] (commit 591e1a7, delta report rows 12 and 13) A closed stdin never ends in silence: with a tripped provider (reason `captcha`) and a closed stdin the CLI's gate prompt rejects (HITL_ABORTED) and the CLI maps that rejection to ONE JSON line on stdout `{ outcome: 'hitl', attempts: 0, hitl: { reason, pageUrl, provider, query } }` and exits 2 (`exitCodeFor('HITL_ABORTED')`, search-errors.7); the solved-prompt `confirmSolved` on a closed stdin rejects the same way, the verb takes its abort path and returns the hitl response (CLI exit 2, MCP `isError: true`); no path ends in exit 0 with empty stdout. A spec under src/test/unit/hosts/ runs the real CLI runner with a fake ended stdin stream and a fake verb set and asserts stdout and the exit code for both prompts. Titles carry `closed stdin`, `hitl`, `attempts`, `exit 2`, `confirmSolved`, `isError`, `HITL_ABORTED` and the uid 591e1a7, and the spec cites [search-hosts.22]; `nx run stealth-search:test -- src/test/unit/hosts` exits 0.
---

## Reservations

```text
read_only:  ["entrypoint/stealth-search/src/tracing.ts", "entrypoint/stealth-search/src/telemetry.ts"]
mutates:    ["entrypoint/stealth-search/src/server.ts", "entrypoint/stealth-search/src/cli.ts", "entrypoint/stealth-search/src/host-flags.ts", "entrypoint/stealth-search/src/host-errors.ts", "entrypoint/stealth-search/bin/", "entrypoint/stealth-search/src/test/unit/hosts/", "entrypoint/stealth-search/package.json", "pnpm-lock.yaml", "docs/plan/stealth-browser/evidence/naming-decision.md"]
```

---

## Contract Promise

Added: `src/server.ts`, `src/cli.ts`, `src/host-flags.ts`, `src/host-errors.ts`, `bin/cli.ts`, `bin/mcp.ts`, `src/test/unit/hosts/*.spec.ts`, `evidence/naming-decision.md`. Modified: `package.json` and `pnpm-lock.yaml` only for the O12 outcome. Deleted: none.

---

## Commit points

Every plan-file write is committed (R1). Work-product commits for this state, always by explicit path, always tagged `[psm:search-hosts]`:

- [ ] After the CLI host works — commit: `feat(stealth-search): cli host [psm:search-hosts]`
- [ ] After the MCP host works — commit: `feat(stealth-search): mcp host [psm:search-hosts]`
- [ ] **After the guard passes** (mandatory) — commit the work and the `state.json` update together by explicit path.

---

## Notes for executor

- Zero `process.env` in `src/` and `bin/` (ADR-0001): every former `SEARCH_*`/`SEARCH_MCP_*` toggle is a flag in the SPEC 2.3 table; the data root default is `~/.adhd/reverse/data` computed from typed config, not env.
- `search-tracing` owns `src/tracing.ts` and `src/telemetry.ts`; import `tracingPlugin` and the telemetry initializer from them. Never name the service or namespace here (`search-hosts.15`).
- No persistent Chrome: dead-port `chromeStatus` and the extraArgs rejection on port 19997 are the only process probes; the rest is in-process host specs (ADR-0009, `src/test/unit/hosts/`; `unit/verbs/` is `search-verbs`').
- Manifest and lockfile change only as the O12 outcome demands (`commander`); lock diff confined to the stealth-search importer ([inv:node-modules]).

## Backlog fold-in (2026-10-14 search bugs)

Backlog-facing: each criterion below is cited by a unit test simulating the real use case; ids are stable (appended, never renumbered).

- abeedba8 -> [search-hosts.18]: the CLI closes handles, flushes stdout and exits 0 promptly; backgrounded runs keep their output (real-process probe on a dead port, no Chrome).
- 657bd597 -> [search-hosts.19]: HITL prompts on closed or non-TTY stdin reject with `HITL_ABORTED` within 1000 ms (no new code).
- 9d05e8b2 -> [search-hosts.20]: CLI and MCP report the same tripwire status. 93dee018 is [search-port-guards.10].
- 86ed154e -> [search-hosts.21]: the CLI never exits 0 with empty output.
