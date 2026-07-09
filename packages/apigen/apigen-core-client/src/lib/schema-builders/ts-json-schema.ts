import path from 'node:path';
import {
  createParser,
  createFormatter,
  SchemaGenerator,
  AnnotatedType,
  StringType,
} from 'ts-json-schema-generator';
import type { Config, CompletedConfig } from 'ts-json-schema-generator';
import type { Project, SourceFile } from 'ts-morph';
import { morphFallback } from './morph-fallback';
import { buildMapSetTupleSchema } from './map-set-tuple';
import { withResolvedType, walkType } from './morph-walk';
import {
  fileVersion,
  persistentSchemasFor,
  type BuiltGenerator,
  type InternalExtractionSession,
} from '../extraction-session';

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
};

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
export const SCALAR_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> =
  {
    Date: { type: 'string', format: 'date-time' },
    bigint: { type: 'string', format: 'int64' },
    Uint8Array: { type: 'string', format: 'byte' },
    Buffer: { type: 'string', format: 'byte' },
    URL: { type: 'string', format: 'uri' },
    RegExp: { type: 'string', format: 'regex' },
    Decimal: { type: 'string', format: 'decimal' },
  };

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
  Buffer: 'byte',
  Decimal: 'decimal',
};

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
export function extractScalarAliases(
  sf: SourceFile
): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const imp of sf.getImportDeclarations()) {
    const modSpec = imp.getModuleSpecifierValue();
    const canonicalKey = MODULE_SCALAR_MAP[modSpec];
    if (!canonicalKey) continue;

    // Default import: `import MyDec from 'decimal.js'`
    const defaultImp = imp.getDefaultImport();
    if (defaultImp) {
      const localName = defaultImp.getText();
      if (localName !== canonicalKey) aliases.set(localName, canonicalKey);
    }

    // Named imports: `import { Decimal as D2 } from 'decimal.js'`
    //                `import { Decimal } from 'decimal.js'`  (no alias → same as canonical)
    for (const ni of imp.getNamedImports()) {
      // localName = alias if present, else the imported name
      const localName = ni.getAliasNode()?.getText() ?? ni.getName();
      if (localName !== canonicalKey) aliases.set(localName, canonicalKey);
    }
  }
  return aliases;
}

/**
 * Structural shape of a ts-json-schema-generator TypeReference AST node.
 * We avoid importing `ts.Node` directly because ts-json-schema-generator bundles
 * its own TypeScript version (5.x) which may differ from the workspace version,
 * causing structural type mismatches at compile time. Using a structural
 * subtype here is sufficient since we only access the fields we need.
 */
type TsRefNode = {
  kind: number;
  typeName?: { escapedText?: string; right?: { escapedText?: string } };
};

/**
 * Minimal shape of a ts-json-schema-generator MutableParser (ChainNodeParser).
 * Typed structurally to avoid direct coupling to ts-json-schema-generator's
 * internal TypeScript version.
 */
type MutableParserLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addNodeParser(parser: any): void;
};

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
  typeRefKind: number
): (chain: MutableParserLike) => void {
  return (chain) => {
    // Intercept TypeReference nodes for Uint8Array / Buffer / Decimal
    chain.addNodeParser({
      supportsNode(node: TsRefNode) {
        if (node.kind !== typeRefKind) return false;
        const name =
          node.typeName?.escapedText ?? node.typeName?.right?.escapedText;
        return (
          name !== undefined &&
          Object.prototype.hasOwnProperty.call(REFERENCE_FORMAT_MAP, name)
        );
      },
      createType(node: TsRefNode) {
        const name = (node.typeName?.escapedText ??
          node.typeName?.right?.escapedText) as string;
        return new AnnotatedType(
          new StringType(),
          { format: REFERENCE_FORMAT_MAP[name] },
          false
        );
      },
    });

    // Intercept BigIntKeyword → {type:string, format:int64}
    chain.addNodeParser({
      supportsNode(node: { kind: number }) {
        return node.kind === bigIntKind;
      },
      createType() {
        return new AnnotatedType(new StringType(), { format: 'int64' }, false);
      },
    });
  };
}

