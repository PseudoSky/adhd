## 0.1.6 (2026-10-15)

This was a version bump only for agent-plugin-sanitize to align it with other projects, there were no code changes.

## Unreleased

### 🚀 Features

- **agent-plugin-sanitize:** with `delegationOnly: false` the plugin vetoes persistence of provider server-tool result bodies through the new `transform:server_result_persist` hook, so they are replayed within the producing run only and never stored. The default (`delegationOnly: true`) registers no handler and changes nothing. README now states that server-tool results are untrusted, bypass `transform:tool_result`, and documents the opt-outs (`nativeWebTools: false`, `echo.serverResultTtlMinutes: 0`, `session_clear`). (R9-hist S5b)

## 0.1.5 (2026-10-06)

### 🩹 Fixes

- **agent-mcp:** pin wildcard externals to real ranges ([9869db26](https://github.com/PseudoSky/adhd/commit/9869db26))

### ❤️ Thank You

- pseudosky

## 0.1.3 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.2 (2026-09-24)

This was a version bump only for agent-plugin-sanitize to align it with other projects, there were no code changes.

## 0.1.1 (2026-08-12)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for agent-plugin-sanitize to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **agent:** BUG-AGENTBASE-TSC-001 — drop composite:true from agent-plugin-{budget,sanitize}


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **agent:** BUG-AGENTBASE-TSC-001 — drop composite:true from agent-plugin-{budget,sanitize}


### ❤️  Thank You

- pseudosky