/**
 * Tests for the central validation Layer (SPEC §6).
 *
 * Three behavioral proofs required by the guard:
 *
 *  1. PASS-THROUGH   — valid input passes through to dispatch (next is called).
 *  2. SHORT-CIRCUIT  — malformed input short-circuits with ApiError{invalid_argument};
 *                      dispatch is NEVER called (negative-control latch proves it).
 *  3. NECESSARY-NOT-SUFFICIENT — a value that is schema-valid but semantically
 *                      wrong (e.g. negative age when only non-negative makes sense)
 *                      still passes the validator, confirming the §6 boundary:
 *                      validation is a shape pre-filter, not a domain correctness
 *                      guarantee.  The authoritative boundary is the host's typed
 *                      dispatch (SPEC §6, §2).
 */
import { describe, it, expect, vi } from 'vitest'
import { createInvoker, LayerContext } from '../lib/invoke'
import { makeValidateLayer } from '../lib/validate-layer'
import { ApiError } from '@adhd/apigen-errors'
import type { Call } from '../lib/invoke'
import type { ComposedSchemas } from '../lib/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A schema for a function that takes `{ data: { name: string; age: number } }`.
 *
 * The `data` wrapper is always present in ComposedSchemas (inv:data-wrapper-always-present).
 */
const schemas: ComposedSchemas = {
  createUser: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
          required: ['name', 'age'],
          additionalProperties: false,
        },
      },
      required: ['data'],
    },
    output: {},
  },
  ping: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {} },
      },
      required: ['data'],
    },
    output: {},
  },
}

/** Stub fns that must NEVER be called in short-circuit scenarios. */
const dispatchFns = {
  createUser: vi.fn().mockResolvedValue({ id: '1' }),
  ping: vi.fn().mockResolvedValue('pong'),
}

function makeCall(overrides?: Partial<Call>): Call {
  return {
    operation: { id: 'createUser' },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. PASS-THROUGH: valid input reaches dispatch
// ---------------------------------------------------------------------------

describe('validateLayer — pass-through (valid input)', () => {
  it('delegates to next when domainArgs satisfy the schema', async () => {
    const nextSpy = vi.fn().mockResolvedValue({ id: '1' })

    const validationLayer = makeValidateLayer(schemas)
    const call = makeCall({
      operation: { id: 'createUser' },
      domainArgs: { name: 'Alice', age: 30 },
    })

    await validationLayer(call, nextSpy)

    // next was called — validation passed through
    expect(nextSpy).toHaveBeenCalledOnce()
  })

  it('returns the dispatch result when validation passes', async () => {
    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'createUser' },
      domainArgs: { name: 'Bob', age: 25 },
    })

    dispatchFns.createUser.mockResolvedValueOnce({ id: '42' })

    const result = await invoke('createUser', call, { fns: dispatchFns, schemas })

    expect(result).toEqual({ id: '42' })
  })

  it('passes a zero-param operation through without error', async () => {
    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'ping' },
      domainArgs: {},
    })

    const result = await invoke('ping', call, { fns: dispatchFns, schemas })
    expect(result).toBe('pong')
  })
})

// ---------------------------------------------------------------------------
// 2. SHORT-CIRCUIT: malformed input — dispatch NEVER called (latch proof)
// ---------------------------------------------------------------------------

