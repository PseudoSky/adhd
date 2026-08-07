# Doc Operations Log — @adhd/apigen-core-client

## Planned operations from doc-conformance.md analysis

Scope type: `library` (TypeScript library, `layer:logic`, `platform:shared`)
Bundle routing: library → README + CHANGELOG + AGENTS.md + llms.txt + docs/reference/ + docs/how-to/ + community-health
High-cardinality: yes (>31 public exports) → Tier-1/2/3 IA, reference docs per module, module map in README

---

## REVISE README.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md flagged UNDOCUMENTED for 12 of 19 capabilities. Existing README (73 lines) covered only generateSchemas, composeSchemas, OutputPlugin, and extraction sessions. Missing: extract, extractClasses, tokenize, source-language routing, Plugin v2, descriptor types, schema builders. Also fixed dead link to `../apigen-cli` (package does not exist) and `../../docs/apigen` → `../../docs/apigen/SPEC.md`.
removed_or_moved (verbatim):
Original README at 73 lines. Full original preserved via git. Key sections preserved: What it does, extraction sessions & caching, develop commands. Redesigned with Tier-1 (6 differentiators), Tier-2 (module map with 7 modules), and links into Tier-3 reference docs.

The original "Public API" import block only listed generateSchemas, composeSchemas, OutputPlugin. Expanded to full API surface.

---

## CREATE LICENSE — 2026-07-02T22:35:00-05:00
reason: Missing community-health file. License derived from root package.json (MIT) and git (holder: pseudosky, first commit year: 2026).

---

## CREATE docs/reference/extract.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md UNDOCUMENTED — extract(), tokenize(), ExtractOptions not covered in any doc. Diátaxis quadrant: Reference.

---

## CREATE docs/reference/schemas.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md REVISE — generateSchemas() and composeSchemas() were mentioned in README but had no structured reference with full type signatures. Diátaxis quadrant: Reference.

---

## CREATE docs/reference/plugin.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md BURIED — Plugin v2 interface completely absent from README. Diátaxis quadrant: Reference. Covers v1 OutputPlugin, v2 Plugin, all four capability interfaces, transport-neutral types (Call, Next, Result, Chunk, Transport, Extensions, Descriptor, Harness, Server, File).

---

## CREATE docs/reference/session.md — 2026-07-02T22:35:00-05:00
reason: README had session content but needed a clean reference with full type signatures for ExtractionSession, ISessionStats, cache architecture. Diátaxis quadrant: Reference.

---

## CREATE docs/reference/extract-classes.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md UNDOCUMENTED — extractClasses() not mentioned anywhere. Diátaxis quadrant: Reference.

---

## CREATE docs/reference/source-language.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md UNDOCUMENTED — languageOfSource()/pluginConsumesSource()/sourcesForPlugin()/effectiveLanguage() not mentioned anywhere. Diátaxis quadrant: Reference.

---

## CREATE docs/reference/descriptor.md — 2026-07-02T22:35:00-05:00
reason: doc-conformance.md UNDOCUMENTED — Operation, Segment, JSONSchema, TypeText, ApigenSchemaHints, OperationKind not documented. These are the canonical contract between extractors and plugins. Diátaxis quadrant: Reference.

---

## CREATE docs/how-to/extraction-pipeline.md — 2026-07-02T22:35:00-05:00
reason: Missing how-to content. Users need a walkthrough connecting extract → generateSchemas → composeSchemas → session.dispose(). Diátaxis quadrant: How-To.

---

## CREATE docs/how-to/building-plugins.md — 2026-07-02T22:35:00-05:00
reason: Missing how-to content. Plugin development guide covering v1 OutputPlugin, v2 Plugin with all four capabilities, v1→v2 migration, and loading semantics. Diátaxis quadrant: How-To.

---

## CREATE CHANGELOG.md — 2026-07-02T22:35:00-05:00
reason: Missing per Keep-a-Changelog format. Baseline v0.1.0 entry covering all shipped capabilities from capabilities.json.

---

## CREATE AGENTS.md — 2026-07-02T22:35:00-05:00
reason: Missing. Strictly factual file covering package identity, dependencies, full public API surface with return types, module graph, invariants table, tooling, test file structure, and extraction session lifecycle. Zero marketing adjectives.

---

## CREATE llms.txt — 2026-07-02T22:35:00-05:00
reason: Missing. Structured LLM context file listing all exports with brief descriptions, invariants, dependencies. Optimized for agent consumption.

---

## Omitted community-health files
reason: CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md, GOVERNANCE.md, SUPPORT.md not created. These belong at the monorepo root level for a monorepo package. Creating them in a single non-root package would be misleading. Logged as a gap — root-level community-health files should be created by the root steward.

## Dead link fixes
- README.md line 9: `../apigen-cli` (package does not exist) → replaced with link to `../README.md` (apigen overview) and `../../docs/apigen/SPEC.md` (apigen spec)

---

## Post-cartographer fixes (closed-loop) — 2026-07-02T22:40:00-05:00
reason: Cartographer re-run found 2 factual errors; consumer test found 3 doc gaps.

### FIX README.md L7 — dependency count
reason: Cartographer flagged "zero runtime dependencies beyond ts-morph and pino" as incorrect (6 runtime deps). Fixed to list all deps explicitly. Also qualified browser-safety claim per reviewer warning.

### FIX CHANGELOG.md L24 — hint key name
reason: Cartographer flagged "x-apigen-nominal" should be "x-apigen-logical:'nominal'" for buildNominalSchema. Fixed.

### FIX docs/reference/schemas.md — SlimMiddleware + two-middleware output
reason: Consumer test flagged PARTIAL for Task 2: no middleware object type documented, and two-middleware-with-override output not shown. Documented the object shape and added explicit output comments showing both `composed.getUser.input.required` and `composed.ping.input.required`.

### FIX docs/reference/descriptor.md — namespace string→Segment conversion
reason: Consumer test flagged ambiguity: ExtractOptions.namespace is string, Operation.namespace is Segment. Added paragraph explaining the conversion via tokenize().

---

## Post-review fixes — 2026-07-02T22:45:00-05:00
reason: Reviewer PASS (15/15) with 3 non-blocking warnings.

### FIX README.md L7 — browser safety claim
reason: Reviewer flagged "safe in Node and the browser" given ts-morph's fs dependency. Qualified: "designed for Node and the browser, though ts-morph's type resolution is Node-only."

### FIX AGENTS.md L75 — module graph hint name
reason: Reviewer flagged "x-apigen-nominal" vs "x-apigen-logical:'nominal'". Fixed to match serialized key name.

### FIX docs/reference/descriptor.md — terminology note
reason: Reviewer flagged confusion between x-apigen-nominal (TS interface) and x-apigen-logical (JSON key). Added clarifying note explaining both refer to same concept.
