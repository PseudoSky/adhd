# Changelog — @adhd/apigen-cli

All notable changes to this project are documented here.

## Unreleased

### Fixed

- **BUG-APIGEN-021** — `apigen run --source <file> --type <plugin>` crashed with
  `Error: Cannot find module './x.js'` (`MODULE_NOT_FOUND`) against any real
  `--source` whose package has no `"type": "module"` (the common default for
  internal workspace libs, e.g. `@adhd/sox-memory-core`) and that internally
  imports a sibling module via a NodeNext-style `./x.js` specifier resolving to
  `./x.ts` on disk. `importSource()` (`src/lib/import-source.ts`) registered
  only `tsx/esm/api`'s ESM loader hook before the dynamic `import()`; when the
  target's format resolves to CommonJS, Node's ESM loader routes it through the
  CJS translator, which performs a real `require()` that only `tsx/cjs/api`'s
  hook patches — the ESM-only hook never saw it, so the `.js` → `.ts` extension
  mapping never applied. Fixed by also registering `tsx/cjs/api` for the
  duration of the import (mirrors what the full `tsx` CLI does — it patches
  both loaders). Covered by
  `src/test/e2e/import-source-cjs-format.spec.ts`, which spawns the BUILT bin
  as a real `node` child process (the only way to reproduce this — a
  vitest-in-process unit test never hits Node's loader) against a fixture
  reproducing the exact shape (`src/test/fixtures/cjs-format-js-import/`);
  verified red against the pre-fix code (same `MODULE_NOT_FOUND` as the
  original report) and green after.

## 0.1.0 — 2026-07-02

### Added

- **`apigen run`** — Live server from TypeScript source. Supports MCP (stdio/SSE/streaming-http),
  Fastify, Express, CLI output. Dual v1/v2 pipeline paths.
- **`apigen generate`** — Generate server artifacts to disk. Emits resolution scaffolding
  (package.json, tsconfig.json) so generated code runs standalone.
- **`apigen serve`** — Multi-source, multi-language front server. Spawns child `apigen run`
  processes, multiplexes HTTP/1.1 + HTTP/2 (gRPC) on one TCP port via protocol-peeking
  net.Server. Partial availability: a failed host degrades only its own namespace.
- **`apigen run-registry`** / **`apigen generate-registry`** — Discover packages by nx tag
  and wire them into a single server surface or generate artifacts for all.
- **Output plugin system** — Pluggable output targets (mcp, jsonschema, api-fastify,
  api-express, cli, py-flask, py-grpc).
- **`--use` plugin loading** — Layer/mount plugins (health, logger) loaded via built-in slugs,
  package specifiers, or local paths.
- **v2 unified orchestrator** (`--v2` flag) — Detect → extract → merge → collision-check →
  generate/run pipeline with shared ExtractionSession.
- **Projection-override config** (`--config`) — Out-of-source config file for HTTP verb and
  naming overrides (Tenet 1).
- **Per-surface dependency manifest** — Generated package.json patched with only the
  dependencies your code actually uses (e.g. `decimal.js` when `Decimal` format detected).
- **Fail-fast guards** — Precondition checks for 0-function sources and missing `decimal.js`
  optional peer dep.
- **Pino-based logging** — `--log-level`, `--log-format`, `--log-file` with env var
  fallbacks, stderr-only output.

### Fixed

- **BUG-APIGEN-004** — Empty function tables now fail early with actionable message instead
  of cryptic `ERR_MODULE_NOT_FOUND` crash.
- **BUG-APIGEN-009/010** — `--use` plugin loading system threads plugin objects to the run
  plugin via `options.usePlugins` for layered composition.
- **BUG-APIGEN-016** — `serve` pre-provisions managed Python interpreter via
  `@adhd/apigen-python-env` to avoid cold-start timeout.
- **PERF-APIGEN-001** — Single `ExtractionSession` per v2 run eliminates duplicate ts-morph
  Project creation.
- **DEBT-LT-005** — Inline `TS_LOGICAL_TYPE_DEP_MAP` replaced with authoritative
  `tsDepMap()` from `@adhd/apigen-base-logical`.
- **Leak fixes:** `builtinTsconfigPath()` memoized; gRPC h2c sessions have 60s idle eviction
  + `unref()`.
- **Stale monorepo paths** corrected from `packages/apigen/cli/` → `entrypoint/apigen-cli/`.

### Known limitations

- `export { x as y }` aliases, anonymous default exports, and CJS-source files mis-name
  routes in v1 (fixed in v2 by exporting symbol name instead of declaration identifier).
- Python and Rust/Go/Java host languages are designed in SPEC.md but only TypeScript and
  Python are implemented.
