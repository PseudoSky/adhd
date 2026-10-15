## 0.2.4 (2026-10-15)

### 🚀 Features

- **apigen-engine-gateway:** serveMcpPassthrough SDK server fronting a bin: MCP source through the Layer stack (T08b) ([b68f0b94](https://github.com/PseudoSky/adhd/commit/b68f0b94))
- **apigen-engine-gateway:** bin: source kind with argv fallback and stdio MCP resolver ([112fdc9e](https://github.com/PseudoSky/adhd/commit/112fdc9e))

### 🩹 Fixes

- **apigen-engine-gateway:** forward Layer-forced arguments to the upstream when the host sent none ([1615953d](https://github.com/PseudoSky/adhd/commit/1615953d))
- **apigen-engine-gateway:** launcher transport close is a no-op once closed ([56c6bcda](https://github.com/PseudoSky/adhd/commit/56c6bcda))
- **apigen-engine-gateway:** never stamp x-apigen-safe on MCP-sourced composed schemas (G3) ([0ccf5296](https://github.com/PseudoSky/adhd/commit/0ccf5296))
- **apigen-engine-gateway:** user-chosen operation ids, verbatim passthrough of arguments and tool definitions, skip bad tools, follow host and upstream shutdown (G2-G8) ([0cf7897d](https://github.com/PseudoSky/adhd/commit/0cf7897d))
- **apigen-engine-gateway:** kill process groups, honor abort and timeout, allowlist the child environment, cap the transport line buffer (G1, G9-G11) ([af678447](https://github.com/PseudoSky/adhd/commit/af678447))

### ❤️ Thank You

- pseudosky

## 0.2.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.2.1 (2026-09-24)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.1.6 (2026-07-25)


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-24)

This was a version bump only for apigen-engine-gateway to align it with other projects, there were no code changes.

## 0.1.4 (2026-07-24)

This was a version bump only for apigen-engine-gateway to align it with other projects, there were no code changes.

## 0.1.3 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)


### 🩹 Fixes

- resolve build errors from workspace-cleanup merge — unterminated strings, path mappings, lint

- **apigen:** update remaining stale @adhd/apigen-errors, core, logical refs

- **apigen:** externalize real npm deps in vite builds — 10 packages shipped broken dist bundles (__filename/timeOrigin crash)


### ❤️  Thank You

- pseudosky