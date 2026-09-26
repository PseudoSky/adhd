## 0.2.4 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.3 (2026-09-24)


### 🩹 Fixes

- **apigen-engine-conformance:** cache the conformance target keyed on Java source + pom.xml

- **apigen:** audit fixes — S-18/S-19/C-20/C-21/S-20, java mvn race, union-encoder envelope, lazy heavy-dep loading


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.2.2 (2026-08-08)


### 🚀 Features

- **apigen-engine-conformance:** wire live Java host into the conformance gate (FEAT-APIGEN-001 1/3)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **apigen-engine-conformance:** resolve gate.ts workspace root via import.meta.url, not __dirname/cwd


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.1.4 (2026-07-24)


### 🩹 Fixes

- **backlog:** resolve cross-file duplicate human-ids blocking cut-over parity


### ❤️  Thank You

- pseudosky

## 0.1.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** complete FEAT-APIGEN-022 test coverage — primitive→GET + complex→POST

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** complete FEAT-APIGEN-022 test coverage — primitive→GET + complex→POST

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky