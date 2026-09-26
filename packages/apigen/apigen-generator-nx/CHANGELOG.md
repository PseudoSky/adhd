## 0.1.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.1 (2026-09-24)


### 🩹 Fixes

- **project-graph:** suppress phantom @nx/js:tsc project-reference edges to workspace-base-vite-paths

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.0.4 (2026-07-24)

This was a version bump only for apigen-generator-nx to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** repair unterminated string literals from sed, fix apigen-core-client deps

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** repair unterminated string literals from sed, fix apigen-core-client deps

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)


### ❤️  Thank You

- pseudosky