import { describe, it, expect } from 'vitest'
import { composeSchemas } from '../lib/compose-schemas'
import type { GeneratedSchemas } from '../lib/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const domainSchemas: GeneratedSchemas = {
  metadata: { namespace: 'test', phase: '' },
  schemas: {
    getUser: {
      input: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
      output: { type: 'object' },
    },
    sendEmail: {
      input: {
        type: 'object',
        properties: { to: { type: 'string' }, subject: { type: 'string' } },
        required: ['to', 'subject'],
      },
      output: { type: 'null' },
    },
    listAll: {
      // zero params (ctx was the only param, filtered by generateSchemas)
      input: { type: 'object', properties: {}, required: [] },
      output: { type: 'array' },
    },
  },
}

const sessionMiddleware = { id: 'session', envelope: { session: { type: 'string' } } }
const authMiddleware = { id: 'auth', envelope: { token: { type: 'string' } } }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('composeSchemas', () => {
  it('[schema-composition.1] no middleware — data wrapper present; no other keys in properties', () => {
    const composed = composeSchemas(domainSchemas, [])

    for (const [fnName, schema] of Object.entries(composed)) {
      const input = schema.input as { type: string; properties: Record<string, unknown>; required: string[] }
      expect(input.properties, `${fnName} should only have "data" in properties`).toEqual(
        expect.objectContaining({ data: expect.any(Object) }),
      )
      expect(Object.keys(input.properties)).toEqual(['data'])
      expect(input.required).toContain('data')
      expect(input.required).toHaveLength(1)
    }
  })

  it('[schema-composition.2] session middleware — session and data both in required; domain params inside data', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware])

    const getUserInput = composed['getUser'].input as {
      properties: Record<string, unknown>
      required: string[]
    }

    expect(getUserInput.required).toContain('session')
    expect(getUserInput.required).toContain('data')

    const dataSchema = getUserInput.properties['data'] as {
      properties: Record<string, unknown>
      required: string[]
    }
    expect(dataSchema.properties['userId']).toBeDefined()
    expect(dataSchema.required).toContain('userId')
  })

  it('[schema-composition.3] override { getUser: { session: false } } — getUser loses session; sendEmail keeps it', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware], {
      getUser: { session: false },
    })

    const getUserInput = composed['getUser'].input as { properties: Record<string, unknown> }
    const sendEmailInput = composed['sendEmail'].input as { properties: Record<string, unknown> }

    expect(Object.keys(getUserInput.properties)).not.toContain('session')
    expect(Object.keys(sendEmailInput.properties)).toContain('session')
  })

  it('[schema-composition.4] zero-param function with session middleware — data in required; data.properties is {}', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware])

    const listAllInput = composed['listAll'].input as {
      properties: Record<string, unknown>
      required: string[]
    }

    expect(listAllInput.required).toContain('data')
    expect(listAllInput.required).toContain('session')

    const dataSchema = listAllInput.properties['data'] as { properties: Record<string, unknown> }
    expect(dataSchema.properties).toEqual({})
  })

  it('[schema-composition.5] multiple middlewares — both envelope fields appear when no overrides', () => {
    const composed = composeSchemas(domainSchemas, [sessionMiddleware, authMiddleware])

    const getUserInput = composed['getUser'].input as {
      properties: Record<string, unknown>
      required: string[]
    }

    expect(getUserInput.properties['session']).toBeDefined()
    expect(getUserInput.properties['token']).toBeDefined()
    expect(getUserInput.required).toContain('session')
    expect(getUserInput.required).toContain('token')
    expect(getUserInput.required).toContain('data')
  })

  it('[schema-composition.5] false is the ONLY value that suppresses; null/undefined do not', () => {
    // TypeScript won't allow null/undefined in the typed Record<string, boolean>,
    // but at runtime a caller could pass them — we test the runtime invariant.
    const composed = composeSchemas(
      domainSchemas,
      [sessionMiddleware],
      // cast to bypass strict type to test runtime behaviour
      { getUser: { session: null as unknown as boolean } },
    )

    const getUserInput = composed['getUser'].input as { properties: Record<string, unknown> }
    // null should NOT suppress — session must still be present
    expect(Object.keys(getUserInput.properties)).toContain('session')
  })
})
