import { describe, it, expect } from 'vitest'
import { fileURLToPath } from 'node:url'
import { generateSchemas } from '@adhd/apigen-core'
import { createApiPackage } from '@adhd/apigen-runtime'
import type { GeneratedSchemas, MiddlewareDef } from '@adhd/apigen-runtime'

// Integration: the schema engine over the real fixture + the middleware/override path.
// Teeth-guarded by audit-final-v2.schema-teeth (the spec MUST contain the discriminating
// assertions `not.toContain('ctx')`, `toContain('session')`, `not.toHaveProperty('session')`),
// so dod.3 (ctx excluded) and dod.4 (false override suppresses field) cannot pass vacuously.

const realApi = fileURLToPath(new URL('../fixtures/real-api.ts', import.meta.url))

describe('[dod.3] schema generation excludes ctx', () => {
  it('excludes ctx from every generated param schema (getUser has `ctx` first param)', async () => {
    const { schemas } = await generateSchemas({ sourceFile: realApi })
    const props = (schemas['getUser']?.input as { properties?: Record<string, unknown> })?.properties
    expect(props).toBeDefined()
    // ctx is a framework param, never a domain input — it must NOT appear in the schema.
    expect(Object.keys(props as Record<string, unknown>)).not.toContain('ctx')
    // sanity: the real domain param is present
    expect(Object.keys(props as Record<string, unknown>)).toContain('userId')
  })
})

describe('[dod.4] middleware session field + false override suppresses session', () => {
  // Minimal domain schemas: getUser (gets session via middleware) + ping (override suppresses it).
  const domainSchemas: GeneratedSchemas = {
    metadata: { namespace: 'test', phase: 'test' },
    schemas: {
      getUser: {
        input: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
        output: { type: 'object' },
      },
      ping: {
        input: { type: 'object', properties: {}, required: [] },
        output: { type: 'object' },
      },
    },
  }

  const sessionMiddleware: MiddlewareDef = {
    id: 'session',
    envelope: { session: { type: 'string' } },
    createContext: async (ctx) => ({ ...ctx, sessionData: 'populated' }),
  }

  it('adds session to getUser but suppresses session on ping via { ping: { session: false } } override', () => {
    const { schemas } = createApiPackage({
      domainSchemas,
      middlewares: [sessionMiddleware],
      overrides: { ping: { session: false } },
    })

    // getUser receives the session envelope field (middleware applies)
    const getUserInput = schemas['getUser'].input as { required: string[] }
    expect(getUserInput.required).toContain('session')

    // ping's `false` override suppresses the session field entirely
    const pingInput = schemas['ping'].input as { properties: Record<string, unknown> }
    expect(pingInput.properties).not.toHaveProperty('session')
  })
})