/**
 * Lazily resolved TypeScript module used by ts-json-schema-generator.
 * ts-json-schema-generator bundles its own TypeScript (currently 5.x) which
 * may differ from the workspace TypeScript version. We must use the same
 * TypeScript instance that ts-json-schema-generator's parsers use, so that
 * SyntaxKind constants and node shape are consistent.
 */
let _tsjsTs: typeof import('typescript') | undefined;
function getTsjsTs(): typeof import('typescript') {
  if (_tsjsTs) return _tsjsTs;
  try {
    // ts-json-schema-generator resolves TypeScript relative to its own package
    const tsjsDir = path.dirname(
      require.resolve('ts-json-schema-generator/package.json')
    );
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _tsjsTs = require(require.resolve('typescript', {
      paths: [tsjsDir],
    })) as typeof import('typescript');
  } catch {
    // Fallback: use whatever TypeScript is resolvable from here
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _tsjsTs = require('typescript') as typeof import('typescript');
  }
  return _tsjsTs;
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
 * Invalidation & bounding: entries are keyed by `(path, tsconfig)` and store
 * the file's mtime+size version IN the entry — a version mismatch REPLACES the
 * entry (the old program becomes collectible), so the cache holds at most ONE
 * generator per distinct file. The previous scheme keyed on the version too,
 * which grew a new ~50–100MB entry on every file edit in watch/serve mode,
 * forever. Only the stable real source file (Path 1) is cached; the
 * anonymous-type path (Path 2) passes `cacheable=false` so its single-use
 * programs are never retained (caching them would OOM a many-export file).
 *
 * When an {@link InternalExtractionSession} is supplied, its per-run
 * `generatorCache` + memoized `statVersion` are used instead of this
 * module-global fallback, and `session.dispose()` releases everything.
 */
const _generatorCache = new Map<
  string,
  { version: string; gen: BuiltGenerator }
>();

/**
 * Max entries in the persistent (module-global) generator tier. Each entry
 * holds a full TypeScript program (~100–200MB), so the tier is LRU-capped:
 * memory stays proportional to the recent working set, not to every file the
 * process ever extracted. Tune via APIGEN_PROGRAM_CACHE (0 disables the
 * persistent tier entirely; per-run session caching still applies).
 */
function persistentGeneratorCap(): number {
  const raw = process.env['APIGEN_PROGRAM_CACHE'];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

function persistentGeneratorGet(
  key: string
): { version: string; gen: BuiltGenerator } | undefined {
  const entry = _generatorCache.get(key);
  if (entry) {
    // Refresh recency (Map preserves insertion order → oldest is first).
    _generatorCache.delete(key);
    _generatorCache.set(key, entry);
  }
  return entry;
}

function persistentGeneratorSet(
  key: string,
  entry: { version: string; gen: BuiltGenerator }
): void {
  const cap = persistentGeneratorCap();
  if (cap === 0) return;
  _generatorCache.delete(key);
  _generatorCache.set(key, entry);
  while (_generatorCache.size > cap) {
    const oldest = _generatorCache.keys().next().value as string;
    _generatorCache.delete(oldest);
  }
}

/** Identity key for a source program: path + tsconfig (version is stored IN the entry). */
function generatorEntryKey(
  pathStr: string,
  tsconfig: string | undefined
): string {
  return `${pathStr}\u0000${tsconfig ?? ''}`;
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
/**
 * Zod module specifiers that indicate a source file imports zod transitively.
 * When detected, Path 1 (ts-json-schema-generator) is skipped because its
 * `skipTypeCheck` AST-based resolution confuses zod types with user types,
 * producing corrupted schemas that crash at runtime with unresolvable $ref.
 */
const ZOD_MODULE_SPECIFIERS = new Set(['zod', /^zod\/./]);

/**
 * Check whether a source file imports from `zod` (either directly or from
 * a sub-path like `zod/v4`).  Memoizable per SourceFile.
 */
function sourceFileHasZodImport(sf: SourceFile): boolean {
  for (const imp of sf.getImportDeclarations()) {
    const mod = imp.getModuleSpecifierValue();
    for (const spec of ZOD_MODULE_SPECIFIERS) {
      if (typeof spec === 'string') {
        if (mod === spec) return true;
      } else {
        if (spec.test(mod)) return true;
      }
    }
  }
  return false;
}

/**
 * Remove any `$defs`/`definitions` entries that originate from zod internals
 * (e.g., ZodString, ZodNumber, ZodType). ts-json-schema-generator's whole-file
 * extraction registers zod-derived declarations into the shared definitions
 * registry when a source file transitively imports anything using zod,
 * corrupting unrelated primitive entries.
 *
 * The filter deletes:
 *   1. Keys whose name contains "zod" or "Zod" (case-insensitive).
 *   2. Keys whose value contains a `$ref` that points to any key removed in
 *      step 1 (transitive cleanup).
 *
 * This runs on EVERY generated schema — both the top-level schema returned
 * from `createSchema()` and its embedded `$defs`/`definitions` objects.
 */
function filterZodDefinitions(schema: Record<string, unknown>): void {
  for (const defKey of ['$defs', 'definitions']) {
    const defs = schema[defKey] as Record<string, unknown> | undefined;
    if (!defs || typeof defs !== 'object') continue;

    const keys = Object.keys(defs);
    if (keys.length === 0) continue;

    // Pass 1: find all zod-related keys.
    const zodKeys = new Set(keys.filter((k) => /zod/i.test(k)));

    // Pass 2: any entry whose $ref points to a zod key is also zod-polluted.
    for (const [key, value] of Object.entries(defs)) {
      if (zodKeys.has(key)) continue;
      if (typeof value !== 'object' || value === null) continue;
      const valRec = value as Record<string, unknown>;
      const ref = typeof valRec['$ref'] === 'string' ? valRec['$ref'] : '';
      if (!ref) continue;
      for (const zk of zodKeys) {
        if (ref.includes(zk)) {
          zodKeys.add(key);
          break;
        }
      }
    }

    for (const key of zodKeys) {
      delete defs[key];
    }
  }

  // Pass 3: recursively walk the entire schema and strip any remaining
  // zod references that survived the top-level $defs purge.
  stripZodRefsRecursive(schema);
}

/**
 * Recursively walk a schema object (including nested properties, items,
 * oneOf branches, allOf/anyOf arrays) and:
 *   - Remove `$ref` entries that point to zod-named definitions
 *   - Delete the `$ref` key (schema falls back to structural validation
 *     which may be looser but never crashes).
 */
function stripZodRefsRecursive(
  node: Record<string, unknown>,
  visited?: WeakSet<object>
): void {
  if (!node || typeof node !== 'object') return;
  const set = visited ?? new WeakSet<object>();
  if (set.has(node)) return;
  set.add(node);

  for (const key of Object.keys(node)) {
    if (key === '$ref' && typeof node[key] === 'string') {
      const ref = node[key] as string;
      // Match patterns like #/definitions/$ZodNumberParams,
      // #/definitions/ZodString, etc.
      if (/zod/i.test(ref)) {
        delete node[key];
      }
    }
  }

  // Recurse into child schemas (objects and arrays)
  for (const [, value] of Object.entries(node)) {
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            stripZodRefsRecursive(item as Record<string, unknown>, set);
          }
        }
      } else {
        stripZodRefsRecursive(value as Record<string, unknown>, set);
      }
    }
  }
}

