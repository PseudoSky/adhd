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
 *
 * Map / Set / Decimal are handled in later states (lt-extract-nominal / lt-scalars).
 */
const SCALAR_SCHEMAS: Readonly<Record<string, Record<string, unknown>>> = {
  Date:       { type: 'string', format: 'date-time' },
  bigint:     { type: 'string', format: 'int64' },
  Uint8Array: { type: 'string', format: 'byte' },
  Buffer:     { type: 'string', format: 'byte' },
  URL:        { type: 'string', format: 'uri' },
  RegExp:     { type: 'string', format: 'regex' },
}

/** Attempts ts-json-schema-generator first; falls back to morphFallback for inline/anonymous types. */
export async function buildSchema(
  _project: Project,
  sf: SourceFile,
  typeText: string,
  tsconfig?: string
): Promise<Record<string, unknown>> {
  if (['void', 'undefined', 'null', 'Promise<void>'].includes(typeText)) return { type: 'null' }

  // Resolve well-known built-in TS scalar types to their canonical logical-type schemas
  // BEFORE delegating to ts-json-schema-generator (which emits {} for most of these).
  // Per §4.1 [inv:hints-advisory]: structure (format) is authoritative; no x-apigen-* needed here.
  const scalarSchema = SCALAR_SCHEMAS[typeText.trim()]
  if (scalarSchema !== undefined) return scalarSchema

  try {
    const config: Config = { path: sf.getFilePath(), type: typeText, skipTypeCheck: true, tsconfig }
    const schema = createGenerator(config).createSchema(typeText)
    return schema as Record<string, unknown>
  } catch {
    return morphFallback(typeText, 0)
  }
}
