import { describe, it, expect } from 'vitest'
import { openapiPlugin } from '../lib/plugin'
import type { Descriptor, Operation, Extensions } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal valid Operation used in tests. */
function makeOp(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'test/fn',
    host: 'ts',
    namespace: { raw: 'test', words: ['test'] },
    path: [{ raw: 'fn', words: ['fn'] }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    output: { type: 'string' },
    envelope: {},
    typeText: null,
    ...overrides,
  }
}

const sampleDescriptor: Descriptor = {
  host: 'ts',
  namespace: 'test-api',
  operations: [
    makeOp({
      id: 'test/fn',
      safe: false,
      input: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
      output: { type: 'string' },
    }),
  ],
}

/** Minimal Extensions stub (not used by this plugin but required by Call). */
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

describe('openapi plugin — v2 shape', () => {
  it('has id "openapi"', () => {
    expect(openapiPlugin.id).toBe('openapi')
  })

  it('declares a capabilities object', () => {
    expect(openapiPlugin.capabilities).toBeDefined()
    expect(typeof openapiPlugin.capabilities).toBe('object')
    expect(openapiPlugin.capabilities).not.toBeNull()
  })

  it('declares a mount capability (not target or layer)', () => {
    // This plugin is a mount plugin — it adds an operation, not a transport.
    expect(openapiPlugin.capabilities.mount).toBeDefined()
    // target and layer are intentionally absent for a pure mount plugin.
    expect(openapiPlugin.capabilities.target).toBeUndefined()
    expect(openapiPlugin.capabilities.layer).toBeUndefined()
  })

  it('mount.operations is a function', () => {
    expect(typeof openapiPlugin.capabilities.mount!.operations).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Mount: operations() shape
// ---------------------------------------------------------------------------

describe('openapi plugin — mount.operations()', () => {
  it('returns exactly one mounted operation', () => {
    const ops = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(Array.isArray(ops)).toBe(true)
    expect(ops.length).toBe(1)
  })

  it('the mounted operation has id "_meta/openapi"', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(op.id).toBe('_meta/openapi')
  })

  it('the mounted operation is safe (kind: query, safe: true) → GET /meta/openapi', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(op.safe).toBe(true)
    expect(op.kind).toBe('query')
  })

  it('restricts the mounted operation to the http transport only', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(op.transports).toEqual(['http'])
  })

  it('exposes a handler function on the mounted operation', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    expect(typeof op.handler).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Mount: handler returns a valid OpenAPI doc
// ---------------------------------------------------------------------------

describe('openapi plugin — handler returns OpenAPI doc', () => {
  it('handler returns an object with openapi: "3.1.0"', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as Record<string, unknown>
    expect(result['openapi']).toBe('3.1.0')
  })

  it('handler result includes a paths object', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as Record<string, unknown>
    expect(typeof result['paths']).toBe('object')
  })

  it('handler result contains the descriptor operation projected to its HTTP route', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as { paths: Record<string, unknown> }
    // The sample op (safe=false) should appear as POST /test/fn
    expect(result.paths['/test/fn']).toBeDefined()
    expect((result.paths['/test/fn'] as Record<string, unknown>)['post']).toBeDefined()
  })

  it('forwards title and version options to the OpenAPI doc info', () => {
    const ops = openapiPlugin.capabilities.mount!.operations(sampleDescriptor, {
      title: 'Widget API',
      version: '3.0.0',
    })
    const result = ops[0].handler(makeCall(sampleDescriptor)) as {
      info: { title: string; version: string }
    }
    expect(result.info.title).toBe('Widget API')
    expect(result.info.version).toBe('3.0.0')
  })

  // Teeth: if toOpenApi is broken and returns empty paths, this test goes red.
  it('negative — handler result must have at least one path entry for a non-empty descriptor', () => {
    const [op] = openapiPlugin.capabilities.mount!.operations(sampleDescriptor)
    const result = op.handler(makeCall(sampleDescriptor)) as { paths: Record<string, unknown> }
    expect(Object.keys(result.paths).length).toBeGreaterThan(0)
  })
})

describe('openapi plugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(openapiPlugin.language).toBe('ts')
  })
})
