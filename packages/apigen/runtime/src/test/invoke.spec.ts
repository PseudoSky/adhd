/**
 * Tests for the Layer harness (SPEC §8.1).
 *
 * Three behavioral proofs required by the guard:
 *   1. Short-circuit — a Layer returns without calling `next`; `next` is never invoked.
 *   2. Outward error propagation — a downstream throw is observed by an upstream Layer's catch.
 *   3. Typed-extension ctx — a value inserted by an outer Layer is visible in an inner Layer.
 */
import { describe, it, expect, vi } from 'vitest'
import { createInvoker, LayerContext } from '../lib/invoke'
import type { Layer, Call } from '../lib/invoke'
import type { ComposedSchemas } from '../lib/types'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal schema for a zero-param function — satisfies dispatch. */
const schemas: ComposedSchemas = {
  ping: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {} } },
      required: ['data'],
    },
    output: {},
  },
}

const pingFns = {
  ping: vi.fn().mockResolvedValue('pong'),
}

function makeCall(overrides?: Partial<Call>): Call {
  return {
    operation: { id: 'ping' },
    ctx: new LayerContext(),
    envelope: {},
    domainArgs: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// createInvoker — baseline (no layers)
// ---------------------------------------------------------------------------

describe('createInvoker — no layers', () => {
  it('calls dispatch directly and returns the result', async () => {
    const invoke = createInvoker([])
    const result = await invoke('ping', makeCall(), { fns: pingFns, schemas })
    expect(result).toBe('pong')
  })

  it('throws when fnName has no schema', async () => {
    const invoke = createInvoker([])
    await expect(
      invoke('missing', makeCall(), { fns: pingFns, schemas }),
    ).rejects.toThrow(/no schema found for operation "missing"/)
  })
})

// ---------------------------------------------------------------------------
// §8.1 rule 1 — Short-circuit
// ---------------------------------------------------------------------------

describe('§8.1 rule 1 — Short-circuit', () => {
  it('a Layer that returns without calling next skips dispatch entirely', async () => {
    const nextSpy = vi.fn()

    const shortCircuit: Layer = async (_call, _next) => {
      // Deliberately do NOT call _next — this is the short-circuit.
      return 'short-circuit-result'
    }

    // Wrap nextSpy so we can detect if dispatch or inner layers are reached.
    const sentinel: Layer = async (_call, next) => {
      nextSpy()
      return next()
    }

    const invoke = createInvoker([shortCircuit, sentinel])
    const result = await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(result).toBe('short-circuit-result')
    // The inner sentinel Layer (and therefore dispatch) must never have been reached.
    expect(nextSpy).not.toHaveBeenCalled()
  })

  it('short-circuit also prevents downstream Layers from seeing the call', async () => {
    const innerSeen = vi.fn()

    const guard: Layer = async (_call, _next) => 'guarded'
    const inner: Layer = async (call, next) => { innerSeen(call); return next() }

    const invoke = createInvoker([guard, inner])
    const result = await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(result).toBe('guarded')
    expect(innerSeen).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// §8.1 rule 2 — Outward error propagation
// ---------------------------------------------------------------------------

describe('§8.1 rule 2 — Outward error propagation', () => {
  it('an error thrown by a downstream Layer is observable in an upstream Layer catch', async () => {
    const downstreamError = new Error('downstream failure')
    const caughtErrors: unknown[] = []

    const upstream: Layer = async (_call, next) => {
      try {
        return await next()
      } catch (e) {
        caughtErrors.push(e)
        throw e  // re-throw so the outer caller also sees it
      }
    }

    const downstream: Layer = async (_call, _next) => {
      throw downstreamError
    }

    const invoke = createInvoker([upstream, downstream])

    await expect(invoke('ping', makeCall(), { fns: pingFns, schemas })).rejects.toThrow(
      'downstream failure',
    )

    // The upstream Layer's catch block must have observed the error.
    expect(caughtErrors).toHaveLength(1)
    expect(caughtErrors[0]).toBe(downstreamError)
  })

  it('a dispatch-level error also unwinds outward through all enclosing Layers', async () => {
    const dispatchError = new Error('dispatch-level error')
    const failingFns = {
      ping: vi.fn().mockRejectedValue(dispatchError),
    }

    const layer1Errors: unknown[] = []
    const layer2Errors: unknown[] = []

    const outer: Layer = async (_call, next) => {
      try { return await next() } catch (e) { layer1Errors.push(e); throw e }
    }
    const inner: Layer = async (_call, next) => {
      try { return await next() } catch (e) { layer2Errors.push(e); throw e }
    }

    const invoke = createInvoker([outer, inner])

    await expect(invoke('ping', makeCall(), { fns: failingFns, schemas })).rejects.toThrow(
      'dispatch-level error',
    )

    expect(layer1Errors[0]).toBe(dispatchError)
    expect(layer2Errors[0]).toBe(dispatchError)
  })

  it('an upstream Layer can catch and remap an error to a different type', async () => {
    class ApiError extends Error { constructor(msg: string) { super(msg); this.name = 'ApiError' } }

    const outer: Layer = async (_call, next) => {
      try {
        return await next()
      } catch (_e) {
        throw new ApiError('mapped')
      }
    }
    const inner: Layer = async (_call, _next) => { throw new Error('raw') }

    const invoke = createInvoker([outer, inner])

    await expect(invoke('ping', makeCall(), { fns: pingFns, schemas })).rejects.toBeInstanceOf(
      ApiError,
    )
  })
})

// ---------------------------------------------------------------------------
// §8.1 rule 3 — Typed-extension ctx
// ---------------------------------------------------------------------------

describe('§8.1 rule 3 — Typed-extension ctx', () => {
  it('a value inserted by an outer Layer is visible to an inner Layer via ctx.get', async () => {
    class RequestId { constructor(readonly value: string) {} }

    let seenId: string | undefined

    const outer: Layer = async (call, next) => {
      call.ctx.set(RequestId, new RequestId('req-abc'))
      return next()
    }

    const inner: Layer = async (call, next) => {
      seenId = call.ctx.get(RequestId)?.value
      return next()
    }

    const invoke = createInvoker([outer, inner])
    await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(seenId).toBe('req-abc')
  })

  it('symbol-keyed ctx values round-trip correctly', async () => {
    const AuthToken = Symbol('AuthToken')
    let observed: string | undefined

    const setter: Layer = async (call, next) => {
      call.ctx.set(AuthToken, 'tok-xyz')
      return next()
    }
    const reader: Layer = async (call, next) => {
      observed = call.ctx.get(AuthToken) as string
      return next()
    }

    const invoke = createInvoker([setter, reader])
    await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(observed).toBe('tok-xyz')
  })

  it('ctx.has returns true only after set', async () => {
    class Marker {}
    const results: boolean[] = []

    const checker: Layer = async (call, next) => {
      results.push(call.ctx.has(Marker))
      call.ctx.set(Marker, new Marker())
      results.push(call.ctx.has(Marker))
      return next()
    }

    const invoke = createInvoker([checker])
    await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(results).toEqual([false, true])
  })

  it('multiple Layers share the same ctx instance (not a copy)', async () => {
    class Counter { count = 0 }

    const a: Layer = async (call, next) => {
      call.ctx.set(Counter, new Counter())
      call.ctx.get(Counter)!.count++
      return next()
    }
    const b: Layer = async (call, next) => {
      call.ctx.get(Counter)!.count++
      return next()
    }
    const c: Layer = async (call, next) => {
      call.ctx.get(Counter)!.count++
      return next()
    }

    let finalCount: number | undefined
    const reader: Layer = async (call, next) => {
      finalCount = call.ctx.get(Counter)?.count
      return next()
    }

    const invoke = createInvoker([a, b, c, reader])
    await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(finalCount).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Composition order
// ---------------------------------------------------------------------------

describe('Layer composition order', () => {
  it('layers execute outermost-first (layers[0] wraps layers[1] wraps dispatch)', async () => {
    const order: string[] = []

    const makeOrderLayer = (name: string): Layer => async (_call, next) => {
      order.push(`${name}:before`)
      const r = await next()
      order.push(`${name}:after`)
      return r
    }

    const invoke = createInvoker([
      makeOrderLayer('A'),
      makeOrderLayer('B'),
      makeOrderLayer('C'),
    ])

    await invoke('ping', makeCall(), { fns: pingFns, schemas })

    expect(order).toEqual([
      'A:before',
      'B:before',
      'C:before',
      'C:after',
      'B:after',
      'A:after',
    ])
  })
})
