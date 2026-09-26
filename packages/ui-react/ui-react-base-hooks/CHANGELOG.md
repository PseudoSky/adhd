## 2.3.4 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **test:** make the full affected gate green (3 latent test-hermeticity fixes) ([734f756d](https://github.com/PseudoSky/adhd/commit/734f756d))
- **ui-react-base-hooks:** stop emitting Rolldown's empty import.meta token in the browser bundles ([c1af25ef](https://github.com/PseudoSky/adhd/commit/c1af25ef))
- **ui-react-base-hooks:** conform the hooks to the installed React 19 types ([213e1439](https://github.com/PseudoSky/adhd/commit/213e1439))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.3 (2026-09-24)

This was a version bump only for ui-react-base-hooks to align it with other projects, there were no code changes.

## 2.3.2 (2026-08-07)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 2.3.1 (2026-07-30)


### 🩹 Fixes

- **ui-react-base-hooks:** resolve react-hooks/exhaustive-deps warning in use-async


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 2.2.5 (2026-07-24)

This was a version bump only for ui-react-base-hooks to align it with other projects, there were no code changes.

## 2.2.4 (2026-07-24)

This was a version bump only for ui-react-base-hooks to align it with other projects, there were no code changes.

## 2.2.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **quality:** salvage completed work from session-limited agents

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **build:** generatePackageJson on data-base-transforms, data-query-engine, ui-react-base-hooks so dist package.json version syncs to source every build (was one-time !existsSync seed → stale dist version survived nx reset)


### ❤️  Thank You

- pseudosky

## 2.2.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **quality:** salvage completed work from session-limited agents

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)

- **build:** generatePackageJson on data-base-transforms, data-query-engine, ui-react-base-hooks so dist package.json version syncs to source every build (was one-time !existsSync seed → stale dist version survived nx reset)


### ❤️  Thank You

- pseudosky

## 2.2.0 (2024-12-14)

This was a version bump only for react-hooks to align it with other projects, there were no code changes.

## 2.1.1 (2024-12-12)

This was a version bump only for react-hooks to align it with other projects, there were no code changes.

## 2.1.0 (2024-08-13)

This was a version bump only for react-hooks to align it with other projects, there were no code changes.

# 2.0.0 (2024-08-13)

This was a version bump only for react-hooks to align it with other projects, there were no code changes.
