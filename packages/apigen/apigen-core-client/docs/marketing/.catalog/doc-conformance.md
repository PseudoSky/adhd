# Doc Conformance — @adhd/apigen-core-client v0.1.0

## Surface Inventory (post-rewrite)

The doc surface now consists of 14 files across Diátaxis quadrants:

| File | Lines | Quadrant | Status |
|------|-------|----------|--------|
| `README.md` | 238 | Tutorial/Reference | Rewritten (Tier-1/2/3 IA) |
| `CHANGELOG.md` | 25 | Reference | New (v0.1.0 baseline) |
| `AGENTS.md` | 118 | Reference (agents) | New |
| `llms.txt` | 85 | Reference (LLMs) | New |
| `LICENSE` | 21 | Community health | New (MIT) |
| `docs/reference/extract.md` | 80 | Reference | New |
| `docs/reference/schemas.md` | 103 | Reference | New |
| `docs/reference/plugin.md` | 217 | Reference | New |
| `docs/reference/session.md` | 93 | Reference | New |
| `docs/reference/extract-classes.md` | 81 | Reference | New |
| `docs/reference/source-language.md` | 102 | Reference | New |
| `docs/reference/descriptor.md` | 104 | Reference | New |
| `docs/how-to/extraction-pipeline.md` | 123 | How-To | New |
| `docs/how-to/building-plugins.md` | 234 | How-To | New |

## Ideal Benchmark Comparison

Per the recalled framework for a `library` scope (`layer:logic`, `platform:shared`), the expected doc set:

| Required | Status | File |
|----------|--------|------|
| `README.md` | ✅ Present | 238 lines, Tier-1/2/3 structure |
| API reference | ✅ Present | 7 reference docs covering all public modules |
| `CHANGELOG.md` | ✅ Present | Keep-a-Changelog, v0.1.0 baseline |
| `AGENTS.md` | ✅ Present | 118 lines, strictly factual |
| `llms.txt` | ✅ Present | 85 lines, structured LLM context |
| How-To guides | ✅ Present | 2 guides (extraction pipeline, building plugins) |
| `LICENSE` | ✅ Present | MIT |
| `CONTRIBUTING.md` | ⚠️ Missing | Belongs at monorepo root (same as previous run) |

## Coverage Proportions

| Category | Before | After | Delta |
|----------|--------|-------|-------|
| Present docs | 1 (README) | 14 | +13 |
| JUNK | 0% | 0% | — |
| REDUNDANT | 0% | 0% | — |
| UNDOCUMENTED capabilities | 12 of 19 (63%) | 1 of 19 (~5%) | −11 |

The single remaining undocumented capability is `apigenCore` (trivial identity function, `substance: trivial`) — listed in AGENTS.md module graph but not in consumer-facing docs. Consumers do not need this function.

Internal schema builders (`buildSchema`, `buildNominalSchema`, `buildUnionSchema`) are now mentioned as internal in CHANGELOG.md — sufficient for non-public API.

## Quality Assessment per Doc

### README.md

| Flag | Line | Detail |
|------|------|--------|
| `KEEP` | 1–4 (title + summary) | Accurate scoping |
| `INCORRECT` | 7 | "Pure TypeScript with zero runtime dependencies beyond ts-morph and pino" — package.json has 6 runtime dependencies including ts-json-schema-generator (the schema generation engine), typescript, decimal.js, and @adhd/apigen-base-logical. ts-json-schema-generator is a significant runtime dependency, not omitted. |
| `KEEP` | 11–15 (Install) | Correct |
| `KEEP` | 17–85 (Quickstart) | Covers extract, generateSchemas, composeSchemas, tokenize, source-language routing with real output examples |
| `KEEP` | 87–210 (Features) | Covers all 6 export shapes, two-tier caching, v2 plugin interface, schema pipeline, polyglot routing, class extraction |
| `KEEP` | 212–227 (Module Map + How-To) | Links to all reference docs and how-to guides |
| `KEEP` | 229–238 (Develop + License) | Correct build/test commands |

**Recommendation:** `REVISE` — fix the dependency claim on line 7 to be accurate (list all key runtime deps, not just ts-morph and pino).

