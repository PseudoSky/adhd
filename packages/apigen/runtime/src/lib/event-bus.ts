import type { MiddlewareDef, MiddlewareEvent } from './types'

export class EventBus {
  private handlers: Map<string, Array<(event: MiddlewareEvent) => void | Promise<void>>> = new Map()

  on(selector: string, handler: (event: MiddlewareEvent) => void | Promise<void>): void {
    const existing = this.handlers.get(selector) ?? []
    this.handlers.set(selector, [...existing, handler])
  }

  async emit(event: MiddlewareEvent): Promise<void> {
    for (const [selector, handlers] of this.handlers) {
      if (matches(selector, event)) {
        for (const h of handlers) await h(event)
      }
    }
  }
}

function matches(selector: string, event: MiddlewareEvent): boolean {
  const [mod, method, lifecycle] = selector.split(':')
  if (mod !== '*' && mod !== event.module) return false
  if (method && method !== '*' && method !== event.method) return false
  if (lifecycle && lifecycle !== '*' && lifecycle !== event.lifecycle) return false
  return true
}

export function wireObservers(middlewares: readonly MiddlewareDef[], bus: EventBus): void {
  for (const mw of middlewares) {
    if (!mw.eventMapping) continue
    for (const [selector, handler] of Object.entries(mw.eventMapping)) {
      bus.on(selector, handler)
    }
  }
}
