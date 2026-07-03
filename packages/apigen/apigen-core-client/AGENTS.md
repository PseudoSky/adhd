# AGENTS.md — @adhd/apigen-core-client

Strictly factual guidance for AI agents working with this package. No marketing, no roadmap-as-present.

## Package identity

- **Name:** `@adhd/apigen-core-client`
- **Version:** `0.1.0`
- **Type:** TypeScript library (`layer:logic`, `platform:shared`)
- **Main:** `./index.js`, **Module:** `./index.mjs`, **Typings:** `./index.d.ts`
- **Entry point:** `src/index.ts`
- **License:** MIT

## Dependencies

- `ts-morph` ^23.0.0 — TypeScript compiler API wrapper
- `ts-json-schema-generator` ^2.3.0 — schema generation from TS types
- `pino` 10.3.1 — structured logging (threaded as `Logger` type)
- `typescript` ^6.0.3 — type checker
- `decimal.js` ^10.4.3 — Decimal type for `buildSchema` import resolution
- `@adhd/apigen-base-logical` ^0.0.1 — shared logical types

## Public API surface (31 exports)

All exports from `src/index.ts`:

**Functions (11):**
- `extract(opts)` → `Promise<Operation[]>` — v2 symbol-based extractor (6 export shapes + renamed exports)
- `tokenize(raw)` → `string[]` — camelCase/PascalCase/kebab/snake → lower-cased words
- `generateSchemas(opts)` → `Promise<GeneratedSchemas>` — v1 schema extraction (3 modes)
- `composeSchemas(domain, middlewares, overrides?)` → `ComposedSchemas` — middleware composition
- `extractClasses(opts)` → `Promise<Operation[]>` — class export extraction (SPEC §10)
- `createExtractionSession()` → `ExtractionSession` — per-run shared cache
- `clearPersistentProjectCache()` → `void` — drop process-lifetime caches
- `languageOfSource(file)` → `PluginLanguage | undefined` — extension → language tag
- `pluginConsumesSource(plugin, file)` → `boolean` — should plugin consume file?
- `sourcesForPlugin(plugin, files)` → `string[]` — filter files by plugin language
- `effectiveLanguage(plugin)` → `PluginLanguage` — declared language or default `'ts'`

**Interfaces/Types (20):**
- `ExtractOptions`, `ExtractClassesOptions`, `GenerateSchemasOptions`, `ExportMode`
- `GeneratedSchemas`, `ComposedSchemas`, `PluginInput`, `PluginOutput`, `RunInput`
- `OutputPlugin`, `PluginLanguage`
- `ExtractionSession`, `ISessionStats`
- `Operation`, `OperationKind`, `Segment`, `TypeText`, `JSONSchema`, `ApigenSchemaHints`
- `Plugin`, `TargetCapability`, `LayerCapability`, `MountCapability`, `MountedOperation`, `EnvelopeCapability`
- `Call`, `Next`, `Result`, `Chunk`, `Transport`, `Extensions`, `Descriptor`, `Harness`, `Server`, `File`
- `LanguageAwarePlugin`
- `Logger` (re-exported from `pino`)

## Architecture

### Module graph