### CHANGELOG.md

| Flag | Line | Detail |
|------|------|--------|
| `KEEP` | 1–7 (header) | Correct Keep-a-Changelog format |
| `INCORRECT` | 24 | "buildNominalSchema (branded types with x-apigen-nominal)" — the actual hint key is `x-apigen-logical` (value `'nominal'`), not `x-apigen-nominal`. Verified against capabilities.json → `build-nominal-schema` description: "Carries x-apigen-logical:'nominal' hint". |
| `KEEP` | 8–25 (v0.1.0 entries) | All other entries match capabilities.json |

**Recommendation:** `REVISE` — fix "x-apigen-nominal" → "x-apigen-logical" on line 24.

### AGENTS.md

| Flag | Detail |
|------|--------|
| `KEEP` | Strictly factual. Package identity, all 31 exports, dependencies, module graph, invariants table, tooling, test structure, session lifecycle — all accurate. No marketing adjectives. |

**Recommendation:** `KEEP`

### llms.txt

| Flag | Detail |
|------|--------|
| `KEEP` | All 11 functions + 20 types documented with concise signatures. Invariants, dependencies, cross-references all present and accurate. |

**Recommendation:** `KEEP`

### LICENSE

| Flag | Detail |
|------|--------|
| `KEEP` | MIT, correct copyright holder (pseudosky, 2026). |

**Recommendation:** `KEEP`

### docs/reference/extract.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers extract() with all 6 export shapes, renamed exports, skip conventions, ctx exclusion, ExtractOptions, tokenize(), and Operation shape. All details match capabilities.json. |

**Recommendation:** `KEEP`

### docs/reference/schemas.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers generateSchemas() with 3 export modes, composeSchemas() with data-wrapper and false-suppression invariants, all option types. Accurate. |

**Recommendation:** `KEEP`

### docs/reference/plugin.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers v1 OutputPlugin and v2 Plugin (all 4 capabilities) with full type signatures. Transport-neutral types (Call, Next, Result, Chunk, Transport, Extensions, Descriptor, Harness, Server, File) all documented. Matches capabilities.json. |

**Recommendation:** `KEEP`

### docs/reference/session.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers createExtractionSession(), clearPersistentProjectCache(), ExtractionSession, ISessionStats, two-tier cache architecture, invalidation caveat, and do-not-parallelize warning. Accurate. |

**Recommendation:** `KEEP`

### docs/reference/extract-classes.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers extractClasses() with static/constructor/instance modes, ExtractClassesOptions, operation kinds table, instanceId envelope. Accurate. |

**Recommendation:** `KEEP`

### docs/reference/source-language.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers all 4 language helpers, PluginLanguage type, extension mapping table, LanguageAwarePlugin interface. All examples match capabilities.json verified outputs. |

**Recommendation:** `KEEP`

### docs/reference/descriptor.md

| Flag | Detail |
|------|--------|
| `KEEP` | Covers Operation (all fields), OperationKind, Segment, JSONSchema with $defs/$ref, ApigenSchemaHints, TypeText. id determinism and safe defaults correctly explained. Tenet 1 (no source annotations) noted. |

**Recommendation:** `KEEP`

### docs/how-to/extraction-pipeline.md

| Flag | Detail |
|------|--------|
| `KEEP` | Step-by-step pipeline (create session → extract → generateSchemas → composeSchemas → extractClasses → dispose). Session lifetime rule, performance notes, APIGEN_PROGRAM_CACHE, parallelization warning. All accurate. |

**Recommendation:** `KEEP`

### docs/how-to/building-plugins.md

| Flag | Detail |
|------|--------|
| `KEEP` | v1 vs v2 comparison table, building v1 plugins, v1→v2 migration, building v2 plugins (target codegen-only, target+serve, layer, mount, envelope), plugin loading. All code examples are valid (type-checkable against the Plugin interface). |

**Recommendation:** `KEEP`

## Dead Link Audit

