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