import type { GeneratedSchemas, ComposedSchemas } from './types'

interface SlimMiddleware {
  id: string
  envelope?: Record<string, unknown>
}

/**
 * Merges domain schemas with middleware envelope fields.
 *
 * The `data: {}` wrapper is **always present** even for zero-param functions
 * [inv:data-wrapper-always-present]. Override a middleware with `false` to
 * suppress its envelope contribution for a specific function
 * [inv:false-suppresses-middleware].
 */
export function composeSchemas(
  domainSchemas: GeneratedSchemas,
  middlewares: ReadonlyArray<SlimMiddleware>,
  overrides?: Record<string, Record<string, boolean>>,
): ComposedSchemas {
  const result: ComposedSchemas = {}

  for (const [fnName, fnSchema] of Object.entries(domainSchemas.schemas)) {
    const fnOverrides = overrides?.[fnName] ?? {}

    const domainProperties = (fnSchema.input['properties'] ?? {}) as Record<string, unknown>
    const domainRequired = (fnSchema.input['required'] ?? []) as string[]

    // Collect envelope fragments from active middlewares.
    // Only `false` suppresses — null/undefined/0 do not [inv:false-suppresses-middleware].
    const envelopeProperties: Record<string, unknown> = {}
    const envelopeRequired: string[] = []

    for (const mw of middlewares) {
      if (!mw.envelope) continue
      if (fnOverrides[mw.id] === false) continue
      for (const [key, schema] of Object.entries(mw.envelope)) {
        envelopeProperties[key] = schema
        if (!envelopeRequired.includes(key)) envelopeRequired.push(key)
      }
    }

    // data: {} wrapper — always present, even for zero-param fns [inv:data-wrapper-always-present]
    const dataSchema: Record<string, unknown> = {
      type: 'object',
      properties: domainProperties,
      ...(domainRequired.length > 0 ? { required: domainRequired } : {}),
    }

    result[fnName] = {
      input: {
        type: 'object',
        properties: { ...envelopeProperties, data: dataSchema },
        required: [...envelopeRequired, 'data'],
      },
      output: fnSchema.output,
      // Carry the ctx-param flag through to dispatch (BUG-APIGEN-001).
      ...(fnSchema.hasCtx ? { hasCtx: true } : {}),
    }
  }

  return result
}
