import type { ComposedSchemas } from './types'

/** Returns true when the composed schema has `field` in input.properties (i.e. an envelope field). */
export function needsEnvelopeField(
  fnSchema: ComposedSchemas[string],
  field: string,
): boolean {
  const props = (fnSchema.input as Record<string, unknown>)?.['properties'] as Record<string, unknown> ?? {}
  return field in props
}

/** Returns ordered domain parameter names (keys of the data: {} sub-object). */
export function dataParamNames(fnSchema: ComposedSchemas[string]): string[] {
  const data = ((fnSchema.input as Record<string, unknown>)?.['properties'] as Record<string, unknown>)?.['data'] as Record<string, unknown> | undefined
  return Object.keys((data?.['properties'] as Record<string, unknown>) ?? {})
}

/**
 * Single canonical dispatch path used by ALL plugins in both generate and run modes.
 * No plugin may inline this logic. [inv:dispatch-single-path]
 */
export async function dispatch(
  fns: Record<string, (...args: unknown[]) => unknown>,
  createClient: ((e: Record<string, unknown>) => Promise<unknown>) | undefined,
  schema: ComposedSchemas[string],
  fnName: string,
  envelope: Record<string, unknown>,
  domainArgs: Record<string, unknown>,
): Promise<unknown> {
  const paramNames = dataParamNames(schema)
  const args = paramNames.map(k => domainArgs[k])

  // Session middleware: build ctx from the session envelope and inject it as the
  // first arg. Preserves [dod.4] envelope behavior.
  if (needsEnvelopeField(schema, 'session') && createClient) {
    const ctx = await createClient({ session: envelope['session'] })
    return (fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown)(ctx, ...args)
  }

  // ctx-param fn WITHOUT session middleware (BUG-APIGEN-001): the source fn's
  // first param is named `ctx` ([inv:ctx-name-only]), so it must still receive a
  // first arg or the first DOMAIN arg lands in the ctx slot. Build ctx via
  // createClient when a client exists, else pass undefined (the fn may ignore it).
  if (schema.hasCtx) {
    const ctx = createClient ? await createClient(envelope) : undefined
    return (fns[fnName] as (ctx: unknown, ...a: unknown[]) => unknown)(ctx, ...args)
  }

  return fns[fnName](...args)
}
