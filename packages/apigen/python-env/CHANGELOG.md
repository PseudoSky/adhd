## 0.2.6 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **nx:** reconcile main's e2e lane with the flat ESLint config + fix missing-deps ([cf72a2ab](https://github.com/PseudoSky/adhd/commit/cf72a2ab))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.5 (2026-09-24)

This was a version bump only for apigen-python-env to align it with other projects, there were no code changes.

## 0.2.4 (2026-08-08)


### 🩹 Fixes

- **apigen-python-env:** probe monorepo-live python source before co-located dist copy (DEBT-APIGEN-010)


### ❤️  Thank You

- pseudosky

## 0.2.3 (2026-08-07)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **apigen-python:** parent-death watchdog so Python hosts cannot outlive their spawning process (BUG-APIGEN-053)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.2.2 (2026-07-30)


### 🩹 Fixes

- **nx-build:** release-atomicity test coverage + CPU-guard flakiness + cache-input gap

- **apigen-python-env:** dist copy-plugin hardening alongside cache-input fix


### ❤️  Thank You

- pseudosky

## 0.2.1 (2026-07-27)


### 🩹 Fixes

- **apigen-python-env:** ship the `apigen_python` sources into `dist/python/` via a vite `writeBundle` copy plugin and resolve them co-located-first, so `py-grpc`/`py-flask` work for consumers installing from npm outside the monorepo (BUG-015). `project.json` `build.options.assets` was a no-op under `@nx/vite:build`.


## 0.1.5 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.4 (2026-07-24)

This was a version bump only for apigen-python-env to align it with other projects, there were no code changes.

## 0.1.3 (2026-07-24)

This was a version bump only for apigen-python-env to align it with other projects, there were no code changes.

## 0.1.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries


### ❤️  Thank You

- pseudosky

## 0.1.1 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **agent:** update stale @adhd/agent-mcp-budget, agent-mcp-sanitize, agent-mcp-types references + clean tsconfig stale entries


### ❤️  Thank You

- pseudosky