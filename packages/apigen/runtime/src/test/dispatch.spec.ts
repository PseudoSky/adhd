import { describe, it, expect, vi } from 'vitest'
import { needsEnvelopeField, dataParamNames, dispatch } from '../lib/dispatch'

// Schema for a function whose `at` param is a date-time wire value
const dateTimeInputSchema = {
  input: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          at: { type: 'string', format: 'date-time' },
        },
        required: ['at'],
      },
    },
    required: ['data'],
  },
  output: {},
}

// Schema for a function that returns a date-time
const dateTimeOutputSchema = {
  input: {
    type: 'object',
    properties: {
      data: { type: 'object', properties: {}, required: [] },
    },
    required: ['data'],
  },
  output: { type: 'string', format: 'date-time' },
}

// Schema for a function whose `label` param is a plain string (no format)
const plainStringSchema = {
  input: {
    type: 'object',
    properties: {
      data: {
        type: 'object',
        properties: {
          label: { type: 'string' },
        },
        required: ['label'],
      },
    },
    required: ['data'],
  },
  output: {},
}

// Schema with session middleware
const sessionSchema = {
  input: {
    type: 'object',
    properties: {
      session: { type: 'string' },
      data: { type: 'object', properties: { userId: { type: 'string' } }, required: ['userId'] },
    },
    required: ['session', 'data'],
  },
  output: {},
}

// Schema without session (no middleware)
const noSessionSchema = {
  input: {
    type: 'object',
    properties: {
      data: { type: 'object', properties: { to: { type: 'string' } }, required: ['to'] },
    },
    required: ['data'],
  },
  output: {},
}

// Schema for zero-param function
const zeroParamSchema = {
  input: {
    type: 'object',
    properties: { data: { type: 'object', properties: {} } },
    required: ['data'],
  },
  output: {},
}

describe('needsEnvelopeField', () => {
  it('returns true for session when schema has session', () => {
    expect(needsEnvelopeField(sessionSchema, 'session')).toBe(true)
  })

  it('returns false when schema has no session', () => {
    expect(needsEnvelopeField(noSessionSchema, 'session')).toBe(false)
  })
})

describe('dataParamNames', () => {
  it('returns ["userId"] for sessionSchema', () => {
    expect(dataParamNames(sessionSchema)).toEqual(['userId'])
  })

  it('returns ["to"] for noSessionSchema', () => {
    expect(dataParamNames(noSessionSchema)).toEqual(['to'])
  })

  it('returns [] for zeroParamSchema', () => {
    expect(dataParamNames(zeroParamSchema)).toEqual([])
  })
})

describe('dispatch', () => {
  it('calls fn directly when no session field', async () => {
    const fn = vi.fn().mockResolvedValue('result')
    const result = await dispatch({ sendEmail: fn }, undefined, noSessionSchema, 'sendEmail', {}, { to: 'a@b.com' })
    expect(fn).toHaveBeenCalledWith('a@b.com')
    expect(result).toBe('result')
  })

  it('calls createClient and passes ctx as first arg when session field present', async () => {
    const ctx = { db: 'mock-db' }
    const createClient = vi.fn().mockResolvedValue(ctx)
    const fn = vi.fn().mockResolvedValue({ id: '1' })
    await dispatch({ getUser: fn }, createClient, sessionSchema, 'getUser', { session: 'tok' }, { userId: '1' })
    expect(createClient).toHaveBeenCalledWith({ session: 'tok' })
    expect(fn).toHaveBeenCalledWith(ctx, '1')
  })

  it('calls fn with no args for zero-param function', async () => {
    const fn = vi.fn().mockResolvedValue([])
    await dispatch({ listAll: fn }, undefined, zeroParamSchema, 'listAll', {}, {})
    expect(fn).toHaveBeenCalledWith()
  })
})

// ---------------------------------------------------------------------------
// Logical-type decode/encode seam (DESIGN.md §4.4 / §6)
// ---------------------------------------------------------------------------

describe('dispatch — logical-type decode/encode', () => {
  const ISO = '2024-01-15T12:00:00.000Z'
  const EPOCH = new Date(ISO).getTime()

  it('[lt-1] date-time param: wire string → fn receives a real Date instance', async () => {
    // Consumer-visible outcome: the fn arg must be a Date with the correct epoch,
    // not the raw wire string. Negative control: remove the decode step and the
    // fn would receive a string — `instanceof Date` goes false, test goes red.
    let received: unknown
    const fn = vi.fn().mockImplementation((at: unknown) => {
      received = at
      return Promise.resolve(null)
    })

    await dispatch(
      { stamp: fn },
      undefined,
      dateTimeInputSchema,
      'stamp',
      {},
      { at: ISO },
    )

    expect(received).toBeInstanceOf(Date)
    expect((received as Date).getTime()).toBe(EPOCH)
  })

  it('[lt-2] Date return value: fn returns Date → dispatch returns RFC 3339 wire string', async () => {
    // Consumer-visible outcome: the result must be the canonical RFC 3339 UTC string,
    // not a Date object (which is not JSON-serialisable). Negative control: remove the
    // encode step and the result would be a Date object — the string-equality check fails.
    const fn = vi.fn().mockResolvedValue(new Date(ISO))

    const result = await dispatch(
      { now: fn },
      undefined,
      dateTimeOutputSchema,
      'now',
      {},
      {},
    )

    expect(typeof result).toBe('string')
    expect(result).toBe(ISO)
  })

  it('[lt-3] plain string param (no format): passes through untouched (schema-driven, not blanket-coercing)', async () => {
    // Proves decode is schema-driven: a `{type:string}` node has no codec → the
    // value must arrive at the fn unchanged. If decode were blanket-applied this
    // would attempt to parse the string as a Date and produce a wrong value.
    let received: unknown
    const fn = vi.fn().mockImplementation((label: unknown) => {
      received = label
      return Promise.resolve(null)
    })
    const label = 'hello-world'

    await dispatch(
      { greet: fn },
      undefined,
      plainStringSchema,
      'greet',
      {},
      { label },
    )

    expect(received).toBe(label)
    expect(received).not.toBeInstanceOf(Date)
  })
})
