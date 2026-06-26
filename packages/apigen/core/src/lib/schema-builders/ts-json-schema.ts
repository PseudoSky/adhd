import path from 'node:path'
import fs from 'node:fs'
import {
  createParser,
  createFormatter,
  SchemaGenerator,
  AnnotatedType,
  StringType,
} from 'ts-json-schema-generator'
import type { Config, CompletedConfig } from 'ts-json-schema-generator'
import type { Project, SourceFile } from 'ts-morph'
import { morphFallback } from './morph-fallback'
import { buildMapSetTupleSchema } from './map-set-tuple'
import { withResolvedType, walkType } from './morph-walk'

/**
 * Maps npm module specifiers to the canonical SCALAR_SCHEMAS key for that module's
 * primary export.  Used by extractScalarAliases to recognise aliased imports.
 *
 * When a user writes `import { Decimal as D2 } from 'decimal.js'` or
 * `import MyDecimal from 'decimal.js'`, the local name D2 / MyDecimal is an alias
 * for the canonical key 'Decimal'.  Registering the module here lets
 * extractScalarAliases build a local-name → canonical-key map automatically.
 */
const MODULE_SCALAR_MAP: Readonly<Record<string, string>> = {
  'decimal.js': 'Decimal',
}

/**
 * Canonical JSON-Schema fragments for TS built-in scalar types.
 * Keyed by the exact type-text string the extractor emits.
 *
 * Mappings follow §3 / §12–13 of the apigen-logical-types DESIGN:
 *   Date        → format:date-time  (RFC 3339 UTC; Date.prototype.toJSON already emits this)
 *   bigint      → format:int64      (decimal string to avoid JS f64 precision loss)
 *   Uint8Array  → format:byte       (base64 standard + padding)
 *   Buffer      → format:byte       (Node.js Buffer; same wire as Uint8Array)
 *   URL         → format:uri
 *   RegExp      → format:regex
 *   Decimal     → format:decimal    (decimal.js Decimal; arbitrary-precision decimal string)
 *
 * Map / Set are handled in later states (lt-extract-nominal / lt-scalars).
 *
 * NOTE on Decimal: ts-morph emits different type-text strings for the same
 * Decimal class depending on how the user imports it:
 *   - `import { Decimal } from 'decimal.js'`  → `"Decimal"`  (keyed directly below)
 *   - `import Decimal from 'decimal.js'`       → qualified import path like
 *     `import("/path/to/decimal.js/decimal").default`
 *   - `import { Decimal as D2 } from 'decimal.js'` / `import D2 from 'decimal.js'`
 *                                              → `"D2"` (local alias)
 * All forms are normalised to the "Decimal" key before this map is consulted:
 *   - qualified-import form: handled by `normalizeTypeText` regex
 *   - alias form:            handled by the alias map from `extractScalarAliases`
 * See `normalizeTypeText` and `extractScalarAliases`.
 */
export const SCALAR_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  Date:       { type: 'string', format: 'date-time' },
  bigint:     { type: 'string', format: 'int64' },
  Uint8Array: { type: 'string', format: 'byte' },
  Buffer:     { type: 'string', format: 'byte' },
  URL:        { type: 'string', format: 'uri' },
  RegExp:     { type: 'string', format: 'regex' },
  Decimal:    { type: 'string', format: 'decimal' },
}

/**
 * TypeReference names that ts-json-schema-generator gets wrong or expands badly.
 * These are intercepted in the parser augmentor so that ANY occurrence of these
 * types — top-level, nested in objects, nested in arrays, inside unions — emits
 * the canonical {type:"string", format:…} instead of the wrong/expanded schema.
 *
 * Date, URL, RegExp are already handled correctly by ts-json-schema-generator's
 * built-in TypeReferenceNodeParser, so they are NOT listed here.
 */
const REFERENCE_FORMAT_MAP: Record<string, string> = {
  Uint8Array: 'byte',
  Buffer:     'byte',
  Decimal:    'decimal',
}

/**
 * Scan a source file's import declarations and return a map of
 *   `localName → canonicalScalarKey`
 * for any import whose module specifier is in MODULE_SCALAR_MAP and whose
 * local name differs from the canonical key.
 *
 * Examples:
 *   `import { Decimal as D2 } from 'decimal.js'`  → { D2: 'Decimal' }
 *   `import MyDec from 'decimal.js'`               → { MyDec: 'Decimal' }
 *   `import Decimal from 'decimal.js'`             → {}  (no alias needed)
 *   `import { Decimal } from 'decimal.js'`         → {}  (no alias needed)
 *
 * The returned map is consumed by normalizeTypeText and morphFallback so that
 * aliased external scalar types are recognised at ANY nesting depth.
 */
export function extractScalarAliases(sf: SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>()
  for (const imp of sf.getImportDeclarations()) {
    const modSpec = imp.getModuleSpecifierValue()
    const canonicalKey = MODULE_SCALAR_MAP[modSpec]
    if (!canonicalKey) continue

    // Default import: `import MyDec from 'decimal.js'`
    const defaultImp = imp.getDefaultImport()
    if (defaultImp) {
      const localName = defaultImp.getText()
      if (localName !== canonicalKey) aliases.set(localName, canonicalKey)
    }

    // Named imports: `import { Decimal as D2 } from 'decimal.js'`
    //                `import { Decimal } from 'decimal.js'`  (no alias → same as canonical)
    for (const ni of imp.getNamedImports()) {
      // localName = alias if present, else the imported name
      const localName = ni.getAliasNode()?.getText() ?? ni.getName()
      if (localName !== canonicalKey) aliases.set(localName, canonicalKey)
    }
  }
  return aliases
}

/**
 * Structural shape of a ts-json-schema-generator TypeReference AST node.
 * We avoid importing `ts.Node` directly because ts-json-schema-generator bundles
 * its own TypeScript version (5.x) which may differ from the workspace version,
 * causing structural type mismatches at compile time. Using a structural
 * subtype here is sufficient since we only access the fields we need.
 */
type TsRefNode = {
  kind: number
  typeName?: { escapedText?: string; right?: { escapedText?: string } }
}

/**
 * Minimal shape of a ts-json-schema-generator MutableParser (ChainNodeParser).
 * Typed structurally to avoid direct coupling to ts-json-schema-generator's
 * internal TypeScript version.
 */
type MutableParserLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addNodeParser(parser: any): void
}

/**
 * Parser augmentor for ts-json-schema-generator that intercepts scalar type
 * nodes and emits {type:"string", format:…} at any nesting depth.
 *
 * Two kinds of nodes are intercepted:
 *   - BigIntKeyword  → {type:string, format:int64}
 *     (ts-json-schema-generator maps bigint → NumberType, losing precision)
 *   - TypeReference  for Uint8Array / Buffer / Decimal
 *     (ts-json-schema-generator expands these to their full object structure
 *      or emits {}, neither of which is the canonical wire format)
 *
 * ts-json-schema-generator's own TypeReferenceNodeParser already handles Date /
 * URL / RegExp correctly (emits AnnotatedType with the right format string), so
 * those are intentionally omitted here.
 */
function buildParserAugmentor(
  bigIntKind: number,
  typeRefKind: number,
): (chain: MutableParserLike) => void {
  return (chain) => {
    // Intercept TypeReference nodes for Uint8Array / Buffer / Decimal
    chain.addNodeParser({
      supportsNode(node: TsRefNode) {
        if (node.kind !== typeRefKind) return false
        const name = node.typeName?.escapedText ?? node.typeName?.right?.escapedText
        return name !== undefined && Object.prototype.hasOwnProperty.call(REFERENCE_FORMAT_MAP, name)
      },
      createType(node: TsRefNode) {
        const name = (node.typeName?.escapedText ?? node.typeName?.right?.escapedText) as string
        return new AnnotatedType(new StringType(), { format: REFERENCE_FORMAT_MAP[name] }, false)
      },
    })

    // Intercept BigIntKeyword → {type:string, format:int64}
    chain.addNodeParser({
      supportsNode(node: { kind: number }) {
        return node.kind === bigIntKind
      },
      createType() {
        return new AnnotatedType(new StringType(), { format: 'int64' }, false)
      },
    })
  }
}

/**
 * Lazily resolved TypeScript module used by ts-json-schema-generator.
 * ts-json-schema-generator bundles its own TypeScript (currently 5.x) which
 * may differ from the workspace TypeScript version. We must use the same
 * TypeScript instance that ts-json-schema-generator's parsers use, so that
 * SyntaxKind constants and node shape are consistent.
 */
let _tsjsTs: typeof import('typescript') | undefined
function getTsjsTs(): typeof import('typescript') {
  if (_tsjsTs) return _tsjsTs
  try {
    // ts-json-schema-generator resolves TypeScript relative to its own package
    const tsjsDir = path.dirname(require.resolve('ts-json-schema-generator/package.json'))
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _tsjsTs = require(require.resolve('typescript', { paths: [tsjsDir] })) as typeof import('typescript')
  } catch {
    // Fallback: use whatever TypeScript is resolvable from here
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _tsjsTs = require('typescript') as typeof import('typescript')
  }
  return _tsjsTs
}

/**
 * Cache of built {@link SchemaGenerator} instances keyed by
 * `path \0 tsconfig \0 fileVersion`.
 *
 * WHY: `createProgram` builds a full TypeScript program (parses the file +
 * lib.d.ts, runs the type checker) on every call. The BUG-013 change moved from
 * a single `createGenerator` per type to a `runScalarAwareGenerator` per
 * `buildSchema` call, so extracting an N-export file rebuilt the whole program N
 * times — O(N) full type-checks, ~1.4s each. The program/parser/formatter depend
 * ONLY on `(path, tsconfig, file-contents)`, NOT on the `type` being extracted
 * (`createSchema(type)` is the cheap lookup). Caching the generator per source
 * file collapses N program builds into one, turning O(N) type-checks into O(1).
 *
 * Invalidation: the cache key includes the file's mtime+size so an edited file
 * rebuilds. Only the stable real source file (Path 1) is cached; the OS-temp
 * anonymous-type files (Path 2) pass `cacheable=false` so their single-use
 * programs are never retained (caching them would OOM a many-export file).
 */
type BuiltGenerator = { createSchema(type: string): unknown }
const _generatorCache = new Map<string, BuiltGenerator>()

/** Stable cache key for a source program: path + tsconfig + file version (mtime-ns, size). */
function generatorCacheKey(pathStr: string, tsconfig: string | undefined): string {
  let version = '0'
  try {
    const st = fs.statSync(pathStr)
    version = `${st.mtimeMs}:${st.size}`
  } catch {
    // File may not exist yet (caller will surface the real error); use a sentinel.
    version = 'nostat'
  }
  return `${pathStr} ${tsconfig ?? ''} ${version}`
}

/**
 * Run ts-json-schema-generator with the scalar-aware parser augmentor.
 *
 * Used for BOTH the normal named-type path (replaces bare `createGenerator`)
 * and the alias-injection fallback for anonymous types.
 *
 * `createParser` and `createFormatter` require a `CompletedConfig` (all
 * optional Config fields filled in). We merge the caller's Config with the
 * library's DEFAULT_CONFIG, matching what `createGenerator` does internally.
 *
 * The built generator (program + augmented parser + formatter) is cached per
 * source file — see {@link _generatorCache} — but ONLY when `cacheable` is true.
 *
 * `cacheable` MUST be false for the anonymous temp-file path (Path 2): those
 * files use a unique path per call, so caching them would retain a distinct full
 * TS program per anonymous type and grow the cache without bound (it OOMs a
 * many-export file). Only the stable real source file (Path 1) is cached, where
 * the amortisation turns O(N) program builds into O(1).
 */
