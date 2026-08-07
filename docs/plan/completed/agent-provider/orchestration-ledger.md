# Orchestration ledger — agent-provider

Driven by `workflow:plan-orchestrator` (execute mode) in worktree
`/Users/nix/dev/node/adhd-agent-registry` (branch `agent-registry-execution`).
`$SKILL` = installed cache `…/workflow/0.8.22/skills/plan-state-machine/scripts`.
Foundation plan 3 of 7 — running in PARALLEL with agent-policy.

## Preflight (2026-06-23)

| Check | Result |
|---|---|
| `compile-task --board` | 10-state linear chain (cost 10) |
| `gap-check` | **PASS** — 0 warnings |
| `env-pin-check --strict` | exit 0 |
| human-blockers | none (`human-blockers.json` = `{}`); **lmstudio live-test gated behind `AGENT_MCP_LIVE=1`** (opt-in, normal runs skip — not a blocker) |
| F2 audit-phase membership | **CLEAN** — foundation/schema/audit/adapter/runtime/seed; seed criteria in `seed` phase, none mis-filed |
| tsconfig.base.json | `@adhd/agent-provider` **already registered** (no scaffold write needed; cross-plan flag with policy is benign) |

## Dispatch rows

| wave | slug | executor | tier | tokens | guard | retries | outcome | notes |
|---|---|---|---|---|---|---|---|---|
| 0 | scaffold-package | typescript-pro | sonnet | byte-proxy | build exit 0 + test-target exit 0 | 0 | **ADVANCE** | commit `c0b7d13` (11 files, agent-mcp/tsconfig/agent-policy untouched). **F-TR6 PREEMPTED** — vite `@nx/vite:test` target set up at scaffold (`nx test --passWithNoTests` exit 0). Clean single cycle |
| 1 | provider-and-model-schema | typescript-pro | sonnet | byte-proxy | guard exit 0 (11) | 0 | **ADVANCE** | commit `40c7973` (within reservation; agent-mcp/agent-policy/tsconfig untouched); provider_providers+provider_models tables, ProviderStore/ModelStore, close+reopen test. Clean single cycle |
| 2 | model-platform-bindings | typescript-pro | sonnet | byte-proxy | guard exit 0 (8) | 0 | **ADVANCE** | `provider_model_platform_bindings` (composite PK model_id+platform), ModelStore.createBinding/resolveModelId, migration 0001; boundary clean. Clean single cycle |
| 3 | provider-tool-formats | typescript-pro | sonnet | byte-proxy | guard exit 0 | 0 | **ADVANCE** | commit `e0fc0be`; provider_tool_formats (composite PK provider_id+canonical_tool) + ToolFormatStore; boundary clean. Clean single cycle |
| 4 | audit-schema (GATE) | orchestrator-driven | — | n/a | `--phase schema` 15/15 PASS | 0 | **ADVANCE** | verified green via python harness before completing; advanced to provider-adapter-contract |
| 5 | provider-adapter-contract | typescript-pro | sonnet | byte-proxy | guard exit 0 (4) + agent-mcp build/test exit 0 | 0 | **ADVANCE** | commit `e787ede`. **Cross-pkg additive write to agent-mcp-types** (StreamChunk + ProviderAdapter; 0 real deletions — purely additive; dep direction agent-mcp-types←agent-provider←agent-mcp avoids cycle). **agent-mcp SERVER UNTOUCHED + build/test still exit 0 (stability proven).** ProviderAdapterImpl resolves via ModelStore |
| 6 | runtime-tool-forwarding | typescript-pro | sonnet | byte-proxy | guard exit 0 (12) | 0 | **ADVANCE** | commit `fc9aaac`; emit-tools FEAT-007 (server_side→type-tagged / unsupported→throw / custom→std), UnsupportedNativeToolError; boundary clean. Clean single cycle |
| 7 | seed-and-roundtrip | typescript-pro | sonnet | byte-proxy | guard exit 0 | 0 | **ADVANCE** | commit `9eb7405`; idempotent seed + reopen + teeth; boundary clean. Clean single cycle |
| 8 | audit-schema (GATE) | orchestrator-driven | — | n/a | (auto-completed in chain) | 0 | (cleared earlier 15/15) | provider audit-schema was driven at wave 4 |
| 9 | code-review (GATE) | code-reviewer | **opus** | pending | review_gate.py | 0 | DISPATCHING | diff review of provider impl + **additive agent-mcp-types adapter change** vs CLAUDE.md + invariants |
