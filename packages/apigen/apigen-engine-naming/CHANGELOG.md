## 0.2.4 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **apigen-engine-naming:** close review doc/lint residuals ([c7c9fd45](https://github.com/PseudoSky/adhd/commit/c7c9fd45))
- **apigen:** close codegen-injection review residuals (cd9a5d6c) ([9acbe746](https://github.com/PseudoSky/adhd/commit/9acbe746))
- **apigen:** harden fastify/express codegen against injection (ff1b22ad, 61ecfab8) ([de2a5948](https://github.com/PseudoSky/adhd/commit/de2a5948))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.3 (2026-09-24)

This was a version bump only for apigen-engine-naming to align it with other projects, there were no code changes.

## 0.2.2 (2026-08-07)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-engine-naming to align it with other projects, there were no code changes.

## 0.1.5 (2026-07-25)


### 🩹 Fixes

- **apigen,backlog:** killable serve, configurable namespace, flaky test + log spam


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.4 (2026-07-24)

This was a version bump only for apigen-engine-naming to align it with other projects, there were no code changes.

## 0.1.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** FEAT-APIGEN-022 + BUG-APIGEN-025 — auto-hoist GET by param shape, wire x-apigen-safe

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen-engine-runtime:** BUG-APIGEN-030 — register x-apigen-* / discriminator as known Ajv keywords

- **apigen:** FEAT-APIGEN-022 + BUG-APIGEN-025 — auto-hoist GET by param shape, wire x-apigen-safe

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky