import type { Operation } from '@adhd/apigen-core-client'
import { describe, expect, it } from 'vitest'
import { toOpenApi } from './to-openapi'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Helper: build a minimal valid Operation for testing. */
function makeOp(overrides: Partial<Operation>): Operation {
  return {
    id: 'test/op',
    host: 'ts',
    namespace: { raw: 'test', words: ['test'] },
    path: [{ raw: 'op', words: ['op'] }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: {},
    output: {},
    envelope: {},
    typeText: null,
    ...overrides,
  }
}

/**
 * A sample unsafe (safe=false) action with ALL-primitive domain params.
 * Auto-hoisted to GET by FEAT-APIGEN-022 (number is a "properly typed primitive").
 */
const unsafeOp: Operation = makeOp({
  id: 'transform/humanize/humanize-bytes',
  namespace: { raw: 'transform', words: ['transform'] },
  path: [
    { raw: 'humanize', words: ['humanize'] },
    { raw: 'humanizeBytes', words: ['humanize', 'bytes'] },
  ],
  kind: 'action',
  safe: false,
  input: {
    type: 'object',
    properties: { value: { type: 'number' } },
    required: ['value'],
  },
  output: { type: 'string' },
})

/**
 * A sample unsafe (safe=false) action with COMPLEX (non-primitive) domain params.
 * Stays POST because array-typed params are not "properly typed primitives".
 */
const complexOp: Operation = makeOp({
  id: 'transform/humanize/humanize-bytes-complex',
  namespace: { raw: 'transform', words: ['transform'] },
  path: [
    { raw: 'humanize', words: ['humanize'] },
    { raw: 'complexBytes', words: ['complex', 'bytes'] },
  ],
  kind: 'action',
  safe: false,
  input: {
    type: 'object',
    properties: { ids: { type: 'array', items: { type: 'string' } } },
    required: ['ids'],
  },
  output: { type: 'string' },
})

/** A sample safe (GET) query with domain params. */
const safeOp: Operation = makeOp({
  id: 'catalog/search/find-by-name',
  namespace: { raw: 'catalog', words: ['catalog'] },
  path: [
    { raw: 'search', words: ['search'] },
    { raw: 'findByName', words: ['find', 'by', 'name'] },
  ],
  kind: 'query',
  safe: true,
  input: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  output: {
    type: 'array',
    items: { type: 'object', properties: { id: { type: 'string' } } },
  },
})

// ---------------------------------------------------------------------------
// to-openapi: document-level shape
// ---------------------------------------------------------------------------

describe('toOpenApi — document shape', () => {
  it('emits openapi: "3.1.0"', () => {
    const doc = toOpenApi([])
    expect(doc.openapi).toBe('3.1.0')
  })

  it('uses default title and version when options are omitted', () => {
    const doc = toOpenApi([])
    expect(doc.info.title).toBe('API')
    expect(doc.info.version).toBe('0.0.0')
  })

  it('forwards custom title and version from options', () => {
    const doc = toOpenApi([], { title: 'My Service', version: '2.3.4' })
    expect(doc.info.title).toBe('My Service')
    expect(doc.info.version).toBe('2.3.4')
  })

  it('emits a paths object (even for zero operations)', () => {
    const doc = toOpenApi([])
    expect(typeof doc.paths).toBe('object')
    expect(doc.paths).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: verb derivation (SPEC §5 — safe → GET, unsafe → POST;
// FEAT-APIGEN-022 auto-hoists primitive/zero-param unsafe to GET)
// ---------------------------------------------------------------------------

describe('toOpenApi — verb derivation (SPEC §5)', () => {
  it('maps a primitive-param unsafe action to a GET entry (auto-hoist)', () => {
    const doc = toOpenApi([unsafeOp])
    const route = '/transform/humanize/humanize-bytes'
    expect(doc.paths[route]).toBeDefined()
    // All-primitive params → auto-hoisted to GET
    expect(doc.paths[route]['get']).toBeDefined()
    // No POST sibling for the auto-hoisted case
    expect(doc.paths[route]['post']).toBeUndefined()
  })

  it('maps a complex-param unsafe action to a POST entry', () => {
    const doc = toOpenApi([complexOp])
    const route = '/transform/humanize/complex-bytes'
    expect(doc.paths[route]).toBeDefined()
    // Array-typed param → not primitive-only → stays POST
    expect(doc.paths[route]['post']).toBeDefined()
    // No GET sibling for the non-hoisted case
    expect(doc.paths[route]['get']).toBeUndefined()
  })

  it('maps a safe query to a GET entry', () => {
    const doc = toOpenApi([safeOp])
    const route = '/catalog/search/find-by-name'
    expect(doc.paths[route]).toBeDefined()
    expect(doc.paths[route]['get']).toBeDefined()
    // no POST sibling
    expect(doc.paths[route]['post']).toBeUndefined()
  })

  // Negative-control: if we flip safe to true, verb is still GET
  it('negative — flipping safe to true on a primitive-param op still yields GET', () => {
    const flipped = { ...unsafeOp, safe: true }
    const doc = toOpenApi([flipped])
    const route = '/transform/humanize/humanize-bytes'
    expect(doc.paths[route]['get']).toBeDefined()
    expect(doc.paths[route]['post']).toBeUndefined()
  })

  // Negative-control: safe=false + primitive params must NOT produce POST
  it('negative — safe=false with primitive params does not produce a POST entry', () => {
    const doc = toOpenApi([unsafeOp])
    const route = '/transform/humanize/humanize-bytes'
    expect(doc.paths[route]['post']).toBeUndefined()
  })

  // Negative-control: safe=false + complex params must NOT produce GET
  it('negative — safe=false with complex params does not produce a GET entry', () => {
    const doc = toOpenApi([complexOp])
    const route = '/transform/humanize/complex-bytes'
    expect(doc.paths[route]['get']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: operationId
// ---------------------------------------------------------------------------

describe('toOpenApi — operationId', () => {
  it('sets operationId for a primitive-param (GET) operation', () => {
    const doc = toOpenApi([unsafeOp])
    const pathItem = doc.paths['/transform/humanize/humanize-bytes']
    expect(pathItem['get'].operationId).toBe(unsafeOp.id)
  })

  it('sets operationId for a complex-param (POST) operation', () => {
    const doc = toOpenApi([complexOp])
    const pathItem = doc.paths['/transform/humanize/complex-bytes']
    expect(pathItem['post'].operationId).toBe(complexOp.id)
  })
})

// ---------------------------------------------------------------------------
// to-openapi: requestBody — present for POST with params, absent for GET
// ---------------------------------------------------------------------------

describe('toOpenApi — requestBody semantics', () => {
  it('attaches a requestBody for a complex-param POST operation', () => {
    const doc = toOpenApi([complexOp])
    const op = doc.paths['/transform/humanize/complex-bytes']['post']
    expect(op.requestBody).toBeDefined()
    expect(op.requestBody!.required).toBe(true)
    // content type
    expect(op.requestBody!.content['application/json']).toBeDefined()
    // schema passthrough
    expect(op.requestBody!.content['application/json'].schema).toEqual(complexOp.input)
  })

  it('omits requestBody for a primitive-param (auto-hoisted to GET) operation', () => {
    const doc = toOpenApi([unsafeOp])
    const op = doc.paths['/transform/humanize/humanize-bytes']['get']
    expect(op.requestBody).toBeUndefined()
  })

  it('omits requestBody for a POST operation with no input params (empty schema)', () => {
    const noParams = makeOp({ safe: false, input: {} })
    const doc = toOpenApi([noParams])
    const op = doc.paths['/test/op']['post']
    expect(op.requestBody).toBeUndefined()
  })

  it('omits requestBody for a GET (safe) operation', () => {
    const doc = toOpenApi([safeOp])
    const op = doc.paths['/catalog/search/find-by-name']['get']
    expect(op.requestBody).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: GET operations → query-string parameters
// ---------------------------------------------------------------------------

describe('toOpenApi — GET: query-string parameters from input schema', () => {
  it('expands input properties into query parameters for a safe operation', () => {
    const doc = toOpenApi([safeOp])
    const op = doc.paths['/catalog/search/find-by-name']['get']
    expect(op.parameters).toBeDefined()
    expect(op.parameters!.length).toBeGreaterThan(0)

    const nameParam = op.parameters!.find((p) => p.name === 'name')
    expect(nameParam).toBeDefined()
    expect(nameParam!.in).toBe('query')
    expect(nameParam!.required).toBe(true)
    expect(nameParam!.schema).toEqual({ type: 'string' })
  })

  it('emits an empty parameters array for a zero-param safe operation', () => {
    const noParams = makeOp({ safe: true, kind: 'query', input: {} })
    const doc = toOpenApi([noParams])
    const op = doc.paths['/test/op']['get']
    expect(Array.isArray(op.parameters)).toBe(true)
    expect(op.parameters!.length).toBe(0)
  })

  it('does not attach a requestBody for a safe (GET) operation', () => {
    const doc = toOpenApi([safeOp])
    const op = doc.paths['/catalog/search/find-by-name']['get']
    expect(op.requestBody).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: response schema passthrough
// ---------------------------------------------------------------------------

describe('toOpenApi — response schema passthrough', () => {
  it('includes the output schema in the 200 response content for a GET (auto-hoisted) operation', () => {
    const doc = toOpenApi([unsafeOp])
    const resp = doc.paths['/transform/humanize/humanize-bytes']['get'].responses['200']
    expect(resp).toBeDefined()
    expect(resp.content?.['application/json'].schema).toEqual({ type: 'string' })
  })

  it('includes the output schema in the 200 response content for a POST operation', () => {
    const doc = toOpenApi([complexOp])
    const resp = doc.paths['/transform/humanize/complex-bytes']['post'].responses['200']
    expect(resp).toBeDefined()
    expect(resp.content?.['application/json'].schema).toEqual({ type: 'string' })
  })

  it('omits content for an operation with an empty output schema', () => {
    const noOutput = makeOp({ safe: false, output: {} })
    const doc = toOpenApi([noOutput])
    // noOutput has input:{} (no "properties" key) → NOT auto-hoisted → stays POST
    const resp = doc.paths['/test/op']['post'].responses['200']
    expect(resp.description).toBe('Success')
    expect(resp.content).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: multiple operations → distinct paths
// ---------------------------------------------------------------------------

describe('toOpenApi — multiple operations', () => {
  it('emits separate path entries for multiple operations', () => {
    const doc = toOpenApi([unsafeOp, complexOp, safeOp])
    expect(Object.keys(doc.paths).length).toBe(3)
    expect(doc.paths['/transform/humanize/humanize-bytes']).toBeDefined()
    expect(doc.paths['/transform/humanize/complex-bytes']).toBeDefined()
    expect(doc.paths['/catalog/search/find-by-name']).toBeDefined()
  })
})