function runScalarAwareGenerator(config: Config, cacheable: boolean): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DEFAULT_CONFIG } = require('ts-json-schema-generator/dist/src/Config.js') as {
    DEFAULT_CONFIG: CompletedConfig
  }
  const completedConfig: CompletedConfig = { ...DEFAULT_CONFIG, ...config }
  const pathStr = completedConfig.path as string
  const key = cacheable ? generatorCacheKey(pathStr, completedConfig.tsconfig) : undefined

  let gen = key !== undefined ? _generatorCache.get(key) : undefined
  if (!gen) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createProgram } = require('ts-json-schema-generator/dist/factory/program.js') as {
      createProgram: (cfg: CompletedConfig) => unknown
    }
    const ts = getTsjsTs()
    const augmentor = buildParserAugmentor(ts.SyntaxKind.BigIntKeyword, ts.SyntaxKind.TypeReference)
    const program = createProgram(completedConfig) as Parameters<typeof createParser>[0]
    // Cast augmentor through unknown: our MutableParserLike is structurally compatible
    // with the tsjsg ParserAugmentor but typed independently to avoid TS version conflicts.
    const parser = createParser(program, completedConfig, augmentor as unknown as Parameters<typeof createParser>[2])
    const formatter = createFormatter(completedConfig)
    gen = new SchemaGenerator(program, parser, formatter, completedConfig) as BuiltGenerator
    if (key !== undefined) _generatorCache.set(key, gen)
  }

  return gen.createSchema(completedConfig.type as string) as Record<string, unknown>
}

/**
 * Normalise the raw type-text emitted by ts-morph before consulting
 * {@link SCALAR_SCHEMAS} and before delegating to ts-json-schema-generator /
 * morphFallback.
 *
 * Three categories of normalisation are applied (in order):
 *
 * 1. **Decimal qualified import path** — ts-morph emits a fully-qualified import
 *    expression for default-imported external types without a tsconfig, e.g.:
 *      `import("/abs/path/to/node_modules/decimal.js/decimal").default`
 *    Normalised to `"Decimal"` so both reach the same SCALAR_SCHEMAS entry.
 *    The pattern anchors on the module path containing `decimal.js` and the
 *    exported binding being `.default`.
 *
 * 2. **Import alias map** — when the caller passes a non-empty alias map (built
 *    by `extractScalarAliases`), a bare local name like `D2` is remapped to its
 *    canonical scalar key (`'Decimal'`).  This handles both:
 *      `import { Decimal as D2 } from 'decimal.js'`  → type text `"D2"` → `"Decimal"`
 *      `import MyDec from 'decimal.js'`              → type text `"MyDec"` → `"Decimal"`
 *
 * 3. **Readonly array forms** — ts-morph emits `readonly T[]` for both
 *    `readonly T[]` and `ReadonlyArray<T>` parameter annotations.  The
 *    `readonly` modifier is irrelevant to JSON-Schema generation.  Stripping it
 *    ensures morphFallback can match the trailing `[]` suffix correctly.
 */
