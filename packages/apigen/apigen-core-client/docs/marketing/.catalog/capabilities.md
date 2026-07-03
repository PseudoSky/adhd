# Capabilities — @adhd/apigen-core-client v0.1.0

> **Machine contract:** `capabilities.json` is authoritative. This table is derived from it.

| ID | Name | Status | Substance | Key Verdict |
|----|------|--------|-----------|-------------|
| `generate-schemas` | `generateSchemas` | ✅ shipped | substantial | Three export modes (named/default/named-object), ctx exclusion, Promise unwrap, session sharing |
| `compose-schemas` | `composeSchemas` | ✅ shipped | moderate | data:{} wrapper always present, per-function middleware override, false-only suppression |
| `extract` | `extract` (v2 symbol-based) | ✅ shipped | substantial | All 6 export shapes + renamed exports, deterministic ids, ctx exclusion, query serializability |
| `tokenize` | `tokenize` | ✅ shipped | moderate | camelCase/PascalCase/kebab/SCREAMING_SNAKE → lower-cased words |
| `extract-classes` | `extractClasses` | ✅ shipped | substantial | Static methods always extracted; instance methods opt-in; constructor + instance-method kinds; instanceId envelope |
| `create-extraction-session` | `createExtractionSession` | ✅ shipped | substantial | Two-tier cache (per-session + persistent), mtime+size versioned, LRU-capped (APIGEN_PROGRAM_CACHE=8) |
| `clear-persistent-project-cache` | `clearPersistentProjectCache` | ✅ shipped | trivial | Drops process-lifetime caches |
| `language-of-source` | `languageOfSource` | ✅ shipped | moderate | Extension→PluginLanguage mapping (.ts/tsx/mts/cts→ts, .py→py, .rs→rust, .go→go, .java→java) |
| `plugin-consumes-source` | `pluginConsumesSource` | ✅ shipped | trivial | Boolean match of file extension vs plugin language |
| `sources-for-plugin` | `sourcesForPlugin` | ✅ shipped | trivial | Filter file list by plugin language; preserves order |
| `effective-language` | `effectiveLanguage` | ✅ shipped | trivial | Declared language or 'ts' default |
| `build-schema` | `buildSchema` (internal) | ✅ shipped | substantial | Three-stage pipeline: scalar→format, Map/Set/tuple→array-compatible, named-type generator with custom augmentor, morphWalk for anonymous types, morphFallback safety net |
| `build-nominal-schema` | `buildNominalSchema` (internal) | ✅ shipped | moderate | $def+$ref structure, x-apigen-logical:'nominal', codec hints, stripHints for advisory-only contract |
| `build-union-schema` | `buildUnionSchema` (internal) | ✅ shipped | moderate | oneOf+discriminator with mapping, x-apigen-logical:'union', ≥2 variants guard |
| `output-plugin-v1` | `OutputPlugin` (v1 interface) | ✅ shipped | moderate | Legacy generate/run contract; PluginOutput.files is language-agnostic |
| `plugin-v2` | `Plugin` (v2 interface) | ✅ shipped | substantial | Four orthogonal capabilities: target/layer/mount/envelope; transport-agnostic (http/grpc/mcp/cli); Call/Next/Result/Chunk layer contract |
| `descriptor-types` | Descriptor types | ✅ shipped | substantial | Operation with JSON Schema 2020-12 IR, Segment (casing-neutral), TypeText, OperationKind; advisory x-apigen-* hints |
| `apigen-core-function` | `apigenCore` | ✅ shipped | trivial | Identity function returning 'apigen-core' |
| `plugin-language-type` | `PluginLanguage` type | ✅ shipped | trivial | Union: 'ts' \| 'py' \| 'rust' \| 'go' \| 'java' |

**Counts:** 19 capabilities total — 19 shipped, 0 roadmap, 0 deprecated.
