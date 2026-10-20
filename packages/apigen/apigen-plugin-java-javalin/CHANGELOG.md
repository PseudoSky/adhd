## Unreleased

### ⚠️ Breaking Changes

- **apigen-plugin-java-javalin:** operation parameter identifiers are now ASCII-only. A parameter name must match the ASCII subset of the Java identifier grammar (ASCII letters, digits, `_` and `$`, not starting with a digit). Parameters that use non-ASCII letters, which the JLS grammar admits, are rejected at generate time with an error naming the parameter; rename the parameter to ASCII to resolve it. The check protects the raw splice of parameter names into the generated `GeneratedDispatcher.java` ([c16f2153](https://github.com/PseudoSky/adhd/commit/c16f2153))

## 0.0.5 (2026-10-15)

### 🩹 Fixes

- **workspace:** restore the publish gate's heavy lane and canonicalise the gate ([45532731](https://github.com/PseudoSky/adhd/commit/45532731))

### ❤️ Thank You

- pseudosky

## 0.0.3 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **nx:** reconcile main's e2e lane with the flat ESLint config + fix missing-deps ([cf72a2ab](https://github.com/PseudoSky/adhd/commit/cf72a2ab))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.0.2 (2026-09-24)


### 🚀 Features

- **apigen-plugin-java-javalin:** new TS plugin -- codegen-woven dispatcher + two-phase spawn (FEAT-APIGEN-001 1/3)


### 🩹 Fixes

- **apigen-java:** mirror PYTHON_MATRIX_SCRIPT's decode+invariant-diff negative-control algorithm exactly (FEAT-APIGEN-001 review)

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **apigen-plugin-java-javalin:** kill orphaned JVM children on parent exit/SIGTERM/SIGINT (BUG-006)

- **apigen:** audit fixes — S-18/S-19/C-20/C-21/S-20, java mvn race, union-encoder envelope, lazy heavy-dep loading


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky