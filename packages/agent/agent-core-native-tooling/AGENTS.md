# AGENTS.md — @adhd/agent-core-native-tooling

LLM/agent-facing, factual documentation for `@adhd/agent-core-native-tooling`.
Every claim is grounded in `src/` or the ADR it implements.

## What this package is

The **core resolver** + **thin tool-name permission matcher** for the standardized,
portable native toolset (`fs` / `shell` / `dispatch`) inherited by dispatched
agents. It implements [ADR-0008](../../../docs/decisions/0008-agent-mcp-native-tooling.md)
(D2/D4/D5/D7) and publishes CommonJS-only (`adhd ADR-0003`).

Public surface (`src/index.ts`):

- `resolveNativeTooling(cfg, ctx)` — task-time resolution of the builtin servers.
- `matchPermission(ruleMap, toolName)` — thin gate: tool **NAME**, last-match-wins,
  `deny` terminal. Never parses command text.
- `NATIVE_SERVER_CATALOG`, `FS_SERVER`, `SHELL_SERVER`, `SRT_SANDBOX`,
  `wrapWithSandbox`, `DISPATCH_SERVER_KEY`.

## What it deliberately does NOT own

No command parser, no command segmentation, and no dangerous-command catalog.
Hard enforcement is **delegated** to the adopted servers and `srt` (ADR-0008 D5/D7).

## Adopted upstream servers (ADR-0008 D7)

| role | server | invocation |
|---|---|---|
| filesystem | `@modelcontextprotocol/server-filesystem` (MIT) | `npx -y @modelcontextprotocol/server-filesystem <root>` |
| shell | `tumf/mcp-shell-server` (MIT) | `uvx mcp-shell-server` — allowlisted argv, never a shell string |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`, Apache-2.0) | wraps both: `srt <command> <args…>` |

`unbash` is dropped; `rust-mcp-filesystem` is deferred. `resolveNativeTooling`
wraps the `fs`/`shell` builtins with `srt` by default (`ctx.sandbox !== false`).

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
