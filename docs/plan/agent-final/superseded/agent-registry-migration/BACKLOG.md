### MIG-PROVIDER-001 — the dispatch subsystem is a SECOND, un-migrated provider surface that must fold into the canonical provider + agent systems

**Status:** OPEN
**Plan:** agent-registry-migration

**Discovered:** 2026-07-16, while proving whether `dispatch-cli run --no-dry-run` can dispatch to DeepSeek end-to-end (it could not).

**The surface:** `@adhd/dispatch-base-spec` carries its **own** provider representation, entirely parallel to the canonical `@adhd/agent-core-provider` provider system this plan seeds (`seed-provider-registry`):
- `dispatch-base-spec/src/lib/types.ts:84` — `ProviderConfig.type` is its own 3-value union (`'anthropic' | 'openai' | 'claudecli'`), with **snake_case** fields (`model_id`, `env_secret`, `base_url`, `timeout_ms`, `retry_config`).
- agent-mcp's real `agent_create` schema (`packages/agent/agent-engine-orchestrator/src/validation/agent.ts:87-91`) accepts the **same 3 type values** but **camelCase** fields (`model`, `env.secret`, `baseURL`, `timeoutMs`, `retryConfig`).
- The canonical provider registry (`agent-core-provider/src/seed/providers.ts`) is a THIRD representation (per-provider `baseUrl`/`apiKey` rows: anthropic, openai, bedrock, lmstudio, stdio).

Three representations of "what provider/model to call," none sharing a type. DeepSeek isn't even a first-class `type` on any of them — it rides `type:'openai'` + a DeepSeek `model`/`baseURL`.

**The smell (why this is a real migration gap, not cosmetic):**
- `AgentMcpRunner.ensureAgent` (`packages/dispatch/dispatch-orchestrator/src/lib/agent-runner.ts`) originally **hardcoded `provider: { type: 'claudecli' }`** and discarded `unit.provider` entirely (DEBT-DISPATCH-019) — so the dispatcher could never route to DeepSeek (or any configured provider) regardless of the dag. A stop-gap `toAgentMcpProviderConfig()` translation was added 2026-07-16 to bridge the snake_case→camelCase gap **(committed UNVERIFIED — no build/test/live run)**. An ad-hoc hand-maintained translation between two type systems is exactly what a migration to one system eliminates.

**Migration direction (proposed — needs planner + human scope call):**
1. The dispatcher should reference the **canonical provider registry by id/ref** (an `agent-core-provider` provider row + model), not carry its own `ProviderConfig`. `dag.providers.<tier>` becomes a registry reference, not a duplicated struct.
2. Agent creation from a dispatch unit should flow through the **registry-backed agent system** (the same path agent definitions migrate onto in this plan), so the dispatcher inherits provider/model/secret resolution instead of re-implementing it.
3. Retire `dispatch-base-spec`'s parallel `ProviderConfig` type union and the `toAgentMcpProviderConfig` translation once (1)/(2) land.

**Scope question for the planner:** this plan already seeds the provider registry (`seed-provider-registry`) but stops at the agent-definition boundary. Migrating the **dispatch consumer** onto that registry is adjacent and larger — decide: extend this plan with a `dispatch-provider-migration` state, or spin a dedicated follow-on plan that depends on this one + `dispatch-completion`. Either way, `dispatch-completion`'s own DoD should NOT claim "DeepSeek via dispatcher works" until this surface is reconciled and the routing fix is verified live.

**Status:** OPEN — architectural migration surface, unowned by any state today. Blocks a truthful "dispatcher dispatches to any registry provider" guarantee.
