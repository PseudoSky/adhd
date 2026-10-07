## 0.1.7 (2026-10-07)

### 🚀 Features

- **dispatch:** lane/grant validation, liveness heartbeats, duplicate-dispatch guard, evidence tooling (7ed25125 d794287f 65788fd8 025d3239 f613472b) ([9f556fd7](https://github.com/PseudoSky/adhd/commit/9f556fd7))
- **agent-core-provider:** merge provider representations into one registry + shared PartialBinding (d3f1f787 D-G(1)) ([eabd654c](https://github.com/PseudoSky/adhd/commit/eabd654c))

### ❤️ Thank You

- pseudosky

## 0.1.6 (2026-10-06)

### 🚀 Features

- **dispatch-orchestrator:** dag.session_id producer stamps every DispatchUnit (fa9d3079/03145a46) ([e8271d77](https://github.com/PseudoSky/adhd/commit/e8271d77))
- **dispatch-orchestrator:** thread session_id through DispatchUnit + fire (fa9d3079) ([e3d3aa26](https://github.com/PseudoSky/adhd/commit/e3d3aa26))

### 🩹 Fixes

- **dispatch-orchestrator,dispatch-cli:** make HITL reachable from dispatch ([57f53429](https://github.com/PseudoSky/adhd/commit/57f53429))

### ❤️ Thank You

- pseudosky

## 0.1.4 (2026-09-26)

### 🚀 Features

- **dispatch-base-spec:** add 'fs.edit' OperationAction ([74096864](https://github.com/PseudoSky/adhd/commit/74096864))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.1.3 (2026-09-24)

This was a version bump only for dispatch-base-spec to align it with other projects, there were no code changes.

## 0.1.2 (2026-08-08)


### 🩹 Fixes

- **dispatch:** D-07 own-status eligibility guard (DEBT-DISPATCH-013) + formalize ICalibrationStore (DEBT-DISPATCH-018, BL-103)


### ❤️  Thank You

- pseudosky

## 0.1.1 (2026-08-07)


### 🚀 Features

- **dispatch-base-spec:** split DispatchUnit.prompt into systemPrompt/prompt, add execution_mode


### 🩹 Fixes

- **dispatch-base-spec:** enforce DispatchLogEntry.provider enum in validateDagJson

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 0.0.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.0.5 (2026-07-24)

This was a version bump only for dispatch-base-spec to align it with other projects, there were no code changes.

## 0.0.4 (2026-07-24)

This was a version bump only for dispatch-base-spec to align it with other projects, there were no code changes.

## 0.0.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **dispatch:** repair paths dangled by the superseded-plan relocation


### ❤️  Thank You

- pseudosky

## 0.0.2 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- **lint:** eliminate @typescript-eslint/no-explicit-any across 5 packages (LINT-ANY-001)

- **dispatch:** repair paths dangled by the superseded-plan relocation


### ❤️  Thank You

- pseudosky