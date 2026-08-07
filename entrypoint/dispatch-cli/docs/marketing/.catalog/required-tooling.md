# Required Tooling: dispatch-cli

## Tools Used (all available)

| Tool | Version | Purpose |
|------|---------|---------|
| `node` | v24.11.1 | Runtime |
| `npx` | bundled with node | Running tsx, nx, npm queries |
| `npx tsx` | — | Running TypeScript files directly (CLI, tests) |
| `npx nx` | — | Build system (test, build, generate-cli, lint, etc.) |
| `npx gitnexus` | — | Code intelligence (query, context, process) |
| `vitest` (via nx) | v1.6.1 | Test runner |
| `npm` (registry queries) | — | Check published npm packages |
| `git` | — | Version control (rev-parse, remote, log) |

## Missing Tools (none)

All verification for the dispatch-cli scope was completed with available tools. No capabilities are `🔴 UNVERIFIED` due to missing tooling.

## Potential Future Needs

| Tool | Use Case | Priority |
|------|----------|----------|
| A real model/LLM provider | Run `calibrate --model-tier Haiku` and `run --no-dry-run` end-to-end with a real `AgentMcpRunner` | Optional — paid boundary verification |
| `claude` CLI | `DISPATCH_E2E_LIVE=1` scenario (real agent-mcp dispatch) | Optional — paid scenario |
