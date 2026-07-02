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
