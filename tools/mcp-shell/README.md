# mcp-shell (DEPRECATED — retired fallback)

Runtime MCP server that restricts shell commands to a prefix allowlist plus a
regex blocklist. **NOT an Nx plugin.**

## Status: retired fallback (ADR-0008 D5/D7, NAT-TOOL-8)

This is the homegrown **thick layer** — an `ALLOWED_COMMAND_PREFIXES` +
`BLOCKED_PATTERNS` regex catalog matched over raw command text. ADR-0008 **D5**
forbids the harness owning dangerous-command detection or command segmentation,
so this server is **superseded** and must not be grown or wired into new code.

**Replacement (adopted, approved 2026-10-05):**

| role | server |
|---|---|
| shell | `tumf/mcp-shell-server` — allowlisted command **NAMES as argv arrays**, never a shell string (`uvx mcp-shell-server`) |
| OS enforcement | `@anthropic-ai/sandbox-runtime` (`srt`) — wraps the shell server |

`resolveNativeTooling` (`@adhd/agent-core-native-tooling`) resolves the adopted
server; `tools/mcp-shell/server.mjs` and `security.yaml` remain **only** as an
explicit fallback for hosts not yet rewired to the resolver. Its permanent
removal is owned by **NAT-TOOL-4** (which replaces `buildDefaultMcpServers` with
`resolveNativeTooling`). `ADHD_AGENT_SHELL_MCP_PATH` selects the fallback path.

Human-gated adoption record — **Approved by: pseudosky (repo owner), 2026-10-05**,
under the owner directive "Finish the project". See
`docs/decisions/0008-agent-mcp-native-tooling.md` D7.
