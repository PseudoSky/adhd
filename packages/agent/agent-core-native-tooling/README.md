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

## Adopted upstream servers (ADR-0008 D7 — human-gated, APPROVED)

| role | server | how it is used |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | `npx -y @modelcontextprotocol/server-filesystem <root>` |
| shell | `tumf/mcp-shell-server` (MIT) | `uvx mcp-shell-server` — allowlisted command **NAMES as argv arrays**, never a shell string |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) | wraps **both** servers: `srt <command> <args…>` |

`unbash` is **dropped**; `rust-mcp-filesystem` is **deferred** (ADR-0008 D7).

`resolveNativeTooling` wraps the `fs` and `shell` builtins with `srt` by default
(`ctx.sandbox !== false`), so the resolved command is `srt …`. A real deployment
must provision an `srt` policy (`~/.srt-settings.json`) that lets the wrapped
servers reach their own caches/registries (e.g. `~/.cache/uv` and PyPI for the
shell server). Pass `{ sandbox: false }` where no policy is provisioned; hard
enforcement then degrades to the shell argv allowlist and the fs root scoping.

**Human-gated adoption — approved.** The ADR-0008 D7 adoption above is a
human-gated decision, recorded as APPROVED:
**Approved by: pseudosky (repo owner), 2026-10-05**, under the owner directive
*"Finish the project"*. The same record is in this package's `AGENTS.md` and in
the gated live-test header
(`entrypoint/agent-mcp/src/__tests__/integration/native-tooling-adoption.e2e.test.ts`).


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
