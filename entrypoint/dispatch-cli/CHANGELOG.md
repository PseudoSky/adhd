## 0.1.7 (2026-10-07)

### 🚀 Features

- **dispatch:** lane/grant validation, liveness heartbeats, duplicate-dispatch guard, evidence tooling (7ed25125 d794287f 65788fd8 025d3239 f613472b) ([9f556fd7](https://github.com/PseudoSky/adhd/commit/9f556fd7))
- **agent-core-provider:** merge provider representations into one registry + shared PartialBinding (d3f1f787 D-G(1)) ([eabd654c](https://github.com/PseudoSky/adhd/commit/eabd654c))

### 🩹 Fixes

- **dispatch-cli:** agents import stores no implicit claudecli provider (import-agents-claudecli) ([73fa0d69](https://github.com/PseudoSky/adhd/commit/73fa0d69))
- **dispatch-cli:** canonical ADHD_AGENT_MCP_REQUEST_TIMEOUT_MS with legacy fallback + one stderr deprecation warning (64e7ebe7) ([d8e3526f](https://github.com/PseudoSky/adhd/commit/d8e3526f))
- **agent-mcp:** assert pinned node fs launch + pinned shell, drop npm registry from srt allowlist, connectTimeoutMs type, docs (c9f0a791) ([b9ab73bc](https://github.com/PseudoSky/adhd/commit/b9ab73bc))

### ❤️ Thank You

- pseudosky

## 0.1.6 (2026-10-06)

### 🚀 Features

- **dispatch-cli,dispatch-orchestrator:** resolve native tooling at the dispatching cwd (NAT-TOOL-5) ([be70922d](https://github.com/PseudoSky/adhd/commit/be70922d))
- **dispatch-cli:** guarded live runner (turn cap + cost kill + msg-size + delegation) ([e05c6c78](https://github.com/PseudoSky/adhd/commit/e05c6c78))

### 🩹 Fixes

- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **dispatch-orchestrator,dispatch-cli:** store declarative nativeTooling, never a resolved root (rework NAT-TOOL-5 / ADR-0008 D4/D8) ([b2f4187d](https://github.com/PseudoSky/adhd/commit/b2f4187d))
- **agent-mcp:** retain legacy mcp-shell security.yaml; restore f141baad guard (NAT-TOOL-4) ([102414c6](https://github.com/PseudoSky/adhd/commit/102414c6))
- **dispatch-orchestrator,dispatch-cli:** reconcile resumed HITL task back into the DAG (48b14ec1) ([97c1bb85](https://github.com/PseudoSky/adhd/commit/97c1bb85))

### ❤️ Thank You

- pseudosky

## Unreleased


### 🩹 Fixes

- **dispatch-cli:** HITL is reachable — a sessioned `run --no-dry-run` task that calls `builtin__request_human_input` now suspends to `awaiting_input`, `dispatch-cli status` surfaces `awaitingInput: { taskId, resumeToken }`, and agent-mcp's `task_resume` completes it (03145a46)

- **dispatch-cli:** `run --no-dry-run` no longer silently re-creates a DAG-named agent that is missing — `buildProductionAgentMcpRunner` defaults to `createAgentsIfMissing:false`, so an unregistered (e.g. deleted) agent fails the run with `AGENT_NOT_FOUND` instead of dispatching under an empty/default persona (f1dbd0f2)


## 0.1.4 (2026-09-26)

### 🚀 Features

- **dispatch-cli:** --allow-fs flag threads the fail-closed fs policy allowlist ([17b3072c](https://github.com/PseudoSky/adhd/commit/17b3072c))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **dispatch:** correct stale fsOpPolicy JSDoc + scope tools-root symlink claim ([e22f481c](https://github.com/PseudoSky/adhd/commit/e22f481c))
- **nx:** restore main's load-bearing test.dependsOn the remodel silently dropped ([cff62c50](https://github.com/PseudoSky/adhd/commit/cff62c50))
- **dispatch-orchestrator:** harden fs.* containment + complete mediation ([f2990a81](https://github.com/PseudoSky/adhd/commit/f2990a81))
- **dispatch-cli:** address code-review findings — README docs + toolsRoot threading ([68f25f5d](https://github.com/PseudoSky/adhd/commit/68f25f5d))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.3 (2026-09-24)

This was a version bump only for dispatch-cli to align it with other projects, there were no code changes.

## 0.1.2 (2026-08-08)

This was a version bump only for dispatch-cli to align it with other projects, there were no code changes.

## 0.1.1 (2026-08-07)


### 🩹 Fixes

- **dispatch-cli:** compile bin/cli.ts for real npx distribution (build-bin + package.json bin)

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **dispatch-cli:** populate DispatchUnit.execution_mode/systemPrompt in calibration unit


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for dispatch-cli to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- move dispatch-cli to entrypoint, fix build infrastructure

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **dispatch:** repair paths dangled by the superseded-plan relocation

- **dispatch-cli:** exclude src/test/** from lib build so test .d.ts stop shipping (DEBT-DISPATCH-CLI-TEST-DECL-BLOAT-001)


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- move dispatch-cli to entrypoint, fix build infrastructure

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **dispatch:** repair paths dangled by the superseded-plan relocation

- **dispatch-cli:** exclude src/test/** from lib build so test .d.ts stop shipping (DEBT-DISPATCH-CLI-TEST-DECL-BLOAT-001)


### ❤️  Thank You

- pseudosky