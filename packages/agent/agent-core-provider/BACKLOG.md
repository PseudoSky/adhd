# agent-provider — BACKLOG

Gaps surfaced at the DoD re-assessment (2026-06-24). DoD dod.1-6 met + audit-proven
(33/33); these are deferrals beyond the scoped foundation, accepted by the user with the
explicit condition that **the initiative is not complete until they are covered**.

- **NB-1 — `ProviderAdapter` is contract-only (not wired).** The interface (in
  `@adhd/agent-mcp-types`) + thin impl exist and are unit-tested, but `@adhd/agent-mcp` does
  NOT consume it yet (zero refs in agent-mcp/src). The "provider-agnostic runtime" value is a
  defined seam, not a live path. **Closure path: agent-mcp-refactor** (plan 6) wires agent-mcp
  to the adapter. Track there.
- **NB-2 — No live-model end-to-end test (project standard #5).** The adapter's `stream()` and
  the tool emitter are proven in unit tests, not against a real provider/model through the real
  loop. Add an `AGENT_MCP_LIVE`-gated test (lmstudio/claudecli) driving the adapter end-to-end.
- **NB-3 — Lint debt.** 2 `no-non-null-assertion` warnings + 1 unused-dep (`@nx/dependency-checks`).
  Minor; sweep with the cross-package lint pass.

---

## Revalidation (2026-07-04) — all items verified against current source

| Item | Status | Notes |
|------|--------|-------|
| NB-1 — ProviderAdapter not wired | **STILL OPEN** | `ProviderAdapter` defined in `packages/agent/agent-base-types/src/domain.ts:323`, implemented in `agent-core-provider/src/adapter/provider-adapter.ts`. Zero references from `entrypoint/agent-mcp/src/` or `agent-engine-orchestrator/src/`. The seam is defined + unit-tested but consumed by nothing. |
| NB-2 — No live-model e2e test | **STILL OPEN** | Zero `AGENT_MCP_LIVE` matches in package. `stream()` is an intentional stub (yields resolved model name, not LLM output). Source comment: "Wiring into the live provider is agent-mcp-refactor's job (plan 6)." |
| NB-3 — Lint debt | **PARTIALLY RESOLVED** | 2 `no-non-null-assertion` warnings remain at `packages/agent/agent-core-provider/src/__tests__/tool-format-store.test.ts:198-199`. The unused-dep (`tslib`) is now handled by `eslintrc.json` `ignoredDependencies: ["tslib"]` — no eslint output for dep checks. |
