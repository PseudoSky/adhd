## 0.2.5 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **apigen:** close codegen-injection review residuals (cd9a5d6c) ([9acbe746](https://github.com/PseudoSky/adhd/commit/9acbe746))
- **apigen:** harden fastify/express codegen against injection (ff1b22ad, 61ecfab8) ([de2a5948](https://github.com/PseudoSky/adhd/commit/de2a5948))
- **nx:** reconcile main's e2e lane with the flat ESLint config + fix missing-deps ([cf72a2ab](https://github.com/PseudoSky/adhd/commit/cf72a2ab))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.4 (2026-09-24)

This was a version bump only for apigen-plugin-api-fastify to align it with other projects, there were no code changes.

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

- **apigen:** wire MountHostBridge/LayerContext into express, fastify, health


### ❤️  Thank You

- pseudosky

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-plugin-api-fastify to align it with other projects, there were no code changes.

## 0.1.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-24)

This was a version bump only for apigen-plugin-api-fastify to align it with other projects, there were no code changes.

## 0.1.4 (2026-07-24)


### 🚀 Features

- **apigen-plugin-api-fastify:** migrate to TransportAdapter/OpPlan serve-core


### 🩹 Fixes

- **apigen-plugin-api-fastify:** widen Fastify() options type so build typechecks


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

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** BUG-APIGEN-024 — --use openapi mount empty paths on live run

- **apigen:** FEAT-APIGEN-022 + BUG-APIGEN-025 — auto-hoist GET by param shape, wire x-apigen-safe

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

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** BUG-APIGEN-024 — --use openapi mount empty paths on live run

- **apigen:** FEAT-APIGEN-022 + BUG-APIGEN-025 — auto-hoist GET by param shape, wire x-apigen-safe

- **environment:** correct agent-mcp plugins at: classification (build->runtime)

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky