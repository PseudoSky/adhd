import type { MiddlewareDef, MiddlewareEvent } from './types'

type EventHandler = (event: MiddlewareEvent) => void | Promise<void>

export class EventBus {
  private handlers: Map<string, EventHandler[]> = new Map()

  /**
   * Register a handler. Returns an unsubscribe function — handlers registered
   * per-request/per-package MUST be removed (via the returned fn, {@link off},
   * or {@link clear}) or they accumulate for the bus's lifetime.
   */
  on(selector: string, handler: EventHandler): () => void {
    const existing = this.handlers.get(selector) ?? []
    this.handlers.set(selector, [...existing, handler])
    return () => this.off(selector, handler)
  }

  /** Remove a previously registered handler (no-op if absent). */
  off(selector: string, handler: EventHandler): void {
    const existing = this.handlers.get(selector)
    if (!existing) return
    const next = existing.filter(h => h !== handler)
    if (next.length === 0) this.handlers.delete(selector)
    else this.handlers.set(selector, next)
  }

  /** Remove every handler — call on package/server teardown. */
  clear(): void {
    this.handlers.clear()
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
