## 0.1.2 (2026-09-24)


### 🚀 Features

- **backlog:** INTERFACE_v2 consolidation — six-verb surface, web UI (search/stats/batch/edit), stats API (citationCount, closedAt, summary scope + window)

- **backlog:** 1.0.0 — one surface, one identity, no predecessor left behind


### 🩹 Fixes

- **apigen-base-logical:** pick union branches structurally and stop codecs claiming foreign values

- **apigen-base-logical:** discriminated-union branch selection is inert after $ref inlining

- **apigen-cli:** batch nested-input CLI/HTTP wiring, sandbox isolation leaks, morph-walk index-signature regression

- **apigen:** audit fixes — S-18/S-19/C-20/C-21/S-20, java mvn race, union-encoder envelope, lazy heavy-dep loading


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.1.1 (2026-08-07)


### 🚀 Features

- **apigen:** schema-driven worked examples for MCP tool descriptions + validation errors

- **apigen-base-logical:** fill JAVA_COLUMN codec expressions (FEAT-APIGEN-001 1/3)


### 🩹 Fixes

- **apigen-java:** mirror PYTHON_MATRIX_SCRIPT's decode+invariant-diff negative-control algorithm exactly (FEAT-APIGEN-001 review)

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.0.5 (2026-07-24)

This was a version bump only for apigen-base-logical to align it with other projects, there were no code changes.

## 0.0.4 (2026-07-24)

This was a version bump only for apigen-base-logical to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs


### ❤️  Thank You

- pseudosky