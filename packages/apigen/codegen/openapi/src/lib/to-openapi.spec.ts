import { describe, it, expect } from 'vitest'
import { toOpenApi } from './to-openapi'
import type { Operation } from '@adhd/apigen-core'

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

/** A sample unsafe (POST) action with domain params. */
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
// to-openapi: verb derivation (SPEC §5 — safe → GET, unsafe → POST)
// ---------------------------------------------------------------------------

describe('toOpenApi — verb derivation (SPEC §5)', () => {
  it('maps an unsafe action to a POST entry', () => {
    const doc = toOpenApi([unsafeOp])
    const route = '/transform/humanize/humanize-bytes'
    expect(doc.paths[route]).toBeDefined()
    expect(doc.paths[route]['post']).toBeDefined()
    // no GET sibling
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

  // Negative-control: if we flip safe the verb must flip too.
  it('negative — flipping safe on unsafeOp switches verb from POST to GET', () => {
    const flipped = { ...unsafeOp, safe: true }
    const doc = toOpenApi([flipped])
    const route = '/transform/humanize/humanize-bytes'
    expect(doc.paths[route]['get']).toBeDefined()
    expect(doc.paths[route]['post']).toBeUndefined()
  })

  // Negative-control: safe=false must yield POST, not GET.
  it('negative — safe=false must not produce a GET entry', () => {
    const doc = toOpenApi([unsafeOp])
    const route = '/transform/humanize/humanize-bytes'
    expect(doc.paths[route]['get']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: operationId
// ---------------------------------------------------------------------------

describe('toOpenApi — operationId', () => {
  it('sets operationId to the canonical operation id', () => {
    const doc = toOpenApi([unsafeOp])
    const pathItem = doc.paths['/transform/humanize/humanize-bytes']
    expect(pathItem['post'].operationId).toBe(unsafeOp.id)
  })
})

// ---------------------------------------------------------------------------
// to-openapi: POST operations → requestBody with the input schema
// ---------------------------------------------------------------------------

describe('toOpenApi — POST: requestBody from input schema', () => {
  it('attaches a requestBody for an unsafe (POST) operation with params', () => {
    const doc = toOpenApi([unsafeOp])
    const op = doc.paths['/transform/humanize/humanize-bytes']['post']
    expect(op.requestBody).toBeDefined()
    expect(op.requestBody!.required).toBe(true)
    // content type
    expect(op.requestBody!.content['application/json']).toBeDefined()
    // schema passthrough
    expect(op.requestBody!.content['application/json'].schema).toEqual(unsafeOp.input)
  })

  it('omits requestBody for an unsafe operation with no input params (empty schema)', () => {
    const noParams = makeOp({ safe: false, input: {} })
    const doc = toOpenApi([noParams])
    const op = doc.paths['/test/op']['post']
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
  it('includes the output schema in the 200 response content for non-empty output', () => {
    const doc = toOpenApi([unsafeOp])
    const resp = doc.paths['/transform/humanize/humanize-bytes']['post'].responses['200']
    expect(resp).toBeDefined()
    expect(resp.content?.['application/json'].schema).toEqual({ type: 'string' })
  })

  it('omits content for an operation with an empty output schema', () => {
    const noOutput = makeOp({ safe: false, output: {} })
    const doc = toOpenApi([noOutput])
    const resp = doc.paths['/test/op']['post'].responses['200']
    expect(resp.description).toBe('Success')
    expect(resp.content).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// to-openapi: multiple operations → distinct paths
// ---------------------------------------------------------------------------

describe('toOpenApi — multiple operations', () => {
  it('emits separate path entries for two operations', () => {
    const doc = toOpenApi([unsafeOp, safeOp])
    expect(Object.keys(doc.paths).length).toBe(2)
    expect(doc.paths['/transform/humanize/humanize-bytes']).toBeDefined()
    expect(doc.paths['/catalog/search/find-by-name']).toBeDefined()
  })
})
