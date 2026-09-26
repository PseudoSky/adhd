## 0.2.4 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.3 (2026-09-24)


### 🚀 Features

- **backlog:** INTERFACE_v2 consolidation — six-verb surface, web UI (search/stats/batch/edit), stats API (citationCount, closedAt, summary scope + window)


### 🩹 Fixes

- **apigen-cli:** batch nested-input CLI/HTTP wiring, sandbox isolation leaks, morph-walk index-signature regression


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.2.2 (2026-08-07)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.2.1 (2026-07-30)

This was a version bump only for apigen-plugin-batch to align it with other projects, there were no code changes.

# Changelog

## [Unreleased]

### 🚀 Features

- **apigen-plugin-batch:** initial mount plugin exposing generic N-way fan-out batch operations (`_batch/<kind>`) with controlled concurrency, error handling, and per-item timeouts

## Details

For detailed usage and API documentation, see [README.md](./README.md).
