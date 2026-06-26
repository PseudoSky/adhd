/**
 * @adhd/apigen-schema — JSON Schema support for the apigen toolchain.
 *
 * Platform: shared (pure TypeScript, safe in Node and Browser).
 *
 * Currently a minimal package. The canonical type IR (JSON Schema 2020-12),
 * extraction, and the validation Layer live in @adhd/apigen-core and
 * @adhd/apigen-runtime. This package exposes schema-level utilities.
 */

export const __apigen_pkg = '@adhd/apigen-schema';

/**
 * The minimal shape of a JSON Schema object that apigen cares about.
 * A schema may declare a `type`, `properties`, and `required` list.
 */
export interface ApigenSchema {
  type?: string
  properties?: Record<string, ApigenSchema>
  required?: string[]
  items?: ApigenSchema
  [key: string]: unknown
}

/**
 * Returns true when the value looks like a JSON Schema object (plain object,
 * not null, not an array). This is a structural guard — it does not validate
 * against the full JSON Schema meta-schema.
 *
 * @example
 * isJsonSchema({ type: 'object' }) // true
 * isJsonSchema(null)               // false
 * isJsonSchema([])                 // false
 * isJsonSchema('string')           // false
 */
export function isJsonSchema(value: unknown): value is ApigenSchema {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  )
}

/**
 * Collect the names of all required properties declared in a schema's
 * top-level `required` array. Returns an empty array when the schema has no
 * `required` field or when `value` is not a valid schema object.
 */
export function requiredFields(schema: unknown): string[] {
  if (!isJsonSchema(schema)) return []
  const req = schema['required']
  if (!Array.isArray(req)) return []
  return req.filter((f): f is string => typeof f === 'string')
}

/**
 * Returns the `type` string declared on a schema, or `undefined` when absent.
 * Narrows to `string` so callers can compare without casting.
 */
export function schemaType(schema: unknown): string | undefined {
  if (!isJsonSchema(schema)) return undefined
  const t = schema['type']
  return typeof t === 'string' ? t : undefined
}
