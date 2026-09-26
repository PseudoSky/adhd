## 0.3.0 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- ⚠️  **apigen:** regenerate the ADR-0004 golden snapshot, add the MAJOR release note, clear the format gate ([1fea3c2f](https://github.com/PseudoSky/adhd/commit/1fea3c2f))
- **apigen:** rebase onto main — flip [BUG-APIGEN-059] to ADR-0004 semantics ([a8009900](https://github.com/PseudoSky/adhd/commit/a8009900))
- **apigen:** ADR-0004 — MCP tool output is the flat content payload ([7896594d](https://github.com/PseudoSky/adhd/commit/7896594d))
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

- **apigen:** let a CLI host derive its process exit code from the result

- **backlog:** INTERFACE_v2 consolidation — six-verb surface, web UI (search/stats/batch/edit), stats API (citationCount, closedAt, summary scope + window)


### 🩹 Fixes

- **apigen:** accept camelCase flag spellings as aliases in the flag table

- **apigen-cli:** batch nested-input CLI/HTTP wiring, sandbox isolation leaks, morph-walk index-signature regression

- **apigen:** audit fixes — S-18/S-19/C-20/C-21/S-20, java mvn race, union-encoder envelope, lazy heavy-dep loading


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.2.3 (2026-08-07)


### 🚀 Features

- **apigen:** schema-driven worked examples for MCP tool descriptions + validation errors


### 🩹 Fixes

- **apigen-engine-runtime:** stop parity-harness from mutating the real repo (BUG-APIGEN-052)

- **apigen-engine-runtime:** isolated-git.spec.ts's own fixture helper can corrupt the enclosing repo under real hook env (BUG-APIGEN-052 follow-up)

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **apigen-engine-runtime:** delegate vgit() to runGit() in isolated-git.spec.ts (BUG-APIGEN-054)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.2.2 (2026-07-30)


### 🚀 Features

- **apigen:** generic batch/bulk fan-out operations (FEAT-APIGEN-BULK-OPS-001)


### 🩹 Fixes

- **apigen:** schema extraction required-array + CLI mount/discriminated-union gaps


### ❤️  Thank You

- pseudosky

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-engine-runtime to align it with other projects, there were no code changes.

## 0.1.6 (2026-07-27)


### 🚀 Features

- **apigen-engine-runtime:** batch/bulk fan-out execution — `invokeBatch()` with concurrency control, per-item timeouts, and error semantics


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.4 (2026-07-24)

This was a version bump only for apigen-engine-runtime to align it with other projects, there were no code changes.

## 0.1.3 (2026-07-24)


### 🚀 Features

- **apigen-engine-runtime:** add serve-core OpPlan + TransportAdapter + createPackageInvoker + dispatchForPlan


### 🩹 Fixes

- **apigen:** guarantee py-flask/py-grpc test subprocess teardown


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** repair unterminated string literals from sed, fix apigen-core-client deps

- **apigen-core-client:** follow re-exports in extract()/extractClasses()

- **apigen-engine-runtime:** stop pre-commit --fix from deleting ajv/ajv-formats

- **apigen:** dangling $ref crash (BUG-APIGEN-026) and undefined-optional-param crash (BUG-APIGEN-027)

- **apigen:** BUG-APIGEN-036 — named-type-param.spec.ts still called deleted v1 generateSchemas()

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** BUG-APIGEN-017/018/019/020 — MCP tool-schema hardening bundle

- **apigen:** FEAT-APIGEN-022 + BUG-APIGEN-025 — auto-hoist GET by param shape, wire x-apigen-safe

- **apigen:** BUG-APIGEN-033 — anonymous default-export functions crash at dispatch instead of dispatching

- **apigen-core-client:** BUG-APIGEN-029 — hoist nested definitions so complex/self-referential type $refs resolve at dispatch time

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.1 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** repair unterminated string literals from sed, fix apigen-core-client deps

- **apigen-core-client:** follow re-exports in extract()/extractClasses()

- **apigen-engine-runtime:** stop pre-commit --fix from deleting ajv/ajv-formats

- **apigen:** dangling $ref crash (BUG-APIGEN-026) and undefined-optional-param crash (BUG-APIGEN-027)

- **apigen:** BUG-APIGEN-036 — named-type-param.spec.ts still called deleted v1 generateSchemas()

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** BUG-APIGEN-017/018/019/020 — MCP tool-schema hardening bundle

- **apigen:** FEAT-APIGEN-022 + BUG-APIGEN-025 — auto-hoist GET by param shape, wire x-apigen-safe

- **apigen:** BUG-APIGEN-033 — anonymous default-export functions crash at dispatch instead of dispatching

- **apigen-core-client:** BUG-APIGEN-029 — hoist nested definitions so complex/self-referential type $refs resolve at dispatch time

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky