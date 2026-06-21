import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { apiExpressPlugin } from '../lib/plugin'
import { generate } from '../lib/generate'
import { run } from '../lib/run'
import type { PluginInput, RunInput } from '@adhd/apigen-core'

// ---------- inline fixture ----------
// Simple in-process functions used by all tests — no mocking of anything under test.
function getUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` }
}
function listUsers(): string[] {
  return ['alice', 'bob']
}

const testSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
  listUsers: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'array' },
  },
}

const testFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
  listUsers: () => listUsers(),
}

const baseInput: PluginInput = {
  packages: [
    {
      id: 'test-pkg',
      schemas: testSchema,
      importPath: '@test/test-pkg',
      fns: testFns,
    },
  ],
  outputDir: '/tmp/out',
  options: {},
}

// ---------- generate() tests ----------

describe('generate()', () => {
  it('[plugin-api-express.1] emits routes.ts using Router from express', () => {
    const out = generate(baseInput)
    expect(out.files).toHaveLength(1)
    expect(out.files[0].path).toBe('routes.ts')
    const content = out.files[0].content
    expect(content).toContain('Router')
    expect(content).toContain("from 'express'")
    expect(content).toContain("router.post('/test-pkg/getUser'")
    expect(content).toContain("router.post('/test-pkg/listUsers'")
  })

  it('[plugin-api-express.2] generated routes.ts imports dispatch from @adhd/apigen-runtime', () => {
    const out = generate(baseInput)
    expect(out.files[0].content).toContain("import { dispatch } from '@adhd/apigen-runtime'")
  })

  it('[plugin-api-express.4] route shape is POST /<packageId>/<fnName>', () => {
    const out = generate(baseInput)
    const content = out.files[0].content
    expect(content).toContain("router.post('/test-pkg/getUser'")
    expect(content).toContain("router.post('/test-pkg/listUsers'")
  })

  it('generated routes.ts calls res.json(result) not return', () => {
    const out = generate(baseInput)
    const content = out.files[0].content
    expect(content).toContain('res.json(result)')
    // Fastify-style bare return must not appear inside the route handler
    expect(content).not.toMatch(/return dispatch/)
  })

  it('respects routePrefix option', () => {
    const out = generate({ ...baseInput, options: { routePrefix: '/v1' } })
    expect(out.files[0].content).toContain("router.post('/v1/test-pkg/getUser'")
  })
})

// ---------- plugin interface tests ----------

describe('apiExpressPlugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(apiExpressPlugin.id).toBe('api-express')
    expect(typeof apiExpressPlugin.generate).toBe('function')
    expect(typeof apiExpressPlugin.run).toBe('function')
  })

  it('delegates generate() to generate module', () => {
    const out = apiExpressPlugin.generate(baseInput)
    expect((out as { files: unknown[] }).files).toHaveLength(1)
  })
})

// ---------- run() integration tests — real Express instance ----------

describe('run() — real Express server', () => {
  let controller: AbortController
  let baseUrl: string

  beforeAll(async () => {
    controller = new AbortController()
    const port = 47330 // deterministic high port, avoids clashes in CI
    const runInput: RunInput = { ...baseInput, options: { port }, signal: controller.signal }

    // run() returns a Promise that resolves on abort; fire-and-forget
    run(runInput).catch(() => {/* swallowed after abort */})

    // Wait until the server is ready by polling; bounded to 3 s
    baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/test-pkg/listUsers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: {} }),
        })
        if (r.ok || r.status < 500) break
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  })

  afterAll(() => {
    controller.abort()
  })

  it('[plugin-api-express.3] POST /test-pkg/getUser returns correct JSON via res.json', async () => {
    const res = await fetch(`${baseUrl}/test-pkg/getUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { userId: 'u42' } }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json()
    // Ground truth: call the function directly
    const expected = getUser('u42')
    expect(body).toEqual(expected)
  })

  it('POST /test-pkg/listUsers returns correct JSON', async () => {
    const res = await fetch(`${baseUrl}/test-pkg/listUsers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(body).toEqual(listUsers())
  })

  it('[plugin-api-express.4] body envelope — extra fields pass through, data routes to fn', async () => {
    const res = await fetch(`${baseUrl}/test-pkg/getUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: 'tok-123', data: { userId: 'u99' } }),
    })
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(body).toEqual(getUser('u99'))
  })
})
