## 2.3.10 (2026-10-06)

### 🩹 Fixes

- **data-query-engine:** make canon iterative so deep queries cannot overflow the stack (dqe-canonical-b7d4) ([80054103](https://github.com/PseudoSky/adhd/commit/80054103))

### ❤️ Thank You

- pseudosky

## 2.3.9 (2026-10-06)

### 🚀 Features

- **data-query-engine:** fluent `.scan(...)` builder; no `_window` token survives ([6099196c](https://github.com/PseudoSky/adhd/commit/6099196c))
- ⚠️  **data-query-engine:** implement `_scan` (fold-mode) and retire `_window` ([baffd556](https://github.com/PseudoSky/adhd/commit/baffd556))
- **data-query-engine:** fluent rollup()/cube() and complete fluent surface ([cd44a542](https://github.com/PseudoSky/adhd/commit/cd44a542))
- **data-query-engine:** v2 query model, index structures, rule-based planner ([16b0809e](https://github.com/PseudoSky/adhd/commit/16b0809e))

### 🩹 Fixes

- **data-query-engine,data-core-structures:** clear 5 test-audit findings ([ae07b40b](https://github.com/PseudoSky/adhd/commit/ae07b40b))
- **data-query-engine:** clear all open query-engine findings ([ec2f266c](https://github.com/PseudoSky/adhd/commit/ec2f266c))
- **data-query-engine:** access/index/order audit fixes (range-index soundness, B+ rank O(log n), roaring bit-31, fenwick/lsm/order_by) + Big-O specs ([f214713d](https://github.com/PseudoSky/adhd/commit/f214713d))

### 🔥 Performance

- **data-query-engine:** O(partition) window fast path (prefix sums + monotonic deque) — resolves unbounded-frame O(n^2) ([a661d8e5](https://github.com/PseudoSky/adhd/commit/a661d8e5))

### ⚠️  Breaking Changes

- **data-query-engine:** implement `_scan` (fold-mode) and retire `_window`  ([baffd556](https://github.com/PseudoSky/adhd/commit/baffd556))

### ❤️ Thank You

- pseudosky

## 2.3.8 (2026-10-04)

### 🔥 Performance

- **data-query-engine:** skip no-op sort when order_by is absent/empty (defect 24948077) ([fff48630](https://github.com/PseudoSky/adhd/commit/fff48630))

### ❤️ Thank You

- pseudosky

## 2.3.7 (2026-10-03)

### 🚀 Features

- **data-query-engine:** select projection, nested group-by, path-notation parity, date-range ops (SPEC 49a62647) ([e720ce9b](https://github.com/PseudoSky/adhd/commit/e720ce9b))
- **data-query-engine:** group_by/aggregate/having + window/output/top_n (SPEC 49a62647) ([afe3fdec](https://github.com/PseudoSky/adhd/commit/afe3fdec))

### 🔥 Performance

- **data-query-engine:** hoist parseOrderBy out of the order_by comparator ([79438073](https://github.com/PseudoSky/adhd/commit/79438073))

### ❤️ Thank You

- pseudosky

## 2.3.5 (2026-10-03)

### 🚀 Features

- **data-query-engine:** ISO-8601 duration period filtering via the _period operator ([a2e69dd6](https://github.com/PseudoSky/adhd/commit/a2e69dd6))

### ❤️ Thank You

- pseudosky

## 2.3.4 (2026-09-30)

### 🩹 Fixes

- **data-query-engine:** re-export expression types and materialise empty/absent where ([b9512c7e](https://github.com/PseudoSky/adhd/commit/b9512c7e))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/\* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

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

### ❤️ Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.2.4 (2026-07-24)

This was a version bump only for data-query-engine to align it with other projects, there were no code changes.

## 2.2.3 (2026-07-23)

### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **quality:** salvage completed work from session-limited agents

- **lint:** data-query-engine parser.ts — no-explicit-any straggler (LINT-ANY-001)

- **data-query-engine:** repair QueryType contract broken by any->unknown sweep (BUILD-ANY-001)

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **build:** generatePackageJson on data-base-transforms, data-query-engine, ui-react-base-hooks so dist package.json version syncs to source every build (was one-time !existsSync seed → stale dist version survived nx reset)

### ❤️ Thank You

- pseudosky

## 2.2.2 (2026-07-23)

### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **quality:** salvage completed work from session-limited agents

- **lint:** data-query-engine parser.ts — no-explicit-any straggler (LINT-ANY-001)

- **data-query-engine:** repair QueryType contract broken by any->unknown sweep (BUILD-ANY-001)

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **build:** generatePackageJson on data-base-transforms, data-query-engine, ui-react-base-hooks so dist package.json version syncs to source every build (was one-time !existsSync seed → stale dist version survived nx reset)

### ❤️ Thank You

- pseudosky

## 2.2.0 (2024-12-14)

This was a version bump only for query to align it with other projects, there were no code changes.

## 2.1.1 (2024-12-12)

This was a version bump only for query to align it with other projects, there were no code changes.

## 2.1.0 (2024-08-13)

This was a version bump only for query to align it with other projects, there were no code changes.

# 2.0.0 (2024-08-13)

This was a version bump only for query to align it with other projects, there were no code changes.
