import { describe, it, expect, vi } from 'vitest'
import { needsEnvelopeField, dataParamNames, dispatch } from '../lib/dispatch'

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
