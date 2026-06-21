import type { MiddlewareDef } from './types'
import type { EventBus } from './event-bus'

export async function buildContext(
  middlewares: readonly MiddlewareDef[],
  envelope: Record<string, unknown>,
  bus: EventBus,
): Promise<object> {
  let ctx: object = { ...envelope }
  for (const mw of middlewares) {
    if (!mw.createContext) continue
    await bus.emit({ module: mw.id, method: 'createContext', lifecycle: 'start', ctx })
    try {
      const contribution = await mw.createContext(ctx)
      ctx = { ...ctx, ...contribution }
      await bus.emit({ module: mw.id, method: 'createContext', lifecycle: 'complete', ctx })
    } catch (error) {
      await bus.emit({ module: mw.id, method: 'createContext', lifecycle: 'error', ctx, error })
      throw error
    }
  }
  return ctx
}
