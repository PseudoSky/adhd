/** Loose JSON-Schema property shape (only what we need for a human summary). */
interface SchemaProp {
  type?: string
  enum?: unknown[]
  $ref?: string
  items?: SchemaProp
  anyOf?: unknown[]
  oneOf?: unknown[]
}

export interface ParamInfo {
  name: string
  type: string
  required: boolean
}

function typeName(def: SchemaProp | undefined): string {
  if (!def) return 'unknown'
  if (def.type === 'array') return `${typeName(def.items)}[]`
  if (def.enum) return 'enum'
  if (def.$ref) return String(def.$ref).split('/').pop() || 'object'
  if (def.anyOf || def.oneOf) return 'union'
  return def.type ?? 'object'
}

/**
 * Extract a composed schema entry's domain parameters for logging.
 *
 * Params live under `input.properties.data.properties` — the `data` envelope
 * wrapper is always present (see [def:ComposedSchemas]). Returns both a
 * structured list (for JSON logs) and a `name?: type` summary string.
 */
export function describeParams(schema: { input?: unknown } | undefined): {
  params: ParamInfo[]
  text: string
} {
  const input = (schema?.input ?? {}) as {
    properties?: Record<
      string,
      { properties?: Record<string, SchemaProp>; required?: string[] }
    >
  }
  const data = input.properties?.['data']
  const props = (data?.properties ?? {}) as Record<string, SchemaProp>
  const required = new Set<string>(data?.required ?? [])
  const params: ParamInfo[] = Object.entries(props).map(([name, def]) => ({
    name,
    type: typeName(def),
    required: required.has(name),
  }))
  const text = params
    .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
    .join(', ')
  return { params, text }
}
