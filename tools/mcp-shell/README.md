# mcp-shell — REMOVED

The homegrown shell MCP server (`server.mjs`) and its `security.yaml` were
**removed** by NAT-TOOL-4 (ADR-0008 D5/D7, 2026-10-05). Nothing in the repo
references either file.

## Why it was removed

`server.mjs` was the ADR-0008 **thick layer**: an `ALLOWED_COMMAND_PREFIXES` +
`BLOCKED_PATTERNS` regex catalog matched over raw command text. ADR-0008 **D5**
forbids the harness owning dangerous-command detection or command segmentation,
so it was superseded — never grown — and is now deleted.

## Replacement (adopted; approved 2026-10-05)

| role | server |
|---|---|
| shell | `tumf/mcp-shell-server` — allowlisted command **NAMES as argv arrays**, never a shell string (`uvx mcp-shell-server`) |
| filesystem | `@modelcontextprotocol/server-filesystem` (`npx -y @modelcontextprotocol/server-filesystem <root>`) |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`) — wraps both servers |

`resolveNativeTooling` (`@adhd/agent-core-native-tooling`) resolves the adopted
servers against the dispatching cwd; the agent-mcp host
(`entrypoint/agent-mcp/src/defaults.ts`) consumes it at task time (ADR-0008 D4)
and provisions the matching `srt` policy (`entrypoint/agent-mcp/src/srt-policy.ts`).

Human-gated adoption record — **Approved by: pseudosky (repo owner), 2026-10-05**,
under the owner directive "Finish the project". See
`docs/decisions/0008-agent-mcp-native-tooling.md` D7.
