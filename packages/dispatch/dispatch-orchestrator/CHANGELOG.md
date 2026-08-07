## 0.1.0 (unreleased)


### 🩹 Fixes

- **DEBT-DISPATCH-017:** never split a multi-byte UTF-8 character at the 8KB guard-output cap. `capOutput` now backs the cut index off from continuation bytes (`0x80`–`0xBF`) to land on a character boundary, preventing replacement glyphs in truncated output.

- **DEBT-DISPATCH-019:** thread real provider type into `dispatch_log` telemetry. The `provider` field in `DispatchLogEntry` now receives the actual `unit.provider?.type` (e.g., `'claudecli'`, `'anthropic'`, `'openai'`) instead of a hardcoded literal, improving accuracy of telemetry. Defaults to `'claudecli'` (not `'anthropic'`) when no provider was configured, matching the actual `AgentMcpRunner.ensureAgent` default.

## 0.0.5 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for dispatch-orchestrator to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **dispatch-orchestrator:** AgentMcpRunner + MockAgentRunner (agent-runner)

- **dispatch-orchestrator:** orchestrateCycle/orchestrate minimal loop (orchestrator-core)

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **dispatch:** repair paths dangled by the superseded-plan relocation


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **dispatch-orchestrator:** AgentMcpRunner + MockAgentRunner (agent-runner)

- **dispatch-orchestrator:** orchestrateCycle/orchestrate minimal loop (orchestrator-core)

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **dispatch:** repair paths dangled by the superseded-plan relocation


### ❤️  Thank You

- pseudosky