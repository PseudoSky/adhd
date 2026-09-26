## 0.1.6 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **environment-cli:** default-import yaml so emitted ESM loads, and gate it ([9c019234](https://github.com/PseudoSky/adhd/commit/9c019234))
- **environment-builder:** default-import yaml so ESM bundles load ([04cdf6c2](https://github.com/PseudoSky/adhd/commit/04cdf6c2))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.5 (2026-09-24)

This was a version bump only for environment-builder to align it with other projects, there were no code changes.

## 0.1.4 (2026-08-12)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.1.3 (2026-07-30)

This was a version bump only for environment-builder to align it with other projects, there were no code changes.

## 0.1.2 (2026-07-28)

This was a version bump only for environment-builder to align it with other projects, there were no code changes.

## 0.1.1 (2026-07-28)

This was a version bump only for environment-builder to align it with other projects, there were no code changes.

## 0.0.5 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for environment-builder to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **environment:** restore cross-language equivalence; stop persisting plaintext secrets

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **environment:** restore cross-language equivalence; stop persisting plaintext secrets

- **nx:** wire test targets into all 15 projects whose specs could never run (BUG-NXTEST-001)


### ❤️  Thank You

- pseudosky