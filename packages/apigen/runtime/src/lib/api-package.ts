import { composeSchemas } from '@adhd/apigen-core'
import type { MiddlewareDef, ApiPackageOptions, ApiPackageResult } from './types'
import { ConfigurationError } from './types'
import { EventBus, wireObservers } from './event-bus'
import { buildContext } from './build-context'

export function assertNoSelfSubscription(middlewares: readonly MiddlewareDef[]): void {
  for (const mw of middlewares) {
    for (const selector of Object.keys(mw.eventMapping ?? {})) {
      const [module] = selector.split(':')
      if (module !== '*' && module === mw.id) {
        throw new ConfigurationError(
          `Middleware "${mw.id}" subscribes to its own events via "${selector}". ` +
          `This would cause infinite recursion.`
        )
      }
    }
  }
}

export function createApiPackage<M extends readonly MiddlewareDef[]>(
  options: ApiPackageOptions<M>
): ApiPackageResult {
  const { domainSchemas, middlewares, overrides = {}, strict = false } = options

  // Startup validation
  assertNoSelfSubscription(middlewares)

  // Validate override keys exist in domainSchemas
  for (const fnKey of Object.keys(overrides)) {
    if (!(fnKey in domainSchemas.schemas)) {
      const msg = `Override key "${fnKey}" not found in domain schemas.`
      if (strict) throw new ConfigurationError(msg)
      else console.warn('[apigen-runtime]', msg)
    }
  }

  // Validate middleware ids in override values
  const mwIds = new Set(middlewares.map(m => m.id))
  for (const [fnKey, fnOverride] of Object.entries(overrides)) {
    for (const mwId of Object.keys(fnOverride ?? {})) {
      if (!mwIds.has(mwId)) {
        const msg = `Override key "${fnKey}.${mwId}" does not match any declared middleware id.`
        if (strict) throw new ConfigurationError(msg)
        else console.warn('[apigen-runtime]', msg)
      }
    }
  }

  const schemas = composeSchemas(
    domainSchemas,
    middlewares as unknown as Array<{ id: string; envelope?: Record<string, unknown> }>,
    overrides as Record<string, Record<string, boolean>>
  )

  const bus = new EventBus()
  wireObservers(middlewares, bus)

  const createClient = async (envelope: Record<string, unknown>): Promise<object> => {
    return buildContext(middlewares, envelope, bus)
  }

  return { schemas, createClient }
}