/**
 * Validate that all `$ref` entries in a schema point to definitions that
 * exist within the schema's own `$defs` or `definitions`.
 *
 * Throws at GENERATE time if any dangling `$ref` is found — this prevents
 * the runtime crash described in BUG-APIGEN-CORE-001.
 */
function validateSchemaRefs(schema: Record<string, unknown>): void {
  // Collect available definition keys
  const available = new Set<string>();
  for (const defKey of ['$defs', 'definitions']) {
    const obj = schema[defKey] as Record<string, unknown> | undefined;
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) available.add(k);
    }
  }

  const dangling = findDanglingRefs(schema, available);
  if (dangling.length > 0) {
    throw new Error(
      `[apigen-core-client] Generated schema contains ${dangling.length} unresolvable $ref(s): ${dangling.join(', ')}. ` +
        `This usually means zod-internal definitions were stripped but $ref references to them remain. ` +
        `Check the source file's imports or the ts-json-schema-generator output.`
    );
  }
}

/**
 * Walk a schema tree and return a list of all `$ref` values that point to
 * definitions NOT present in `available`.
 */
function findDanglingRefs(
  schema: Record<string, unknown>,
  available: Set<string>
): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const dangling: string[] = [];

  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = value.match(/#\/(?:\$defs|definitions)\/(.+)$/);
      if (match && !available.has(match[1])) {
        dangling.push(value);
      }
    } else if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'object' && item !== null) {
            dangling.push(
              ...findDanglingRefs(item as Record<string, unknown>, available)
            );
          }
        }
      } else {
        dangling.push(
          ...findDanglingRefs(value as Record<string, unknown>, available)
        );
      }
    }
  }

  return dangling;
}

