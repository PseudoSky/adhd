import type { GeneratedSchemas, ComposedSchemas } from '@adhd/apigen-core'

export type { GeneratedSchemas, ComposedSchemas }

export interface MiddlewareDef<
  TEnvelope extends object = object,
  TContext extends object = object
> {
  id: string
  envelope?: Record<string, unknown>
  createContext?: (ctx: object) => TContext | Promise<TContext>
  eventMapping?: Record<string, (event: MiddlewareEvent) => void | Promise<void>>
}

export interface MiddlewareEvent {
  module: string
  method: string
  lifecycle: 'start' | 'complete' | 'error'
  ctx: object
  error?: unknown
}

export interface ApiPackageOptions<M extends readonly MiddlewareDef[]> {
  domainSchemas: GeneratedSchemas
  middlewares: readonly [...M]
  overrides?: Partial<Record<string, Partial<Record<string, boolean>>>>
  strict?: boolean
}

export interface ApiPackageResult {
  schemas: ComposedSchemas
  createClient: (envelope: Record<string, unknown>) => Promise<object>
  /**
   * Release the package's event bus (removes every observer handler). Call
   * when the package is discarded — hosts that create packages repeatedly
   * (tests, hot reload, multi-tenant servers) leak handlers otherwise.
   */
  dispose: () => void
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}