```
src/index.ts (barrel)
├── lib/extract.ts            — v2 extractor: 6 export shapes, tokenize, id derivation, skip-list, serializability heuristic
│   ├── extractors/named.ts   — named function exports (v1)
│   ├── extractors/default-export.ts — default export (v1)
│   └── extractors/named-object.ts   — named-object export (v1)
├── lib/generate-schemas.ts   — v1 schema extraction (wraps extractors + buildSchema)
├── lib/compose-schemas.ts    — middleware composition
├── lib/extract-classes.ts    — class export extraction (SPEC §10)
├── lib/extraction-session.ts — two-tier cache (session + persistent)
├── lib/types.ts              — v1 types: GeneratedSchemas, ComposedSchemas, ExportMode, OutputPlugin, PluginLanguage
├── lib/plugin.ts             — v2 types: Plugin, TargetCapability, LayerCapability, MountCapability, EnvelopeCapability, Call, etc.
├── lib/descriptor.ts         — canonical types: Operation, Segment, JSONSchema, TypeText
├── lib/source-language.ts    — polyglot routing: languageOfSource, sourcesForPlugin
├── lib/apigen-core.ts        — identity function (smoke test)
└── schema-builders/
    ├── ts-json-schema.ts     — buildSchema: 3-stage pipeline with custom parser augmentor
    ├── morph-walk.ts         — inline/anonymous type → schema via source walk
    ├── morph-fallback.ts     — text-based safety net
    ├── map-set-tuple.ts      — Map/Set/tuple schema transformations
    ├── nominal.ts            — branded type schema with x-apigen-logical:'nominal'
    └── union.ts              — discriminated union schema with oneOf + discriminator
```

## Invariants

These must never be violated by code changes:

| Invariant | Description |
|-----------|-------------|
| `ctx-name-only` | A first parameter named `ctx` is excluded from schema by name match only — no type inspection. Recorded as `hasCtx` so dispatch can re-inject. |
| `data-wrapper-always-present` | `composeSchemas` always wraps domain params in `data: {}`, even for zero-param functions. |
| `false-suppresses-middleware` | Only `false` suppresses a middleware per-function; `null`/`undefined`/`0`/`''` do not. |
| `hints-advisory` | `x-apigen-*` schema hints are advisory. Removing them leaves a valid structural schema. They are never required for correctness, never sourced from a source annotation (Tenet 1). |
| `do-not-parallelize-buildSchema` | `buildSchema` is synchronous CPU under async signature. morph-walk mutates shared SourceFile. `Promise.all` gains nothing and can race. |
| `language-agnostic-output` | Core does not restrict emitted file language. `PluginOutput.files` and `File.content` accept any UTF-8 string. |

## Tooling

- **Build:** `npx nx build apigen-core-client` — `@nx/vite:build`, outputs to `dist/packages/apigen/apigen-core-client/`
- **Test:** `npx nx test apigen-core-client` — 208 tests, `@nx/vite:test`
- **Publish:** `nx-release-publish` (depends on build + test), versioned by `git-tag`
- **Code intelligence:** GitNexus indexed at `adhd` repo. Use `gitnexus_query` / `gitnexus_context` / `gitnexus_impact` for navigation.

## Test file structure

- `src/lib/apigen-core.spec.ts` — smoke test for apigenCore()
- `src/test/extract.spec.ts` — 36 tests covering all 6 export shapes + cross-shape invariants + tokenize
- `src/test/generate-schemas.spec.ts` — 7 tests covering 3 export modes + ctx exclusion
- `src/test/compose-schemas.spec.ts` — 6 tests covering data wrapper, middleware merge, overrides
- `src/test/extraction-session.spec.ts` — 7 tests covering two-tier cache, dispose, persistence, file edit detection
- `src/test/extract-classes.spec.ts` — 18 tests covering static, constructor, instance methods + negative controls
- `src/test/source-language.spec.ts` — ~44 tests covering all 5 languages, routing, defaults
- `src/test/ts-json-schema.spec.ts` — 37 tests covering scalars, nested types, Map/Set/tuple, Decimal imports
- `src/test/nominal.spec.ts` — 25 tests covering $def+$ref, x-apigen hints, stripHints
- `src/test/union.spec.ts` — 21 tests covering oneOf+discriminator, hint removal

## Extraction session lifecycle

1. `createExtractionSession()` — creates session with empty caches
2. Pass `session` to `extract()` / `generateSchemas()` / `extractClasses()`
3. Internally reads through persistent tier (process-lifetime), writing back on miss
4. `session.dispose()` — drops per-run caches (persistent tier survives)
5. `clearPersistentProjectCache()` — drops persistent tier (test beforeEach / explicit reclaim)
