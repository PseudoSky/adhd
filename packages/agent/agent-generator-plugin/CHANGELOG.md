## 0.1.3 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **agent-generator-plugin:** harden registry-package generator against shell/SQL injection ([2cfe1195](https://github.com/PseudoSky/adhd/commit/2cfe1195))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.2 (2026-09-24)

This was a version bump only for agent-generator-plugin to align it with other projects, there were no code changes.

## 0.1.1 (2026-08-08)


### 🩹 Fixes

- **project-graph:** suppress phantom @nx/js:tsc project-reference edges to workspace-base-vite-paths

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent:** retarget agent-generator-plugin's registry-package generator off dead packages/ai/*


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for agent-generator-plugin to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### ❤️  Thank You

- pseudosky