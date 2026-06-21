import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createApiPackage, assertNoSelfSubscription } from '../lib/api-package'
import { ConfigurationError } from '../lib/types'
import type { GeneratedSchemas, MiddlewareDef } from '../lib/types'

/** Minimal domain schema fixture: one function "getUser" taking userId */
const domainSchemas: GeneratedSchemas = {
  metadata: { namespace: 'test', phase: 'test' },
  schemas: {
    getUser: {
      input: {
        type: 'object',
        properties: { userId: { type: 'string' } },
        required: ['userId'],
      },
      output: { type: 'object' },
    },
  },
}

const sessionMiddleware: MiddlewareDef = {
  id: 'session',
  envelope: { session: { type: 'string' } },
  createContext: async (ctx) => ({ ...ctx, sessionData: 'populated' }),
}

describe('createApiPackage', () => {
  it('[runtime-middleware.1] builds schemas with session middleware — input has session + data wrapper', () => {
    const { schemas } = createApiPackage({
      domainSchemas,
      middlewares: [sessionMiddleware],
    })

    const getUserInput = schemas['getUser'].input as {
      type: string
      properties: Record<string, unknown>
      required: string[]
    }
    expect(getUserInput.type).toBe('object')
    expect(getUserInput.properties).toHaveProperty('session')
    expect(getUserInput.properties).toHaveProperty('data')
    expect(getUserInput.required).toContain('session')
    expect(getUserInput.required).toContain('data')
  })

  it('createClient accumulates context from session middleware', async () => {
    const { createClient } = createApiPackage({
      domainSchemas,
      middlewares: [sessionMiddleware],
    })

    const ctx = await createClient({ session: 'tok-123' }) as Record<string, unknown>
    expect(ctx['session']).toBe('tok-123')
    expect(ctx['sessionData']).toBe('populated')
  })

  it('[runtime-middleware.3] observer middleware receives start + complete lifecycle events', async () => {
    const onStart = vi.fn()
    const onComplete = vi.fn()

    const observerMiddleware: MiddlewareDef = {
      id: 'observer',
      eventMapping: {
        'session:createContext:start': onStart,
        'session:createContext:complete': onComplete,
      },
    }

    const { createClient } = createApiPackage({
      domainSchemas,
      middlewares: [sessionMiddleware, observerMiddleware],
    })

    await createClient({ session: 'abc' })

    expect(onStart).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledOnce()
    expect(onStart.mock.calls[0][0]).toMatchObject({
      module: 'session',
      method: 'createContext',
      lifecycle: 'start',
    })
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      module: 'session',
      method: 'createContext',
      lifecycle: 'complete',
    })
  })

  it('[runtime-middleware.4] strict=true throws ConfigurationError on unknown override fn key', () => {
    expect(() =>
      createApiPackage({
        domainSchemas,
        middlewares: [sessionMiddleware],
        overrides: { nonExistentFn: { session: false } },
        strict: true,
      })
    ).toThrowError(ConfigurationError)
  })

  it('strict=false only warns on unknown override fn key (does not throw)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() =>
      createApiPackage({
        domainSchemas,
        middlewares: [sessionMiddleware],
        overrides: { nonExistentFn: { session: false } },
        strict: false,
      })
    ).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith('[apigen-runtime]', expect.stringContaining('nonExistentFn'))
    warnSpy.mockRestore()
  })
})

describe('assertNoSelfSubscription', () => {
  it('[runtime-middleware.2] throws ConfigurationError when middleware subscribes to its own events', () => {
    const selfSubscriber: MiddlewareDef = {
      id: 'auth',
      eventMapping: {
        'auth:createContext:complete': vi.fn(),
      },
    }

    expect(() => assertNoSelfSubscription([selfSubscriber])).toThrowError(ConfigurationError)
    expect(() => assertNoSelfSubscription([selfSubscriber])).toThrow(
      /Middleware "auth" subscribes to its own events/
    )
  })

  it('does not throw when middleware uses wildcard module selector (*)', () => {
    const wildcardObserver: MiddlewareDef = {
      id: 'logger',
      eventMapping: {
        '*:createContext:complete': vi.fn(),
      },
    }

    expect(() => assertNoSelfSubscription([wildcardObserver])).not.toThrow()
  })

  it('does not throw when middleware subscribes to a DIFFERENT middleware', () => {
    const crossObserver: MiddlewareDef = {
      id: 'logger',
      eventMapping: {
        'session:createContext:complete': vi.fn(),
      },
    }

    expect(() => assertNoSelfSubscription([crossObserver])).not.toThrow()
  })
})