describe('validateLayer — short-circuit (malformed input)', () => {
  it('throws ApiError{invalid_argument} when a required field is missing', async () => {
    const dispatchSpy = vi.fn().mockResolvedValue({ id: '1' })
    const localFns = { createUser: dispatchSpy, ping: vi.fn() }

    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'createUser' },
      // `age` is missing — schema requires it
      domainArgs: { name: 'Alice' },
    })

    await expect(invoke('createUser', call, { fns: localFns, schemas })).rejects.toMatchObject({
      code: 'invalid_argument',
    })
    await expect(invoke('createUser', call, { fns: localFns, schemas })).rejects.toBeInstanceOf(
      ApiError,
    )

    // NEGATIVE-CONTROL LATCH: dispatch must have been called 0 times in the
    // two failing invocations above.  Vitest call count accumulates — both
    // calls threw before reaching dispatch, so count is still 0.
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('throws ApiError{invalid_argument} when a field has the wrong type', async () => {
    const dispatchSpy = vi.fn().mockResolvedValue({ id: '1' })
    const localFns = { createUser: dispatchSpy, ping: vi.fn() }

    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'createUser' },
      // `age` must be a number, not a string
      domainArgs: { name: 'Alice', age: 'not-a-number' },
    })

    const err = await invoke('createUser', call, { fns: localFns, schemas }).catch((e) => e)

    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('invalid_argument')

    // NEGATIVE-CONTROL LATCH: dispatch was never reached.
    expect(dispatchSpy).not.toHaveBeenCalled()
  })

  it('short-circuit prevents additional layers from executing (§8.1 rule 1)', async () => {
    const innerLayerSpy = vi.fn().mockImplementation(async (_call: Call, next: () => Promise<unknown>) => next())

    const invoke = createInvoker([
      makeValidateLayer(schemas), // outermost — will short-circuit
      innerLayerSpy,              // must never be reached
    ])

    const call = makeCall({
      operation: { id: 'createUser' },
      domainArgs: {}, // missing both required fields
    })

    await expect(invoke('createUser', call, { fns: dispatchFns, schemas })).rejects.toBeInstanceOf(
      ApiError,
    )

    // Inner layer was never called.
    expect(innerLayerSpy).not.toHaveBeenCalled()
  })

  it('the ApiError message names at least one failing path', async () => {
    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'createUser' },
      domainArgs: { name: 42, age: 'bad' }, // both wrong types
    })

    const err: ApiError = await invoke('createUser', call, { fns: dispatchFns, schemas }).catch(
      (e) => e,
    )

    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toMatch(/Validation failed/)
    // At least one AJV error detail is surfaced
    expect(Array.isArray(err.details)).toBe(true)
    expect((err.details as unknown[]).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 3. NECESSARY-NOT-SUFFICIENT: schema-valid but domain-wrong values pass
// ---------------------------------------------------------------------------

describe('validateLayer — necessary-not-sufficient (§6 boundary)', () => {
  /**
   * A negative age is schema-valid (it is a number) but domain-wrong (an age
   * cannot be negative in a real system).  The validator MUST let it through —
   * domain rules are enforced at the typed-dispatch boundary (SPEC §6, §2),
   * not in this Layer.
   *
   * If this test fails (validator rejects the negative age), it means the Layer
   * is over-reaching into domain territory, violating the §6 boundary.
   */
  it('accepts a schema-valid but domain-wrong value (negative age) — shape-only boundary', async () => {
    const dispatchSpy = vi.fn().mockResolvedValue({ id: '99' })
    const localFns = { createUser: dispatchSpy, ping: vi.fn() }

    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'createUser' },
      // Age -1 is a valid number per JSON Schema but nonsensical as a domain value.
      domainArgs: { name: 'Eve', age: -1 },
    })

    // Must NOT throw — validation passes because the schema says `type: number`.
    const result = await invoke('createUser', call, { fns: localFns, schemas })

    expect(result).toEqual({ id: '99' })
    // dispatch WAS called, proving validation did not block it
    expect(dispatchSpy).toHaveBeenCalledOnce()
  })

  /**
   * A future date string where a number is expected: schema-valid (it is a
   * string that matches no format constraint) would be caught, but a numeric
   * string that JS coerces — that depends on the schema.  Here we prove that
   * an empty-string name, which JSON Schema `{ type: 'string' }` accepts,
   * passes the validator even though domain logic might reject it.
   */
  it('accepts a schema-valid empty-string name — shape-only boundary', async () => {
    const dispatchSpy = vi.fn().mockResolvedValue({ id: '100' })
    const localFns = { createUser: dispatchSpy, ping: vi.fn() }

    const invoke = createInvoker([makeValidateLayer(schemas)])
    const call = makeCall({
      operation: { id: 'createUser' },
      // Empty string is a valid string per JSON Schema even if domain forbids it.
      domainArgs: { name: '', age: 25 },
    })

    const result = await invoke('createUser', call, { fns: localFns, schemas })

    expect(result).toEqual({ id: '100' })
    expect(dispatchSpy).toHaveBeenCalledOnce()
  })
})
