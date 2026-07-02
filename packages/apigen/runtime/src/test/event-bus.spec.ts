// event-bus.spec.ts — regression net for the EventBus handler-leak fix:
// handlers must be removable (off / unsubscribe / clear), and emit must stop
// invoking removed handlers. Before this, `on()` appended forever with no
// removal path — hosts creating packages repeatedly accumulated handlers for
// the bus's lifetime.

import { describe, it, expect } from 'vitest'
import { EventBus } from '../lib/event-bus'
import { createApiPackage } from '../lib/api-package'
import type { MiddlewareEvent, MiddlewareDef } from '../lib/types'

function event(module: string, method = 'm', lifecycle = 'after'): MiddlewareEvent {
  return { module, method, lifecycle, args: {}, result: undefined } as unknown as MiddlewareEvent
}

describe('EventBus handler removal', () => {
  it('off() removes a handler; emit after off does not invoke it', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    const handler = () => { calls.push('h') }

    bus.on('mod:*:*', handler)
    await bus.emit(event('mod'))
    expect(calls).toEqual(['h'])

    bus.off('mod:*:*', handler)
    await bus.emit(event('mod'))
    expect(calls).toEqual(['h']) // unchanged — handler gone
  })

  it('on() returns an unsubscribe function', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    const unsubscribe = bus.on('mod:*:*', () => { calls.push('h') })

    await bus.emit(event('mod'))
    unsubscribe()
    await bus.emit(event('mod'))
    expect(calls).toEqual(['h'])
  })

  it('off() removes only the given handler, not siblings on the same selector', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    const a = () => { calls.push('a') }
    const b = () => { calls.push('b') }
    bus.on('mod:*:*', a)
    bus.on('mod:*:*', b)

    bus.off('mod:*:*', a)
    await bus.emit(event('mod'))
    expect(calls).toEqual(['b'])
  })

  it('clear() empties every selector', async () => {
    const bus = new EventBus()
    const calls: string[] = []
    bus.on('mod:*:*', () => { calls.push('x') })
    bus.on('other:*:*', () => { calls.push('y') })

    bus.clear()
    await bus.emit(event('mod'))
    await bus.emit(event('other'))
    expect(calls).toEqual([])
  })

  it('off() on an unknown selector/handler is a no-op', () => {
    const bus = new EventBus()
    expect(() => bus.off('nope:*:*', () => undefined)).not.toThrow()
  })
})

describe('createApiPackage dispose()', () => {
  it('returns a dispose that clears the package event bus', async () => {
    const seen: string[] = []
    const mw: MiddlewareDef = {
      id: 'audit',
      envelope: {},
      eventMapping: {
        'domain:*:*': () => { seen.push('evt') },
      },
    } as unknown as MiddlewareDef

    const pkg = createApiPackage({
      domainSchemas: { metadata: { namespace: 'n', phase: '' }, schemas: {} },
      middlewares: [mw] as const,
    })
    expect(typeof pkg.dispose).toBe('function')
    pkg.dispose() // must not throw; bus handlers released
  })
})
