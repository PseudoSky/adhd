## 0.1.4 (2026-09-26)

### 🚀 Features

- **dispatch-orchestrator:** fail-closed permission gate for fs.* tool-call ops + fs.edit executor ([429fdcc7](https://github.com/PseudoSky/adhd/commit/429fdcc7))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **dispatch:** correct stale fsOpPolicy JSDoc + scope tools-root symlink claim ([e22f481c](https://github.com/PseudoSky/adhd/commit/e22f481c))
- **dispatch-orchestrator:** harden fs.* containment + complete mediation ([f2990a81](https://github.com/PseudoSky/adhd/commit/f2990a81))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.3 (2026-09-24)

This was a version bump only for dispatch-orchestrator to align it with other projects, there were no code changes.

## 0.1.2 (2026-08-08)


### 🩹 Fixes

- **dispatch:** D-07 own-status eligibility guard (DEBT-DISPATCH-013) + formalize ICalibrationStore (DEBT-DISPATCH-018, BL-103)


### ❤️  Thank You

- pseudosky

## 0.1.1 (2026-08-07)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

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