import { createGenerator, type Config } from 'ts-json-schema-generator'
import type { Project, SourceFile } from 'ts-morph'
import { morphFallback } from './morph-fallback'

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
 * NOTE on Decimal: ts-morph emits two distinct type-text strings for the same
 * Decimal class depending on how the user imports it:
 *   - `import { Decimal } from 'decimal.js'`  → `"Decimal"`  (keyed directly below)
 *   - `import Decimal from 'decimal.js'`       → qualified import path like
 *     `import("/path/to/decimal.js/decimal").default`
 * Both are normalised to the "Decimal" key in `buildSchema` before this map is
 * consulted — see `normalizeTypeText`.
 */
const SCALAR_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  Date:       { type: 'string', format: 'date-time' },
  bigint:     { type: 'string', format: 'int64' },
  Uint8Array: { type: 'string', format: 'byte' },
  Buffer:     { type: 'string', format: 'byte' },
  URL:        { type: 'string', format: 'uri' },
  RegExp:     { type: 'string', format: 'regex' },
  Decimal:    { type: 'string', format: 'decimal' },
}

/**
 * Normalise the raw type-text emitted by ts-morph before consulting
 * {@link SCALAR_SCHEMAS} and before delegating to ts-json-schema-generator /
 * morphFallback.
 *
 * Two categories of normalisation are applied (in order):
 *
 * 1. **Decimal import path** — ts-morph emits a fully-qualified import expression
 *    for default-imported external types, e.g.:
 *      `import("/abs/path/to/node_modules/decimal.js/decimal").default`
 *    This is the same Decimal class as a named `{ Decimal }` import (which
 *    ts-morph represents as the bare string `"Decimal"`). We normalise the
 *    qualified form to `"Decimal"` so both reach the same SCALAR_SCHEMAS entry.
 *    The pattern anchors on the module path containing `decimal.js` and the
 *    exported binding being `.default` — the canonical shape of
 *    `import Decimal from 'decimal.js'` in a ts-morph Project that lacks a
 *    tsconfig (skipAddingFilesFromTsConfig=true).
 *
 * 2. **Readonly array forms** — ts-morph emits `readonly T[]` for both
 *    `readonly T[]` and `ReadonlyArray<T>` parameter annotations. The
 *    `readonly` modifier is irrelevant to JSON-Schema generation (arrays are
 *    always structurally equivalent regardless of mutability). Stripping it
 *    before item-type resolution ensures morphFallback can match the trailing
 *    `[]` suffix and recurse into the element type correctly.
 *      `readonly string[]`  → `string[]`
 *      `ReadonlyArray<string>` → `string[]`   (ts-morph already emits the
 *                                              former, but guard both)
 *    Nested forms are handled recursively by morphFallback itself (e.g.
 *    `readonly (readonly string[])[]` normalises to `(readonly string[])[]`
 *    then morphFallback recurses and this function is NOT called again — that
 *    edge case is handled below by a loop).
 */
function normalizeTypeText(typeText: string): string {
  let t = typeText.trim()

  // 1. Decimal qualified import  →  'Decimal'
  if (/^import\(["'][^"']*decimal\.js[^"']*["']\)\.default$/.test(t)) {
    return 'Decimal'
  }

  // 2a. ReadonlyArray<T>  →  T[]
  //     Handles the generic form directly (ts-morph usually normalises to
  //     "readonly T[]" already, but guard the generic spelling too).
  const readonlyArrayMatch = t.match(/^ReadonlyArray<(.+)>$/)
  if (readonlyArrayMatch) {
    t = `${readonlyArrayMatch[1].trim()}[]`
  }

  // 2b. readonly T[]  →  T[]
  //     Strip the leading "readonly " keyword.  Apply in a loop so that
  //     nested readonly arrays (e.g. "readonly readonly string[]") are also
  //     fully stripped, even though ts-morph doesn't emit those in practice.
  while (t.startsWith('readonly ')) {
    t = t.slice('readonly '.length).trim()
  }

  return t
}

/** Attempts ts-json-schema-generator first; falls back to morphFallback for inline/anonymous types. */
export async function buildSchema(
  _project: Project,
  sf: SourceFile,
  typeText: string,
  tsconfig?: string
): Promise<Record<string, unknown>> {
  if (['void', 'undefined', 'null', 'Promise<void>'].includes(typeText)) return { type: 'null' }

  // Normalise the type text before the SCALAR_SCHEMAS lookup so that
  // default-imported external types (e.g. `import Decimal from 'decimal.js'`
  // which ts-morph emits as `import("...decimal.js/decimal").default`) are
  // mapped to their canonical key first.
  const normalizedTypeText = normalizeTypeText(typeText)

  // Resolve well-known built-in TS scalar types to their canonical logical-type schemas
  // BEFORE delegating to ts-json-schema-generator (which emits {} for most of these).
  // Per §4.1 [inv:hints-advisory]: structure (format) is authoritative; no x-apigen-* needed here.
  const scalarSchema = SCALAR_SCHEMAS[normalizedTypeText]
  if (scalarSchema !== undefined) return scalarSchema

  try {
    const config: Config = { path: sf.getFilePath(), type: normalizedTypeText, skipTypeCheck: true, tsconfig }
    const schema = createGenerator(config).createSchema(normalizedTypeText)
    return schema as Record<string, unknown>
  } catch {
    return morphFallback(normalizedTypeText, 0)
  }
}
