# Changelog

All notable changes to `@adhd/apigen-core-client` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