function normalizeTypeText(typeText: string, aliases?: ReadonlyMap<string, string>): string {
  let t = typeText.trim()

  // 1. Decimal qualified import path  →  'Decimal'
  if (/^import\(["'][^"']*decimal\.js[^"']*["']\)\.default$/.test(t)) {
    return 'Decimal'
  }

  // 2. Import alias map  →  canonical scalar key
  if (aliases?.size) {
    const mapped = aliases.get(t)
    if (mapped !== undefined) return mapped
  }

  // 3a. ReadonlyArray<T>  →  T[]
  //     Handles the generic form directly (ts-morph usually normalises to
  //     "readonly T[]" already, but guard the generic spelling too).
  const readonlyArrayMatch = t.match(/^ReadonlyArray<(.+)>$/)
  if (readonlyArrayMatch) {
    t = `${readonlyArrayMatch[1].trim()}[]`
  }

  // 3b. readonly T[]  →  T[]
  //     Strip the leading "readonly " keyword.  Apply in a loop so that
  //     nested readonly arrays (e.g. "readonly readonly string[]") are also
  //     fully stripped, even though ts-morph doesn't emit those in practice.
  while (t.startsWith('readonly ')) {
    t = t.slice('readonly '.length).trim()
  }

  return t
}

/** Escape a string for use in a RegExp literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Qualified-import expressions emitted by ts-morph for default-imported
 * external scalars when the project has no tsconfig, e.g.:
 *   `import("/abs/path/to/decimal.js/decimal").default`
 *
 * When these appear INSIDE composite type strings like
 *   `{ cost: import("...decimal.js/decimal").default; }`
 * the whole-string check in normalizeTypeText does not match.  This list
 * records, for each MODULE_SCALAR_MAP entry, a regex that matches the
 * qualified import fragment ANYWHERE inside a longer type text.
 * rewriteQualifiedImports applies them in applyAliasesToTypeText.
 */
const QUALIFIED_IMPORT_PATTERNS: ReadonlyArray<{ pattern: RegExp; key: string }> = (
  Object.entries(MODULE_SCALAR_MAP).map(([modSpec, canonicalKey]) => ({
    // Matches: import("...{modSpec}...").default  (single or double quotes)
    // The module specifier appears inside an absolute path, so we allow any
    // characters between the quote and the specifier, and between the specifier
    // and the closing quote / `.default`.
    pattern: new RegExp(
      `import\\(["'][^"']*${escapeRegExp(modSpec)}[^"']*["']\\)\\.default`,
      'g',
    ),
    key: canonicalKey,
  }))
)

/**
 * Replace all qualified import expressions (e.g. `import("...decimal.js/decimal").default`)
 * within a composite type text with their canonical SCALAR_SCHEMAS key (`Decimal`).
 *
 * This handles the case where ts-morph emits the full qualified form inside an
 * object or array type text (vs. as the whole type text, which normalizeTypeText handles):
 *   `{ cost: import(".../decimal.js/decimal").default; }`
 *                                                ↓
 *   `{ cost: Decimal; }`
 */
function rewriteQualifiedImports(typeText: string): string {
  let result = typeText
  for (const { pattern, key } of QUALIFIED_IMPORT_PATTERNS) {
    result = result.replace(pattern, key)
  }
  return result
}

/**
 * Rewrite all occurrences of:
 *   1. Qualified import expressions   `import("...decimal.js/...").default`  → `Decimal`
 *   2. Local alias names              `D2`                                   → `Decimal`
 * anywhere in a type-text string so that the anonymous temp-file (Path 2) and
 * morphFallback (Path 3) only see canonical SCALAR_SCHEMAS keys.
 *
 * The alias replacement uses word-boundary matching so that `D2` inside
 * `{ D2Foo: … }` is not accidentally rewritten.
 */
function applyAliasesToTypeText(typeText: string, aliases: ReadonlyMap<string, string>): string {
  // 1. Qualified import expressions (e.g. import("...decimal.js/...").default → Decimal)
  let result = rewriteQualifiedImports(typeText)
  // 2. Local alias names (e.g. D2 → Decimal)
  for (const [localName, canonicalKey] of aliases) {
    result = result.replace(new RegExp(`\\b${escapeRegExp(localName)}\\b`, 'g'), canonicalKey)
  }
  return result
}

/** Attempts ts-json-schema-generator first; falls back to morphFallback for inline/anonymous types. */
export async function buildSchema(
  _project: Project,
  sf: SourceFile,
  typeText: string,
  tsconfig?: string
): Promise<Record<string, unknown>> {
  if (['void', 'undefined', 'null', 'Promise<void>'].includes(typeText)) return { type: 'null' }

  // Build an alias map for this source file so that locally-aliased external scalar
  // types (e.g. `import { Decimal as D2 } from 'decimal.js'`) are resolved to their
  // canonical SCALAR_SCHEMAS key at every nesting depth.
  const aliases = extractScalarAliases(sf)

  // Normalise the type text before the SCALAR_SCHEMAS lookup so that
  // default-imported external types (e.g. `import Decimal from 'decimal.js'`
  // which ts-morph emits as `import("...decimal.js/decimal").default`) are
  // mapped to their canonical key first, and import aliases (e.g. D2 → Decimal)
  // are resolved via the alias map.
  const normalizedTypeText = normalizeTypeText(typeText, aliases)

  // Resolve well-known built-in TS scalar types to their canonical logical-type schemas
  // BEFORE delegating to ts-json-schema-generator (which emits {} for most of these).
  // Per §4.1 [inv:hints-advisory]: structure (format) is authoritative; no x-apigen-* needed here.
  const scalarSchema = SCALAR_SCHEMAS[normalizedTypeText]
  if (scalarSchema !== undefined) return scalarSchema

  // --- Map / Set / tuple: emit array-compatible schemas (not the class expansion) ---
  //
  // ts-json-schema-generator resolves `Map<K,V>` / `Set<T>` to the class
  // declaration and expands it to `{type:object, properties:{size:{type:number}}}`,
  // which rejects the canonical `[[k,v]]` / `[v]` array wire and tells the
  // transcoder the value is an object. Tuples expand to a positional `items`
  // array which is correct for validation but which the legacy generator path
  // never produced for inline params. We intercept all three here and build the
  // array-compatible schema directly, recursing through buildSchema so nested
  // logical types inside them (e.g. `Map<string, Date>`, `Set<Decimal>`,
  // `[Date, number]`) still get their canonical `format`.
  // Element types are resolved against the SAME source file / tsconfig.
  const mapSetTuple = await buildMapSetTupleSchema(normalizedTypeText, (elemType) =>
    buildSchema(_project, sf, elemType, tsconfig),
  )
  if (mapSetTuple !== undefined) return mapSetTuple

  // --- Path 1: named type (ts-json-schema-generator can look it up by name) ---
  //
  // Run the scalar-aware generator (with custom parser augmentor) so that even
  // named types that CONTAIN nested scalars like bigint / Uint8Array / Decimal
  // get the right format at every depth.
  try {
    const config: Config = {
      path: sf.getFilePath(),
      type: normalizedTypeText,
      skipTypeCheck: true,
      tsconfig,
    }
    // Path 1 keys off the stable real source file → cache the built program.
    const schema = runScalarAwareGenerator(config, true)
    return schema as Record<string, unknown>
  } catch {
    // Fall through to alias-injection path for anonymous / inline types.
  }

  // --- Path 2: anonymous / inline type (e.g. `{ at: Date; label: string; }`, `Date[]`,
  //             `Record<string, number>`, `Box<number>`) ---
  //
  // PERFORMANCE: the original BUG-013 implementation of this path wrote a scratch
  // `.ts` file and built a BRAND-NEW `ts-json-schema-generator` program (parse
  // lib.d.ts + the scratch file, run the checker) for EVERY anonymous type —
  // O(types) full program builds, ~0.35–1.0s each (the 23-fn showcase summed to
  // ~17.8s; the test suite to ~494s). The named-type Path 1 was cached but this
  // path could not be (a unique temp path per call).
  //
  // Instead we resolve the inline type through the ALREADY-LOADED ts-morph
  // program (`_project` / `sf` — lib.d.ts + the user's imports are already parsed
  // and type-checked) by adding a throwaway in-memory type alias to `sf`, then
  // walking the resolved `Type` structurally. Each resolution is ~10ms and
  // builds NO temp file and NO new generator program. See `morph-walk.ts`.
  //
  // The walk delegates every nested node back through `buildSchema` (this same
  // entrypoint), so scalar formats (Date/bigint/Uint8Array/Buffer/Decimal),
  // Map/Set/tuple wire, import aliases (`D2`), and readonly arrays all keep
  // flowing through their existing handlers — correctness is unchanged.
  try {
    const walked = await withResolvedType(_project, sf, normalizedTypeText, (resolved) =>
      walkType(resolved, (elemType) => buildSchema(_project, sf, elemType, tsconfig), 0),
    )
    if (walked !== undefined) return walked
  } catch {
    // Fall through to the text-based fallback below.
  }

  // Final safety net: structural text-based fallback for any type the ts-morph
  // walk could not resolve. We rewrite aliases (D2 → Decimal) and qualified
  // imports to canonical SCALAR_SCHEMAS keys first so morphFallback can resolve
  // them at nested positions too.
  const canonicalTypeText = applyAliasesToTypeText(normalizedTypeText, aliases)
  return morphFallback(canonicalTypeText, 0, aliases)
}
