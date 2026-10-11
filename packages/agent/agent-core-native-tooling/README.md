# @adhd/agent-core-native-tooling

Core resolver and **thin** permission matcher for the standardized, portable
native toolset (filesystem / shell / dispatch) inherited by dispatched agents.

Implements [ADR-0008](../../../docs/decisions/0008-agent-mcp-native-tooling.md)
(D2/D4/D5). CommonJS-only per `adhd ADR-0003`.

## What it owns — and what it deliberately does not

This package owns **only**:

- resolution of the builtin `fs` / `shell` / `dispatch` servers against a
  **task-time** cwd (`resolveNativeTooling`);
- the ONE canonical agent-mcp self launch config (`buildDispatchSelf`), shared by
  agent-mcp and dispatch-cli; and
- tool-**NAME** permission matching (`matchPermission`).

## Portable, multi-root filesystem scoping (ADR-0008 D4/D7/D8)

An `fs` root is a **portable hint**, never a host path — the fs analogue of the
welded-`provider` bug. `resolveFsRoots(fs, ctx)` turns hints into concrete dirs:

- a **named alias** present in `ctx.roots` (the global allowed-root map,
  alias → absolute path) wins — the operator owns the machine path;
- a **relative** hint resolves against `ctx.cwd` (the caller-supplied cwd) and
  must not escape it;
- an **absolute** hint — or a `..` escape — throws a typed
  `NativeToolingRootError` (`ABSOLUTE_ROOT_NOT_PORTABLE` /
  `ROOT_ESCAPES_CALLER_CWD`).

Each resolved root becomes one argv entry, so `{ roots: ['a', 'b'] }` at caller
cwd `/P` exposes `/P/a` and `/P/b`; `resolveFsRoots` returns that exact list so
the host can union **every** root into the per-run `srt` `allowWrite` (a second
root would otherwise be sandbox-denied). The stored definition stays
byte-identical across fires (portability).

It owns **no** command parser, **no** command segmentation, and **no**
dangerous-command catalog. Hard enforcement is delegated to the adopted servers
(`@modelcontextprotocol/server-filesystem`, `tumf/mcp-shell-server`) and
`@anthropic-ai/sandbox-runtime` (ADR-0008 D5/D7). A harness that pattern-matched
command text would be best-effort, not a security boundary.

## Default upstream servers (ADR-0008 D7 — current defaults, adoption human-approved)

These are defaults, not commitments. When a concrete problem exists the tool is chosen by researching alternatives, testing them against the problem with a measured result, and adopting the best or building in-house where the ROI justifies it (ADR-0008 D7, Amendment A1). Adopting any external tool requires human approval.

| role | server | how it is used |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | `node <pinned @modelcontextprotocol/server-filesystem bin> <root>` (exact-pinned dependency of this package, resolved by `resolveFsServerLaunch()`; never `npx`) |
| shell | `tumf/mcp-shell-server` (MIT) | `uvx --from mcp-shell-server==1.1.12 mcp-shell-server` (version-pinned) — allowlisted command **NAMES as argv arrays**, never a shell string |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) | wraps **both** servers: `srt <command> <args…>` |

`unbash` is **dropped**; `rust-mcp-filesystem` is **deferred** (ADR-0008 D7).

`resolveNativeTooling` wraps the `fs` and `shell` builtins with `srt` by default
(`ctx.sandbox !== false`), so the resolved command is `srt …`. A real deployment
must provision an `srt` policy (`~/.srt-settings.json`) that lets the wrapped
servers reach their own caches/registries (e.g. `~/.cache/uv` and PyPI for the
shell server). Pass `{ sandbox: false }` where no policy is provisioned; hard
enforcement then degrades to the shell argv allowlist and the fs root scoping.

### Shell network egress under `srt`: proxy env passthrough (0ba70e47)

`srt` confines network access by injecting `HTTP_PROXY` / `HTTPS_PROXY` /
`ALL_PROXY` / `NO_PROXY` (and lowercase twins) into the sandboxed process; only
domains in the policy's `allowedDomains` are reachable through that proxy. The
adopted `mcp-shell-server` gives each command it spawns **`PATH` only** unless
variables are named in `MCP_SHELL_CHILD_ENV_ALLOWLIST`, so without help an
allowlisted `curl https://<allowed host>` fails DNS inside the sandbox (and, with
`-s`, returns an empty result).

When the sandbox is on (`ctx.sandbox !== false`, the default) the resolved shell
server's `env` therefore carries

```
MCP_SHELL_CHILD_ENV_ALLOWLIST=HTTP_PROXY,HTTPS_PROXY,ALL_PROXY,NO_PROXY,http_proxy,https_proxy,all_proxy,no_proxy
```

(the list is exported as `SHELL_PROXY_ENV_KEYS`; the env name as
`SHELL_SERVER.envKeys.childEnvAllowlist`).