function runScalarAwareGenerator(
  config: Config,
  cacheable: boolean,
  session?: InternalExtractionSession
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DEFAULT_CONFIG } = require('ts-json-schema-generator/dist/src/Config.js') as { DEFAULT_CONFIG: CompletedConfig };
  const completedConfig: CompletedConfig = { ...DEFAULT_CONFIG, ...config };
  const pathStr = completedConfig.path as string;

  // Both tiers are keyed by (path, tsconfig) and store the file version IN
  // the entry, so an edited file REPLACES its entry instead of accumulating a
  // new one per edit (bounded: at most one program per distinct file).
  // Sessions READ THROUGH to the module-global tier: repeated runs in one
  // process (watch mode, serve rebuilds, test loops) reuse the built program
  // across sessions, while session.dispose() still releases the per-run map.
  const key = cacheable
    ? generatorEntryKey(pathStr, completedConfig.tsconfig)
    : undefined;
  let version: string | undefined;
  if (cacheable) {
    // Within a session a run is a snapshot — stat each file once.
    version = session ? session.statVersion(pathStr) : fileVersion(pathStr);
  }

  let gen: BuiltGenerator | undefined;
  if (key !== undefined) {
    const entry =
      session?.generatorCache.get(key) ?? persistentGeneratorGet(key);
    if (entry && entry.version === version) gen = entry.gen;
  }
  if (!gen) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createProgram } = require('ts-json-schema-generator/dist/factory/program.js') as {
      createProgram: (cfg: CompletedConfig) => unknown;
    };
    const ts = getTsjsTs();
    const augmentor = buildParserAugmentor(
      ts.SyntaxKind.BigIntKeyword,
      ts.SyntaxKind.TypeReference
    );
    const program = createProgram(completedConfig) as Parameters<
      typeof createParser
    >[0];
    // Cast augmentor through unknown: our MutableParserLike is structurally compatible
    // with the tsjsg ParserAugmentor but typed independently to avoid TS version conflicts.
    const parser = createParser(
      program,
      completedConfig,
      augmentor as unknown as Parameters<typeof createParser>[2]
    );
    const formatter = createFormatter(completedConfig);
    gen = new SchemaGenerator(
      program,
      parser,
      formatter,
      completedConfig
    ) as BuiltGenerator;
    if (session) session.stats.generatorsBuilt++;
    if (key !== undefined && version !== undefined) {
      const entry = { version, gen };
      persistentGeneratorSet(key, entry); // persistent tier (LRU-capped)
      session?.generatorCache.set(key, entry);
    }
  }

  const rawSchema = gen.createSchema(completedConfig.type as string) as Record<
    string,
    unknown
  >;

  // BUG-APIGEN-CORE-001: prune zod-internal definitions that ts-json-schema-generator
  // may have registered via whole-file extraction when a source file transitively
  // imports a zod-using module.
  filterZodDefinitions(rawSchema);

  // BUG-APIGEN-CORE-001: fail at generate time (loud) on any remaining
  // dangling $ref that survived the zod filter.
  validateSchemaRefs(rawSchema);

  return rawSchema;
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
function normalizeTypeText(
  typeText: string,
  aliases?: ReadonlyMap<string, string>
): string {
  let t = typeText.trim();

  // 1. Decimal qualified import path  →  'Decimal'
  if (/^import\(["'][^"']*decimal\.js[^"']*["']\)\.default$/.test(t)) {
    return 'Decimal';
  }

  // 2. Import alias map  →  canonical scalar key
  if (aliases?.size) {
    const mapped = aliases.get(t);
    if (mapped !== undefined) return mapped;
  }

  // 3a. ReadonlyArray<T>  →  T[]
  //     Handles the generic form directly (ts-morph usually normalises to
  //     "readonly T[]" already, but guard the generic spelling too).
  const readonlyArrayMatch = t.match(/^ReadonlyArray<(.+)>$/);
  if (readonlyArrayMatch) {
    t = `${readonlyArrayMatch[1].trim()}[]`;
  }

  // 3b. readonly T[]  →  T[]
  //     Strip the leading "readonly " keyword.  Apply in a loop so that
  //     nested readonly arrays (e.g. "readonly readonly string[]") are also
  //     fully stripped, even though ts-morph doesn't emit those in practice.
  while (t.startsWith('readonly ')) {
    t = t.slice('readonly '.length).trim();
  }

  return t;
}

/** Escape a string for use in a RegExp literal. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
const QUALIFIED_IMPORT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  key: string;
}> = Object.entries(MODULE_SCALAR_MAP).map(([modSpec, canonicalKey]) => ({
  // Matches: import("...{modSpec}...").default  (single or double quotes)
  // The module specifier appears inside an absolute path, so we allow any
  // characters between the quote and the specifier, and between the specifier
  // and the closing quote / `.default`.
  pattern: new RegExp(
    `import\\(["'][^"']*${escapeRegExp(modSpec)}[^"']*["']\\)\\.default`,
    'g'
  ),
  key: canonicalKey,
}));

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
  let result = typeText;
  for (const { pattern, key } of QUALIFIED_IMPORT_PATTERNS) {
    result = result.replace(pattern, key);
  }
  return result;
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
function applyAliasesToTypeText(
  typeText: string,
  aliases: ReadonlyMap<string, string>
): string {
  // 1. Qualified import expressions (e.g. import("...decimal.js/...").default → Decimal)
  let result = rewriteQualifiedImports(typeText);
  // 2. Local alias names (e.g. D2 → Decimal)
  for (const [localName, canonicalKey] of aliases) {
    result = result.replace(
      new RegExp(`\\b${escapeRegExp(localName)}\\b`, 'g'),
      canonicalKey
    );
  }
  return result;
}

/**
 * Attempts ts-json-schema-generator first; falls back to morphFallback for
 * inline/anonymous types.
 *
 * When `session` is supplied, results are memoized per
 * `(sourceFile, tsconfig, typeText)` for the session's lifetime — the
 * orchestrator's extract + generateSchemas double pass over the same file, and
 * repeated parameter types across functions, all become Map hits. Cached
 * fragments are shared by reference; callers treat schemas as immutable.
 */
export async function buildSchema(
  _project: Project,
  sf: SourceFile,
  typeText: string,
  tsconfig?: string,
  session?: InternalExtractionSession
): Promise<Record<string, unknown>> {
  if (!session)
    return buildSchemaUncached(_project, sf, typeText, tsconfig, undefined);

  const sfPath = sf.getFilePath();
  const key = `${sfPath} ${tsconfig ?? ''} ${typeText}`;
  const hit = session.schemaCache.get(key);
  if (hit !== undefined) {
    session.stats.schemaCacheHits++;
    return hit;
  }

  // Persistent tier: survives the session so repeated runs in one process
  // (watch/serve rebuilds, test loops) skip recomputation while the file is
  // unchanged (version-checked; an edit replaces the file's whole map).
  const persistent = persistentSchemasFor(
    sfPath,
    tsconfig,
    session.statVersion(sfPath)
  );
  const persisted = persistent.get(typeText);
  if (persisted !== undefined) {
    session.stats.schemaCacheHits++;
    session.schemaCache.set(key, persisted);
    return persisted;
  }

  session.stats.schemaCacheMisses++;
  const schema = await buildSchemaUncached(
    _project,
    sf,
    typeText,
    tsconfig,
    session
  );
  session.schemaCache.set(key, schema);
  persistent.set(typeText, schema);
  return schema;
}

async function buildSchemaUncached(
  _project: Project,
  sf: SourceFile,
  typeText: string,
  tsconfig: string | undefined,
  session: InternalExtractionSession | undefined
): Promise<Record<string, unknown>> {
  if (['void', 'undefined', 'null', 'Promise<void>'].includes(typeText))
    return { type: 'null' };

  // Build an alias map for this source file so that locally-aliased external scalar
  // types (e.g. `import { Decimal as D2 } from 'decimal.js'`) are resolved to their
  // canonical SCALAR_SCHEMAS key at every nesting depth. Memoized per SourceFile
  // for the session's lifetime (the imports of an in-flight file don't change).
  let aliases: ReadonlyMap<string, string>;
  if (session) {
    const cached = session.aliasCache.get(sf);
    aliases = cached ?? extractScalarAliases(sf);
    if (!cached) session.aliasCache.set(sf, aliases);
  } else {
    aliases = extractScalarAliases(sf);
  }

  // Normalise the type text before the SCALAR_SCHEMAS lookup so that
  // default-imported external types (e.g. `import Decimal from 'decimal.js'`
  // which ts-morph emits as `import("...decimal.js/decimal").default`) are
  // mapped to their canonical key first, and import aliases (e.g. D2 → Decimal)
  // are resolved via the alias map.
  const normalizedTypeText = normalizeTypeText(typeText, aliases);

  // Resolve well-known built-in TS scalar types to their canonical logical-type schemas
  // BEFORE delegating to ts-json-schema-generator (which emits {} for most of these).
  // Per §4.1 [inv:hints-advisory]: structure (format) is authoritative; no x-apigen-* needed here.
  const scalarSchema = SCALAR_SCHEMAS[normalizedTypeText];
  if (scalarSchema !== undefined) return scalarSchema;

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
  const mapSetTuple = await buildMapSetTupleSchema(
    normalizedTypeText,
    (elemType) => buildSchema(_project, sf, elemType, tsconfig, session)
  );
  if (mapSetTuple !== undefined) return mapSetTuple;

  // --- Path 1: named type (ts-json-schema-generator can look it up by name) ---
  //
  // BUG-APIGEN-CORE-001: ts-json-schema-generator's skipTypeCheck AST-based
  // resolution confuses zod types with user types when the source file imports
  // zod, producing corrupted schemas that crash at runtime. Skip Path 1 for
  // zod-importing files — fall directly to morph-walk (Path 2) which uses
  // ts-morph's type-checked resolution and correctly resolves primitives.
  const hasZodImport =
    session?.zodImportCache.get(sf) ?? sourceFileHasZodImport(sf);
  if (session) session.zodImportCache.set(sf, hasZodImport);

  if (!hasZodImport) {
    try {
      const config: Config = {
        path: sf.getFilePath(),
        type: normalizedTypeText,
        skipTypeCheck: true,
        tsconfig,
      };
      // Path 1 keys off the stable real source file → cache the built program.
      const schema = runScalarAwareGenerator(config, true, session);
      return schema as Record<string, unknown>;
    } catch {
      // Fall through to alias-injection path for anonymous / inline types.
    }
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
    const walked = await withResolvedType(
      _project,
      sf,
      normalizedTypeText,
      (resolved) =>
        walkType(
          resolved,
          (elemType) => buildSchema(_project, sf, elemType, tsconfig, session),
          0
        )
    );
    if (walked !== undefined) return walked;
  } catch {
    // Fall through to the text-based fallback below.
  }

  // Final safety net: structural text-based fallback for any type the ts-morph
  // walk could not resolve. We rewrite aliases (D2 → Decimal) and qualified
  // imports to canonical SCALAR_SCHEMAS keys first so morphFallback can resolve
  // them at nested positions too.
  const canonicalTypeText = applyAliasesToTypeText(normalizedTypeText, aliases);
  return morphFallback(canonicalTypeText, 0, aliases);
}
