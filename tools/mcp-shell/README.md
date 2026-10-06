# mcp-shell — `server.mjs` REMOVED; `security.yaml` RETAINED

This directory holds the legacy **sonirico `mcp-shell`** policy file. Only the
authored `server.mjs` was removed; `security.yaml` stays.

## `server.mjs` — removed (NAT-TOOL-4; ADR-0008 D5/D7)

The homegrown shell MCP server (`server.mjs`) was **removed** by NAT-TOOL-4
(ADR-0008 D5/D7, 2026-10-05). Nothing in the repo references it.

`server.mjs` was the ADR-0008 **thick layer**: an `ALLOWED_COMMAND_PREFIXES` +
`BLOCKED_PATTERNS` regex catalog matched over raw command text. ADR-0008 **D5**
forbids the harness owning dangerous-command detection or command segmentation,
so it was superseded — never grown — and is now deleted.

## `security.yaml` — RETAINED (legacy sonirico `mcp-shell` policy)

`security.yaml` is **not** the removed homegrown server's config. It is the
policy file for the unrelated **sonirico `mcp-shell`** Go binary, which
machine-global agents reference through the `MCP_SHELL_SEC_CONFIG_FILE` env var.
NAT-TOOL-4 **AC6** requires it to remain: deleting it re-breaks resolved bugs
`f141baad` + `299be025`. The `f141baad` contract test
(`entrypoint/agent-mcp/src/__tests__/docs-and-config-contract.test.ts`) asserts
the canonical `tools/mcp-shell/security.yaml` exists and that every catalog
entry points `MCP_SHELL_SEC_CONFIG_FILE` at it.

The adopted set below is **separate** from this legacy policy and is unaffected
by it.

## Replacement (adopted; approved 2026-10-05)

| role | server |
|---|---|
| shell | `tumf/mcp-shell-server` — allowlisted command **NAMES as argv arrays**, never a shell string (`uvx mcp-shell-server`) |
| filesystem | `@modelcontextprotocol/server-filesystem` (`npx -y @modelcontextprotocol/server-filesystem <root>`) |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`) — wraps **BOTH** servers (ADR-0008 D7) |

`resolveNativeTooling` (`@adhd/agent-core-native-tooling`) resolves the adopted
servers against the dispatching cwd; the agent-mcp host
(`entrypoint/agent-mcp/src/defaults.ts`) consumes it at task time (ADR-0008 D4)
and provisions the matching `srt` policy (`entrypoint/agent-mcp/src/srt-policy.ts`).

Human-gated adoption record — **Approved by: pseudosky (repo owner), 2026-10-05**,
under the owner directive "Finish the project". See
`docs/decisions/0008-agent-mcp-native-tooling.md` D7.
