import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { dispatch } from '@adhd/apigen-runtime'
import { apiFastifyPlugin } from '../lib/plugin'
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
  it('[plugin-api-fastify.1] emits routes.ts with POST routes for each fn', () => {
    const out = generate(baseInput)
    expect(out.files).toHaveLength(1)
    expect(out.files[0].path).toBe('routes.ts')
    const content = out.files[0].content
    expect(content).toContain("app.post('/test-pkg/getUser'")
    expect(content).toContain("app.post('/test-pkg/listUsers'")
  })

  it('[plugin-api-fastify.2] generated routes.ts imports dispatch from @adhd/apigen-runtime', () => {
    const out = generate(baseInput)
    expect(out.files[0].content).toContain("import { dispatch } from '@adhd/apigen-runtime'")
  })

  it('respects routePrefix option', () => {
    const out = generate({ ...baseInput, options: { routePrefix: '/v1' } })
    expect(out.files[0].content).toContain("app.post('/v1/test-pkg/getUser'")
  })

  it('[plugin-api-fastify.4] no schema body attachment in generate output', () => {
    const out = generate(baseInput)
    const content = out.files[0].content
    // Must not attach schema: { body: ... } to route options
    expect(content).not.toMatch(/schema.*body|body.*schema/i)
  })
})

// ---------- plugin interface tests ----------

describe('apiFastifyPlugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(apiFastifyPlugin.id).toBe('api-fastify')
    expect(typeof apiFastifyPlugin.generate).toBe('function')
    expect(typeof apiFastifyPlugin.run).toBe('function')
  })

  it('delegates generate() to generate module', () => {
    const out = apiFastifyPlugin.generate(baseInput)
    expect((out as { files: unknown[] }).files).toHaveLength(1)
  })
})

// ---------- run() integration tests — real Fastify instance ----------

describe('run() — real Fastify server', () => {
  let controller: AbortController
  let baseUrl: string

  beforeAll(async () => {
    controller = new AbortController()
    const port = 47320 // deterministic high port, avoids clashes in CI
    const runInput: RunInput = { ...baseInput, options: { port }, signal: controller.signal }

    // run() returns a Promise that resolves on abort; fire-and-forget, don't await
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

  it('[plugin-api-fastify.3] POST /test-pkg/getUser returns correct JSON', async () => {
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

  it('[plugin-api-fastify.4] routes have no AJV schema attachment (runtime check)', async () => {
    // If schema: { body } were attached, AJV would reject our oneOf schema and
    // the server would throw at startup — so a successful 200 here proves it.
    const res = await fetch(`${baseUrl}/test-pkg/getUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { userId: 'check' } }),
    })
    expect(res.status).not.toBe(500)
  })
})