| Link | Source | Target | Status |
|------|--------|--------|--------|
| `[apigen](../README.md)` | README.md:9 | `packages/apigen/README.md` | ✅ Exists |
| `[apigen spec](../../docs/apigen/SPEC.md)` | README.md:9 | `docs/apigen/SPEC.md` | ✅ Exists |
| `./docs/reference/extract.md` | README.md:216 | `docs/reference/extract.md` | ✅ Exists |
| `./docs/reference/schemas.md` | README.md:217 | `docs/reference/schemas.md` | ✅ Exists |
| `./docs/reference/plugin.md` | README.md:218 | `docs/reference/plugin.md` | ✅ Exists |
| `./docs/reference/session.md` | README.md:219 | `docs/reference/session.md` | ✅ Exists |
| `./docs/reference/extract-classes.md` | README.md:220 | `docs/reference/extract-classes.md` | ✅ Exists |
| `./docs/reference/source-language.md` | README.md:221 | `docs/reference/source-language.md` | ✅ Exists |
| `./docs/reference/descriptor.md` | README.md:222 | `docs/reference/descriptor.md` | ✅ Exists |
| `./docs/how-to/extraction-pipeline.md` | README.md:226 | `docs/how-to/extraction-pipeline.md` | ✅ Exists |
| `./docs/how-to/building-plugins.md` | README.md:227 | `docs/how-to/building-plugins.md` | ✅ Exists |
| `./LICENSE` | README.md:238 | `LICENSE` | ✅ Exists |
| All cross-reference links in reference docs | 7 files | Varied | ✅ All resolve |
| All cross-reference links in how-to docs | 2 files | Varied | ✅ All resolve |

**0 dead links found.**

## Cross-Reference with capabilities.json

| Capability | Has consumer doc? | Doc location |
|-----------|-------------------|-------------|
| `generate-schemas` | ✅ | README + `docs/reference/schemas.md` |
| `compose-schemas` | ✅ | README + `docs/reference/schemas.md` |
| `extract` | ✅ | README + `docs/reference/extract.md` |
| `tokenize` | ✅ | README + `docs/reference/extract.md` |
| `extract-classes` | ✅ | README + `docs/reference/extract-classes.md` |
| `create-extraction-session` | ✅ | README + `docs/reference/session.md` |
| `clear-persistent-project-cache` | ✅ | `docs/reference/session.md` |
| `language-of-source` | ✅ | README + `docs/reference/source-language.md` |
| `plugin-consumes-source` | ✅ | README + `docs/reference/source-language.md` |
| `sources-for-plugin` | ✅ | README + `docs/reference/source-language.md` |
| `effective-language` | ✅ | README + `docs/reference/source-language.md` |
| `build-schema` (internal) | ✅ | `CHANGELOG.md` (as internal) |
| `build-nominal-schema` (internal) | ✅ | `CHANGELOG.md` (as internal) |
| `build-union-schema` (internal) | ✅ | `CHANGELOG.md` (as internal) |
| `output-plugin-v1` | ✅ | README + `docs/reference/plugin.md` + `docs/how-to/building-plugins.md` |
| `plugin-v2` | ✅ | README + `docs/reference/plugin.md` + `docs/how-to/building-plugins.md` |
| `descriptor-types` | ✅ | `docs/reference/descriptor.md` + `llms.txt` |
| `apigen-core-function` | ⚠️ | Only in AGENTS.md module graph (not consumer-facing) |
| `plugin-language-type` | ✅ | `docs/reference/source-language.md` + `docs/reference/plugin.md` |

## Extracted Orphans

None. All correct information from capabilities.json is now represented in consumer-facing docs. The two factual errors (README dep claim, CHANGELOG hint name) are fixable — no information needs rehoming.

## Summary for Steward

The post-rewrite doc surface is comprehensive and accurate with two minor exceptions:

1. **README.md line 7** — dependency claim is incorrect (omits ts-json-schema-generator, typescript, decimal.js, base-logical). Fix to: "TypeScript with runtime dependencies on ts-morph, ts-json-schema-generator, and pino — safe in Node and the browser."

2. **CHANGELOG.md line 24** — "x-apigen-nominal" should read "x-apigen-logical" for buildNominalSchema.

All other docs are factually correct, cross-references resolve, and 18 of 19 capabilities are documented for consumers. The remaining 1 (apigenCore) is a trivial identity function that consumers don't need.
