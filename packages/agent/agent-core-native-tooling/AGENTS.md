# AGENTS.md — @adhd/agent-core-native-tooling

LLM/agent-facing, factual documentation for `@adhd/agent-core-native-tooling`.
Every claim is grounded in `src/` or the ADR it implements.

## What this package is

The **core resolver** + **thin tool-name permission matcher** for the standardized,
portable native toolset (`fs` / `shell` / `dispatch`) inherited by dispatched
agents. It implements [ADR-0008](../../../docs/decisions/0008-agent-mcp-native-tooling.md)
(D2/D4/D5/D7) and publishes CommonJS-only (`adhd ADR-0003`).

Public surface (`src/index.ts`):

- `resolveNativeTooling(cfg, ctx)` — task-time resolution of the builtin servers
  (array form).
- `resolveNativeToolingMap(cfg, ctx)` — the keyed projection of the SAME
  computation: `mcpServers` keys come only from the catalog (`fs`/`shell`/
  `agent-mcp`), so no host authors a divergent key. One producer, two
  projections.
- `matchPermission(ruleMap, toolName)` — thin gate: tool **NAME**, last-match-wins,
  `deny` terminal. Never parses command text.
- `resolveFsRoots(fs, ctx)` — the ONE producer of the resolved `fs` root list. Turns
  a definition's **portable hints** into concrete dirs: a named alias into
  `ctx.roots` (the global allowed-root map, alias → absolute path) wins; a relative
  hint resolves against `ctx.cwd` and must not escape it; an **absolute** hint
  (or a `..` escape) throws a typed `NativeToolingRootError`
  (`ABSOLUTE_ROOT_NOT_PORTABLE` / `ROOT_ESCAPES_CALLER_CWD`). The host unions this
  exact list into the per-run `srt` policy (AC6), so a second root is not
  sandbox-denied.
- `NativeResolveContext.cwd` is the task-time caller cwd; `cwdSource` flags
  `'caller'` vs `'host-fallback'`; `roots` is the global alias→path map.
- `buildDispatchSelf(env?)` — the ONE canonical agent-mcp self launch config
  (default argv `DISPATCH_SELF_DEFAULT_ARGS`, env pair
  `ADHD_AGENT_MCP_COMMAND`/`ADHD_AGENT_MCP_ARGS`; the legacy
  `ADHD_DISPATCH_AGENT_MCP_COMMAND`/`_ARGS` names are honoured as a one-release
  fallback — canonical wins), shared by agent-mcp and dispatch-cli, so no host
  authors a second self config.
- `NativeResolveContext.srtSettingsPath` — when set, the resolver emits
  `srt -s <path> …` for the builtins, letting the host hand each spawn its own
  per-run policy file (finding 535c1101 / A4) instead of the shared global one.
- `NATIVE_SERVER_CATALOG`, `FS_SERVER`, `SHELL_SERVER`, `SRT_SANDBOX`,
  `wrapWithSandbox`, `DISPATCH_SERVER_KEY`, `DISPATCH_SELF_DEFAULT_ARGS`.

## What it deliberately does NOT own

No command parser, no command segmentation, and no dangerous-command catalog.
Hard enforcement is **delegated** to the adopted servers and `srt` (ADR-0008 D5/D7).

## Default upstream servers (ADR-0008 D7)

The catalog entries are defaults, not commitments. For a concrete problem: research alternatives, test them against it with a measured result, then adopt the best or build in-house when ROI justifies it, and record the evaluation (ADR-0008 D7, Amendment A1). Adopting an external tool requires human approval.

| role | server | invocation |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | `node <pinned @modelcontextprotocol/server-filesystem bin> <root>` (exact-pinned dependency of this package, resolved by `resolveFsServerLaunch()`; never `npx`) |
| shell | `tumf/mcp-shell-server` (MIT) | `uvx --from mcp-shell-server==1.1.12 mcp-shell-server` (version-pinned) — allowlisted argv, never a shell string |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) | wraps both: `srt <command> <args…>` |

`unbash` is dropped; `rust-mcp-filesystem` is deferred. `resolveNativeTooling`
wraps the `fs`/`shell` builtins with `srt` by default (`ctx.sandbox !== false`). With the sandbox on, the shell server env also carries `MCP_SHELL_CHILD_ENV_ALLOWLIST` naming the `srt`-injected proxy variables (`SHELL_PROXY_ENV_KEYS`), merged with any user value, so allowlisted egress works (0ba70e47; see README).

Verified against the adopted servers: the shell server's tool is `shell_execute`
(arg `command: string[]`), and its allow-list env is `ALLOW_COMMANDS` /
`ALLOWED_COMMANDS` / `ALLOW_PATTERNS` — it has **no** deny-list env.

## Human-gated adoption (ADR-0008 D7 / NAT-TOOL-8) — APPROVED

- **Approved by:** pseudosky (repo owner)
- **Date:** 2026-10-05
- **Directive:** "Finish the project" (the owner's recorded approval for these
  third-party adoptions)
- **Adopted set:** `@modelcontextprotocol/server-filesystem`,
  `tumf/mcp-shell-server`, `@anthropic-ai/sandbox-runtime` (wraps both).

The same record is in this package's `README.md`, and the gated live test that
exercises the adopted shell server through the real `agent_verify_mcp` handshake
carries it in its header:
`entrypoint/agent-mcp/src/__tests__/integration/native-tooling-adoption.e2e.test.ts`.

## Building / testing

```bash
npx nx build agent-core-native-tooling
npx nx test agent-core-native-tooling
```
