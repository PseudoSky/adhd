import { SCALAR_SCHEMAS } from './ts-json-schema'

/**
 * Recursive fallback schema builder for primitive, array, union, and anonymous object types.
 *
 * @param typeText  - The TypeScript type text to convert (already alias-normalised by the caller).
 * @param depth     - Recursion depth guard (max 6).
 * @param aliases   - Optional local-name → canonical-key alias map from `extractScalarAliases`.
 *                    When provided, bare local names (e.g. `D2`) are resolved to their canonical
 *                    SCALAR_SCHEMAS key before the lookup.  The caller (buildSchema) already
 *                    applies `applyAliasesToTypeText` to the top-level typeText, so aliases are
 *                    only needed here as a fallback for any residual non-canonical names that
 *                    survive deep inside the type text (e.g. union branches).
 */
export function morphFallback(
  typeText: string,
  depth: number,
  aliases?: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (depth > 6) return {}
  const t = typeText.trim()
  if (t === 'string') return { type: 'string' }
  if (t === 'number') return { type: 'number' }
  if (t === 'boolean') return { type: 'boolean' }
  if (t === 'null') return { type: 'null' }
  if (t === 'undefined') return { type: 'null' }

  // Consult SCALAR_SCHEMAS before any other check so that scalar types
  // (Date, bigint, Uint8Array, Buffer, URL, RegExp, Decimal) are recognised
  // at any nesting depth — e.g. the element type `Date` inside `Date[]`,
  // or the property value type `Date` inside `{ at: Date; label: string }`.
  const scalarSchema = SCALAR_SCHEMAS[t]
  if (scalarSchema !== undefined) return scalarSchema

  // Resolve alias: if the caller provided an alias map and the type text is a bare
  // alias name (e.g. `D2`), remap it to the canonical key and try SCALAR_SCHEMAS again.
  if (aliases?.size) {
    const canonical = aliases.get(t)
    if (canonical !== undefined) {
      const aliasedSchema = SCALAR_SCHEMAS[canonical]
      if (aliasedSchema !== undefined) return aliasedSchema
    }
  }

  if (t.endsWith('[]')) return { type: 'array', items: morphFallback(t.slice(0, -2), depth + 1, aliases) }
  if (t.includes('|')) {
    const variants = t.split('|').map(v => v.trim())
    // Check if all are string literals
    if (variants.every(v => v.startsWith("'"))) {
      return { type: 'string', enum: variants.map(v => v.replace(/'/g, '')) }
    }
    return { anyOf: variants.map(v => morphFallback(v, depth + 1, aliases)) }
  }
  // Anonymous object: { key: type; key2: type2 }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    const props: Record<string, unknown> = {}
    for (const part of inner.split(';').filter(Boolean)) {
      const [k, v] = part.split(':').map(s => s.trim())
      if (k && v) props[k.replace('?', '')] = morphFallback(v, depth + 1, aliases)
    }
    return { type: 'object', properties: props }
  }
  return {}  // unknown complex type — return empty schema
}
