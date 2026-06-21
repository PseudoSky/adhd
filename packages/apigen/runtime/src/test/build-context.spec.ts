import { describe, it, expect, vi } from 'vitest'
import { buildContext } from '../lib/build-context'
import { EventBus } from '../lib/event-bus'
import type { MiddlewareDef } from '../lib/types'

describe('buildContext', () => {
  it('[runtime-middleware.5] sequential accumulation — second middleware sees first middleware contribution', async () => {
    const firstMw: MiddlewareDef = {
      id: 'first',
      createContext: async (_ctx) => ({ fromFirst: 'value-from-first' }),
    }
    const secondMw: MiddlewareDef = {
      id: 'second',
      createContext: async (ctx) => {
        const record = ctx as Record<string, unknown>
        return { fromSecond: `saw:${record['fromFirst']}` }
      },
    }

    const bus = new EventBus()
    const result = await buildContext([firstMw, secondMw], {}, bus) as Record<string, unknown>

    expect(result['fromFirst']).toBe('value-from-first')
    expect(result['fromSecond']).toBe('saw:value-from-first')
  })

  it('error in createContext triggers error lifecycle event and re-throws', async () => {
    const errorHandler = vi.fn()
    const bus = new EventBus()
    bus.on('faulty:createContext:error', errorHandler)

    const faultyMw: MiddlewareDef = {
      id: 'faulty',
      createContext: async () => {
        throw new Error('context build failed')
      },
    }

    await expect(buildContext([faultyMw], {}, bus)).rejects.toThrow('context build failed')
    expect(errorHandler).toHaveBeenCalledOnce()
    expect(errorHandler.mock.calls[0][0]).toMatchObject({
      module: 'faulty',
      method: 'createContext',
      lifecycle: 'error',
    })
    expect((errorHandler.mock.calls[0][0] as { error: Error }).error.message).toBe('context build failed')
  })

  it('observer-only middleware (no createContext) does not block other middlewares', async () => {
    const observerMw: MiddlewareDef = {
      id: 'observer',
      // no createContext — event-mapping only
      eventMapping: {
        'producer:createContext:complete': vi.fn(),
      },
    }
    const producerMw: MiddlewareDef = {
      id: 'producer',
      createContext: async () => ({ produced: true }),
    }

    const bus = new EventBus()
    const result = await buildContext([observerMw, producerMw], {}, bus) as Record<string, unknown>

    expect(result['produced']).toBe(true)
  })
})
