## 0.3.0 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- ⚠️  **apigen:** regenerate the ADR-0004 golden snapshot, add the MAJOR release note, clear the format gate ([1fea3c2f](https://github.com/PseudoSky/adhd/commit/1fea3c2f))
- **apigen:** rebase onto main — flip [BUG-APIGEN-059] to ADR-0004 semantics ([a8009900](https://github.com/PseudoSky/adhd/commit/a8009900))
- **apigen:** ADR-0004 — MCP tool output is the flat content payload ([7896594d](https://github.com/PseudoSky/adhd/commit/7896594d))
- **apigen-plugin-mcp:** remediate NO-GO review of run() lifecycle (HIGH-1..4, LOW-a/b/c) ([14685c1b](https://github.com/PseudoSky/adhd/commit/14685c1b))
- **apigen-plugin-mcp:** settle run() without a signal, surface HTTP bind failures, memoize listTools ([7a147817](https://github.com/PseudoSky/adhd/commit/7a147817))
- **nx:** reconcile main's e2e lane with the flat ESLint config + fix missing-deps ([cf72a2ab](https://github.com/PseudoSky/adhd/commit/cf72a2ab))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ⚠️  Breaking Changes

- **apigen:** regenerate the ADR-0004 golden snapshot, add the MAJOR release note, clear the format gate  ([1fea3c2f](https://github.com/PseudoSky/adhd/commit/1fea3c2f))
  McpOutputAdapter.wrapped (exported from
  @adhd/apigen-engine-runtime and @adhd/apigen-plugin-mcp) kept its name but
  inverted its meaning (true now means "the return is already a top-level object,
  emit the value as flat structuredContent", not "wrapped under result"), and an
  MCP tool return that is not a top-level object no longer emits an outputSchema
  or structuredContent. This is semver-MAJOR for those two packages; republish
  them first per ADR-0004 D6.

### ❤️ Thank You

- pseudosky

## 0.2.4 (2026-09-24)


### 🚀 Features

- **backlog:** INTERFACE_v2 consolidation — six-verb surface, web UI (search/stats/batch/edit), stats API (citationCount, closedAt, summary scope + window)


### 🩹 Fixes

- **backlog:** unblock backlog:build — author/reporter TS2339 + wire MCP identity


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.2.3 (2026-08-07)


### 🚀 Features

- **apigen:** schema-driven worked examples for MCP tool descriptions + validation errors


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.2.2 (2026-07-30)


### 🚀 Features

- **apigen:** generic batch/bulk fan-out operations (FEAT-APIGEN-BULK-OPS-001)


### ❤️  Thank You

- pseudosky

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-plugin-mcp to align it with other projects, there were no code changes.

## 0.1.6 (2026-07-25)


### 🩹 Fixes

- **apigen,backlog:** killable serve, configurable namespace, flaky test + log spam


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-24)

This was a version bump only for apigen-plugin-mcp to align it with other projects, there were no code changes.

## 0.1.4 (2026-07-24)


### 🩹 Fixes

- **apigen-plugin-mcp:** compose validate-layer + migrate to TransportAdapter (BUG-APIGEN-SERVE-CORE-001)


### ❤️  Thank You

- pseudosky

## 0.1.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining @adhd/apigen-runtime refs → apigen-engine-runtime

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** BUG-APIGEN-017/018/019/020 — MCP tool-schema hardening bundle

- **environment:** correct agent-mcp plugins at: classification (build->runtime)

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining @adhd/apigen-runtime refs → apigen-engine-runtime

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** BUG-APIGEN-017/018/019/020 — MCP tool-schema hardening bundle

- **environment:** correct agent-mcp plugins at: classification (build->runtime)

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky