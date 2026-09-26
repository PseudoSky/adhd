## 0.3.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **apigen-core-client:** canonicalise union dedupe; cover standalone boolean literals ([0999daa7](https://github.com/PseudoSky/adhd/commit/0999daa7))
- **apigen-core-client:** keep co-resident catch-alls and lone boolean literals satisfiable in oneOf unions ([1fc9df24](https://github.com/PseudoSky/adhd/commit/1fc9df24))
- **apigen-core-client:** collapse duplicated boolean oneOf branch in union schemas (3a3e5884) ([1ee5b0b0](https://github.com/PseudoSky/adhd/commit/1ee5b0b0))
- **apigen-core-client:** sanitize vacuous catch-all branches in union schemas (BUG-APIGEN-059) ([e5887bb8](https://github.com/PseudoSky/adhd/commit/e5887bb8))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 0.3.1 (2026-09-24)


### 🚀 Features

- **apigen:** schema-driven worked examples for MCP tool descriptions + validation errors

- **backlog:** INTERFACE_v2 consolidation — six-verb surface, web UI (search/stats/batch/edit), stats API (citationCount, closedAt, summary scope + window)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **apigen-core-client:** hoist nested defs for return types and batch schemas

- **apigen-core-client:** close Path-2 object schemas with additionalProperties, index-signature aware

- **backlog:** unblock backlog:build — author/reporter TS2339 + wire MCP identity

- **apigen-cli:** batch nested-input CLI/HTTP wiring, sandbox isolation leaks, morph-walk index-signature regression

- **apigen:** audit fixes — S-18/S-19/C-20/C-21/S-20, java mvn race, union-encoder envelope, lazy heavy-dep loading


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 0.2.2 (2026-07-30)


### 🚀 Features

- **apigen:** generic batch/bulk fan-out operations (FEAT-APIGEN-BULK-OPS-001)


### 🩹 Fixes

- **apigen:** schema extraction required-array + CLI mount/discriminated-union gaps


### ❤️  Thank You

- pseudosky

## 0.2.1 (2026-07-28)

This was a version bump only for apigen-core-client to align it with other projects, there were no code changes.

## 0.1.6 (2026-07-27)


### 🚀 Features

- **apigen:** batch/bulk fan-out plugin — `groupBatchableOperationsByKind()`, `buildBatchKindSchema()`, `buildBatchMountedOperations()` for discriminated `_batch/<kind>` mounts


### ❤️  Thank You

- pseudosky

## 0.1.5 (2026-07-25)


### 🩹 Fixes

- **apigen,backlog:** killable serve, configurable namespace, flaky test + log spam


### 🔥 Performance

- **test:** bound vitest thread pools to curb CPU oversubscription (DEBT-TEST-CPU-OVERSUBSCRIBED-001)


### ❤️  Thank You

- pseudosky

## 0.1.4 (2026-07-24)

This was a version bump only for apigen-core-client to align it with other projects, there were no code changes.

## 0.1.3 (2026-07-24)


### 🩹 Fixes

- **apigen:** wire EnvelopeCapability into real --use schema composition


### ❤️  Thank You

- pseudosky

## 0.1.2 (2026-07-23)


### 🚀 Features

- **apigen:** canonical route/tool-name projection across transports; serve + generate() + import-specifier fixes


### ❤️  Thank You

- pseudosky

## 0.1.1 (2026-07-23)

This was a version bump only for apigen-core-client to align it with other projects, there were no code changes.

## [Unreleased]

### Fixed

- BUG-APIGEN-CORE-004: `isSerializableType()` used a purely textual allow-list over `type.getText()`, so a serializable const typed as a generic-utility-type wrapper — e.g. `Record<K, V>` — was rendered as text matching none of the allow-list's patterns and silently skipped instead of extracted as `kind:'query'`. Replaced with structural inspection of the ts-morph `Type` object (index signatures, properties, call/construct signatures, recursing through arrays/tuples/unions/intersections), which recognizes `Record<K, V>` and other generic wrappers (`Partial<T>`, `Readonly<T>`, `Array<T>`) around serializable shapes while still correctly excluding genuinely non-serializable generics like `Map<K, V>`. See `packages/apigen/apigen-core-client/BACKLOG.md`'s `## Fixed` section for full root-cause and fix detail.

## [0.1.0] — 2026-07-02

### Added

- `extract()` — v2 symbol-based extractor producing canonical `Operation[]` descriptors from TypeScript source. Handles all six export shapes (named fn, const/arrow, named-object, default named, anonymous default, CJS) plus renamed exports.
- `generateSchemas()` — v1 schema extraction with three export modes (named, default, named-object). Ctx first-param excluded by name match only.
- `composeSchemas()` — middleware envelope composition with `data: {}` wrapper. `false` override suppresses a middleware per-function.
- `extractClasses()` — class export extraction per SPEC §10. Static methods always extracted; constructor + instance methods opt-in via `includeInstances`.
- `createExtractionSession()` / `clearPersistentProjectCache()` — two-tier extraction cache (per-session + persistent process-lifetime). LRU-capped generator cache via `APIGEN_PROGRAM_CACHE`.
- `tokenize()` — camelCase/PascalCase/kebab-case/snake_case tokenizer for casing-neutral `Segment` records.
- `languageOfSource()` / `pluginConsumesSource()` / `sourcesForPlugin()` / `effectiveLanguage()` — polyglot source-language routing for multi-host `serve` mode.
- `OutputPlugin` (v1) — legacy `{ id, generate(input), run?(input) }` contract for codegen plugins.
- `Plugin<Opts>` (v2) — capability-based plugin interface: `target` (project descriptor), `layer` (wrap operations), `mount` (synthetic operations), `envelope` (side-channel fields).
- Transport-neutral v2 types: `Call`, `Next`, `Result`, `Chunk`, `Transport`, `Extensions`, `Descriptor`, `Harness`, `Server`, `File`.
- Canonical descriptor types: `Operation`, `Segment`, `JSONSchema`, `TypeText`, `OperationKind`, `ApigenSchemaHints`. JSON Schema 2020-12 IR with `$defs`/`$ref`.
- `PluginLanguage` union type (`'ts' | 'py' | 'rust' | 'go' | 'java'`).
- Internal schema builders: `buildSchema` (three-stage pipeline), `buildNominalSchema` (branded types with `x-apigen-logical:'nominal'`), `buildUnionSchema` (discriminated unions with `oneOf`).
- Logger types re-exported from `pino`.
