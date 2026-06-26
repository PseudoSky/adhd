import { describe, it, expect } from 'vitest'
import { healthPlugin } from '../lib/plugin'
import type { HealthResponse } from '../lib/plugin'
import type { Descriptor, Operation, Extensions } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleDescriptor: Descriptor = {
  host: 'ts',
  namespace: 'test-api',
  operations: [
    {
      id: 'test/ping',
      host: 'ts',
      namespace: { raw: 'test', words: ['test'] },
      path: [{ raw: 'ping', words: ['ping'] }],
      kind: 'action',
      async: false,
      streaming: false,
      safe: true,
      input: {},
      output: { type: 'string' },
      envelope: {},
      typeText: null,
    } satisfies Operation,
  ],
}

/** Minimal Extensions stub. */
const fakeExtensions: Extensions = {
  get: () => undefined,
  set: () => undefined,
}

/** A minimal Call for driving the handler. */
function makeCall(descriptor: Descriptor) {
  return {
    operation: descriptor.operations[0],
    data: {},
    envelope: {},
    ctx: fakeExtensions,
    transport: 'http' as const,
    signal: new AbortController().signal,
  }
}

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe('health plugin — v2 shape', () => {
  it('has id "health"', () => {
    expect(healthPlugin.id).toBe('health')
  })

  it('declares a capabilities object', () => {
    expect(healthPlugin.capabilities).toBeDefined()
    expect(typeof healthPlugin.capabilities).toBe('object')
    expect(healthPlugin.capabilities).not.toBeNull()
  })

  it('declares a mount capability (not target or layer)', () => {
    // This is a mount plugin — it adds an operation, not a transport target.
    expect(healthPlugin.capabilities.mount).toBeDefined()
    // target and layer intentionally absent.
    expect(healthPlugin.capabilities.target).toBeUndefined()
    expect(healthPlugin.capabilities.layer).toBeUndefined()
  })

  it('mount.operations is a function', () => {
    expect(typeof healthPlugin.capabilities.mount!.operations).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Mount: operations() shape
// ---------------------------------------------------------------------------

describe('health plugin — mount.operations()', () => {
  it('returns exactly one mounted operation', () => {
    const ops = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(Array.isArray(ops)).toBe(true)
    expect(ops.length).toBe(1)
  })

  it('the mounted operation has id "_meta/health"', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(op.id).toBe('_meta/health')
  })

  it('the mounted operation is safe (kind: query, safe: true) → GET /meta/health', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(op.safe).toBe(true)
    expect(op.kind).toBe('query')
  })

  it('restricts the mounted operation to http and grpc transports (SPEC §13.1)', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    // Both http (health checks) and grpc (load-balancer probes) are required.
    expect(op.transports).toContain('http')
    expect(op.transports).toContain('grpc')
  })

  it('exposes a handler function on the mounted operation', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(typeof op.handler).toBe('function')
  })

  it('sets host from the descriptor', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(op.host).toBe(sampleDescriptor.host)
  })
})

// ---------------------------------------------------------------------------
// Mount: handler returns a readiness signal (SPEC §13.1)
// ---------------------------------------------------------------------------

describe('health plugin — handler returns readiness signal', () => {
  it('handler returns { status: "ok" }', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as HealthResponse
    expect(result.status).toBe('ok')
  })

  it('handler result carries the host tag from the descriptor', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as HealthResponse
    expect(result.host).toBe('ts')
  })

  it('handler result reflects the descriptor host for a non-ts host', () => {
    const rustDescriptor: Descriptor = { ...sampleDescriptor, host: 'rust' }
    const [op] = healthPlugin.capabilities.mount!.operations(rustDescriptor)
    const result = op.handler(makeCall(rustDescriptor)) as HealthResponse
    expect(result.host).toBe('rust')
  })

  it('omits meta key when no meta option is supplied', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as HealthResponse
    expect(result.meta).toBeUndefined()
  })

  it('includes meta in response when meta option is supplied', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor, {
      meta: { region: 'us-east-1', revision: 42 },
    })
    const result = op.handler(makeCall(sampleDescriptor)) as HealthResponse
    expect(result.meta).toEqual({ region: 'us-east-1', revision: 42 })
  })

  // Teeth: the handler must return status:'ok' always (not a mocked value).
  // If the handler is replaced with a no-op returning {}, this test goes red.
  it('negative — handler must always return status: "ok" (not missing, not "error")', () => {
    const [op] = healthPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as Record<string, unknown>
    expect(result['status']).toBeDefined()
    expect(result['status']).not.toBe('error')
    expect(result['status']).not.toBe('down')
    expect(result['status']).toBe('ok')
  })

  // Teeth: host must come from the descriptor, not be hardcoded.
  it('negative — host in response must match descriptor.host (not be hardcoded)', () => {
    const pyDescriptor: Descriptor = { ...sampleDescriptor, host: 'py' }
    const [op] = healthPlugin.capabilities.mount!.operations(pyDescriptor)
    const result = op.handler(makeCall(pyDescriptor)) as HealthResponse
    // If host were hardcoded to 'ts', this fails.
    expect(result.host).toBe('py')
  })
})

describe('health plugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(healthPlugin.language).toBe('ts')
  })
})
