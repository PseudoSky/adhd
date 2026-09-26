## 0.1.4 (2026-09-26)

### 🚀 Features

- **dispatch-cli:** --allow-fs flag threads the fail-closed fs policy allowlist ([17b3072c](https://github.com/PseudoSky/adhd/commit/17b3072c))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **dispatch:** correct stale fsOpPolicy JSDoc + scope tools-root symlink claim ([e22f481c](https://github.com/PseudoSky/adhd/commit/e22f481c))
- **nx:** restore main's load-bearing test.dependsOn the remodel silently dropped ([cff62c50](https://github.com/PseudoSky/adhd/commit/cff62c50))
- **dispatch-orchestrator:** harden fs.* containment + complete mediation ([f2990a81](https://github.com/PseudoSky/adhd/commit/f2990a81))
- **dispatch-cli:** address code-review findings — README docs + toolsRoot threading ([68f25f5d](https://github.com/PseudoSky/adhd/commit/68f25f5d))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.3 (2026-09-24)

This was a version bump only for dispatch-cli to align it with other projects, there were no code changes.

## 0.1.2 (2026-08-08)

This was a version bump only for dispatch-cli to align it with other projects, there were no code changes.

## 0.1.1 (2026-08-07)


### 🩹 Fixes

- **dispatch-cli:** compile bin/cli.ts for real npx distribution (build-bin + package.json bin)

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **dispatch-cli:** populate DispatchUnit.execution_mode/systemPrompt in calibration unit


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.4 (2026-07-24)

This was a version bump only for dispatch-cli to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- move dispatch-cli to entrypoint, fix build infrastructure

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **dispatch:** repair paths dangled by the superseded-plan relocation

- **dispatch-cli:** exclude src/test/** from lib build so test .d.ts stop shipping (DEBT-DISPATCH-CLI-TEST-DECL-BLOAT-001)


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- move dispatch-cli to entrypoint, fix build infrastructure

- complete all build fixes — move dispatch-cli to entrypoint, fix tsconfig paths

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **dispatch:** repair paths dangled by the superseded-plan relocation

- **dispatch-cli:** exclude src/test/** from lib build so test .d.ts stop shipping (DEBT-DISPATCH-CLI-TEST-DECL-BLOAT-001)


### ❤️  Thank You

- pseudosky