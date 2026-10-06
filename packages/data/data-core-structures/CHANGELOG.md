## 2.3.4 (2026-10-06)

### 🚀 Features

- **data-query-engine:** v2 query model, index structures, rule-based planner ([16b0809e](https://github.com/PseudoSky/adhd/commit/16b0809e))

### 🩹 Fixes

- **data-query-engine,data-core-structures:** clear 5 test-audit findings ([ae07b40b](https://github.com/PseudoSky/adhd/commit/ae07b40b))
- **data-query-engine:** access/index/order audit fixes (range-index soundness, B+ rank O(log n), roaring bit-31, fenwick/lsm/order_by) + Big-O specs ([f214713d](https://github.com/PseudoSky/adhd/commit/f214713d))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.1 (2026-09-24)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.2.5 (2026-07-24)

This was a version bump only for data-core-structures to align it with other projects, there were no code changes.

## 2.2.4 (2026-07-24)

This was a version bump only for data-core-structures to align it with other projects, there were no code changes.

## 2.2.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **quality:** salvage completed work from session-limited agents

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)


### ❤️  Thank You

- pseudosky

## 2.2.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **quality:** salvage completed work from session-limited agents

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)


### ❤️  Thank You

- pseudosky

## 2.2.0 (2024-12-14)

This was a version bump only for data to align it with other projects, there were no code changes.

## 2.1.1 (2024-12-12)

This was a version bump only for data to align it with other projects, there were no code changes.

## 2.1.0 (2024-08-13)

This was a version bump only for data to align it with other projects, there were no code changes.

# 2.0.0 (2024-08-13)

This was a version bump only for data to align it with other projects, there were no code changes.