Merge rule: a value for `MCP_SHELL_CHILD_ENV_ALLOWLIST` is read from **both**
`shell.env` and the ambient `ctx.env` (both are kept; concatenated `shell.env`
first, then `ctx.env`, then the proxy variables) and is
**merged, not replaced** — your entries come first (trimmed, empties dropped),
the proxy variables are appended, and duplicates are removed, so
`FOO,HTTP_PROXY` becomes `FOO,HTTP_PROXY,HTTPS_PROXY,ALL_PROXY,NO_PROXY,…`. With
`sandbox: false` nothing is emitted (there is no injected proxy to pass through)
and a user-supplied value is passed through untouched. A custom `McpServerConfig`
`shell` replaces the builtin and is never modified.

Exposure note: any allowlisted command that prints its environment
(`printenv`; the adopted server's default policy already rejects `env` and
shells such as `sh -c …`) will now show the `srt`-injected proxy URL. That URL
is `srt`'s own per-run endpoint (`http://srt.<id>:<token>@localhost:<port>`): the
`<token>` is a credential for the sandbox's local egress proxy, scoped to that
run and to the policy's `allowedDomains`, not a host credential. Host proxy
credentials are not forwarded: inside the sandbox `srt`
overwrites any host `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` value (and the
lowercase twins) with its own, so the children only ever see the `srt` ones. This
is proven end to end by the `e2e` lane (`shell-egress.e2e.test.ts`): a credentialed
host proxy is injected and `printenv` inside the sandbox never shows it.

The same variables are what let `srt` hosts reach an allowlisted domain; a host
or domain not in the policy is still denied by `srt`, not by this setting.

**Human-gated adoption — approved.** The ADR-0008 D7 adoption above is a
human-gated decision, recorded as APPROVED:
**Approved by: pseudosky (repo owner), 2026-10-05**, under the owner directive
*"Finish the project"*. The same record is in this package's `AGENTS.md` and in
the gated live-test header
(`entrypoint/agent-mcp/src/__tests__/integration/native-tooling-adoption.e2e.test.ts`).


## Default shell allowlist (ADR-0008 D5 policy change)

When a task's `shell` member supplies **neither** `allowCommands` **nor**
`allowPatterns`, the resolver emits `DEFAULT_SHELL_ALLOW_COMMANDS` (exported from
`catalog.ts`; the single source) as the adopted server's `ALLOW_COMMANDS`, so a
bare `nativeTooling: { shell: true }` agent can do ordinary file and toolchain work
(`cat ls cp mv mkdir rm touch head tail wc sort uniq tr cut diff awk grep rg echo
printf pwd test true false basename dirname realpath stat tee chmod git npm pnpm
npx nx make tsc uv`). The list is an owner-approved policy change (069316e5):
before it, an unconfigured shell allowed nothing.

Rules:

- **Override.** Any caller-supplied `allowCommands` list — even an empty one —
  replaces it in full; the two lists are never merged. Re-state any default you
  still want.
- **`allowPatterns` suppresses it.** Supplying `allowPatterns` (with or without
  `allowCommands`) means the default is not emitted, so a pattern-only policy is
  exactly the patterns.
- **Exclusions.** Network and privilege tools — `curl`, `wget`, `ssh`, `scp`,
  `sudo`, `nc` — are deliberately absent. Egress is opt-in: an agent that needs
  `curl` lists it in `allowCommands` (and the `srt` policy's `allowedDomains`
  decides which hosts are reachable).
- **Names the server refuses are not listed.** `mcp-shell-server==1.1.12`
  rejects `sed`, `node`, `python3` (and `env`, `xargs`, `timeout`, `nice`, `sh`,
  `bash`, other interpreters, …) with *"Command rejected by default security
  policy"* even when allowlisted, so advertising them only produced commands that
  always fail. They were removed from the default after driving every entry
  through the real server; `default-shell-allowlist.e2e.test.ts` re-checks the
  whole list on every e2e run. The adopted server's default policy is not
  something this package overrides (ADR-0008 D5).

## Shell exit status (61358b6f)

The adopted server computes each command's exit status and drops it: a failing
command returns `isError: false` with whatever it printed (often nothing). The
server is neither forked nor patched, so the status is recovered with a **PATH
launcher shim**. `prepareExitShimDir({ origPath, rootDir })` builds a read-only
directory (mode 0555, keyed by a hash of the launcher and `origPath`) holding one
symlink per executable found on `origPath` to a single POSIX `sh` launcher
(`LAUNCHER_SOURCE`). When `ctx.exitShim = { dir, origPath }` is passed to
`resolveNativeTooling`, the builtin shell server's `PATH` is `<dir>:<origPath>` and
the original `PATH` rides in `ADHD_SHIM_ORIG_PATH` (named in the server's own
`MCP_SHELL_CHILD_ENV_ALLOWLIST`, merged with the proxy names, also when
`sandbox: false`). The launcher runs the real binary, forwards `TERM`/`INT`/`HUP`,
and on a non-zero exit appends one stderr line:

```
[exit status: N]
```

which the server returns as an ordinary text part; zero-exit output is
byte-identical. The orchestrator parses the trailer into a structured
`exitStatus` on `post:tool_call` and `TOOL_RESULT` (it never changes `isError`:
`grep` no-match and `diff` are not faults). Facts:

- The allowlist is still enforced only by the server; the shim is inert for any
  command the server refuses. Tool name, schema and description are unchanged.
- Never shimmed (`EXIT_SHIM_PROTECTED`): `uv`, `uvx`, `python*`, `srt`, `node`,
  `sh`, `env`, `bash`, `zsh`, `dash`, `which`, `sandbox-exec`, `bwrap`, `socat` —
  the server's own toolchain and `srt`'s helpers resolve through the same `PATH`.
  These therefore report no trailer.
- **Known gap — absolute paths.** An allowlist entry that is an absolute path
  (`/bin/ls`) bypasses `PATH` lookup, so it gets no trailer. Use bare names.
- Pipelines: each segment is shimmed independently, so an early failing segment
  prints its own trailer.
- The sentinel is plain text; a command can echo it. The engine reads it only
  from the end of the last text part of a `shell_execute` result.
- The shim directory must live outside every sandbox-writable root and be
  read-only to the sandbox (agent-mcp keeps it under its temp root and denies
  writes to it in the per-run `srt` policy).
- Retire the shim if upstream `tumf/mcp-shell-server` reports exit status itself.

Proven end to end by `shell-exit-status.e2e.test.ts` (real `srt`, real unmodified
server, real MCP client), including a negative control with the shim off `PATH`.

## Usage

```ts
import {
  resolveNativeTooling,
  resolveNativeToolingMap,
  buildDispatchSelf,
  matchPermission,
  NATIVE_SERVER_CATALOG,
} from '@adhd/agent-core-native-tooling';

// The ONE agent-mcp self launch config (default `npx -y @adhd/agent-mcp@latest`,
// overridable by `ADHD_AGENT_MCP_COMMAND`/`ADHD_AGENT_MCP_ARGS`). Hosts pass the
// result as `ctx.dispatchSelf`; never hand-build a second producer.
const dispatchSelf = buildDispatchSelf();

// Resolution is TASK-time: the stored definition never carries a resolved root.
const servers = resolveNativeTooling(
  { fs: true, shell: true, dispatch: true },
  { cwd: process.cwd(), dispatchSelf }
);
// -> [fsServer, shellServer, dispatchServer], each rooted at process.cwd()

// The keyed projection is the SAME computation, for hosts that mount an
// `mcpServers` map. Keys come only from the catalog: `fs`, `shell`, `agent-mcp`.
const byKey = resolveNativeToolingMap(
  { fs: true, shell: true, dispatch: true },
  { cwd: process.cwd(), dispatchSelf }
);
// -> { fs: fsServer, shell: shellServer, 'agent-mcp': dispatchServer }

// Rule resolution is LAST-match-wins, with `deny` terminal (ADR-0008 D5 / Q1).
// The resource is a TOOL NAME — never command text (D5): the thin gate owns no
// command parser, segmentation, or dangerous-command catalog.
matchPermission({ '*': 'ask', 'agent-mcp.*': 'allow', 'shell': 'deny' }, 'agent-mcp.task'); // 'allow'
matchPermission({ 'shell': 'deny', '*': 'allow' }, 'shell');                               // 'deny'
```

`dispatchSelf` is the **real** agent-mcp MCP server config the host loads —
never a wrapper. When it is absent, no `dispatch` server is emitted.

## Building

```bash
npx nx build agent-core-native-tooling
```

## Running unit tests

```bash
npx nx test agent-core-native-tooling
```

## Running the e2e lane

```bash
npx nx run agent-core-native-tooling:e2e
```

`src/lib/shell-egress.e2e.test.ts` (0ba70e47) drives the real `srt` plus the real
`uvx mcp-shell-server==1.1.12` through `resolveNativeTooling`'s own output and
calls `shell_execute curl` against a local HTTP server, asserting the body comes
back. It needs `srt` (workspace dependency) and `uvx` on the machine (plus
`bwrap` and `socat` on Linux) and **fails loudly rather than skipping** if any is
missing; a control test proves the
same call cannot resolve the host without the allowlist. `srt` refuses
destinations that resolve to the host itself, so the local server is wired in as
`srt`'s `network.parentProxy` rather than curled directly.

`src/lib/shell-exit-status.e2e.test.ts` (61358b6f) drives the same real `srt` +
real server through a real MCP client and asserts the `[exit status: N]` trailer
(and its negative control); `src/lib/default-shell-allowlist.e2e.test.ts` calls
every `DEFAULT_SHELL_ALLOW_COMMANDS` entry through the real server. `uvx` (and
`srt` for the exit-status suite) must be installed; both fail loudly if missing.

## Line-ending helpers

`classifyEol(text)` returns `'crlf' | 'lf' | 'mixed' | 'none'`, and
`restoreLineEndings(before, after)` re-applies a CRLF-only `before` to `after`
(any other class returns `after` unchanged). agent-mcp uses them to undo the
adopted filesystem server's CRLF-to-LF normalization (8dd148cf).
