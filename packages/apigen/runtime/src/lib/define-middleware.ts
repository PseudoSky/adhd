import type { MiddlewareDef } from './types'

export function defineMiddleware<
  TId extends string,
  TEnvelope extends object,
  TContext extends object
>(def: MiddlewareDef<TEnvelope, TContext> & { id: TId }): typeof def {
  return def
}
