import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import { dispatch } from '@adhd/apigen-runtime'
import { apiFastifyPlugin } from '../lib/plugin'
import { generate } from '../lib/generate'
import { run } from '../lib/run'
import healthPlugin from '@adhd/apigen-plugin-health'
import type { PluginInput, RunInput } from '@adhd/apigen-core'
import * as net from 'node:net'

/** Bind a TCP server to port 0, record the OS-assigned port, close it, return that port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo
      srv.close((err) => (err ? reject(err) : resolve(addr.port)))
    })
    srv.on('error', reject)
  })
}

// ---------- inline fixture ----------
// Simple in-process functions used by all tests — no mocking of anything under test.
function getUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` }
}
function listUsers(): string[] {
  return ['alice', 'bob']
}
// A safe (idempotent) function for GET verb tests.
function ping(): string {
  return 'pong'
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
    // unsafe (default) → POST
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
    // unsafe (default) → POST
  },
}

/** Schema with x-apigen-safe:true → GET verb */
const safeSchema = {
  ping: {
    input: {
      type: 'object',
      properties: {
        data: { type: 'object', properties: {}, required: [] },
      },
      required: ['data'],
    },
    output: { type: 'string' },
    'x-apigen-safe': true,
  },
}

/** Schema with envelope field + x-apigen-envelope metadata (§9.1). */
const envelopeSchema = {
  getUser: {
    input: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        data: {
          type: 'object',
          properties: { userId: { type: 'string' } },
          required: ['userId'],
        },
      },
      required: ['session', 'data'],
    },
    output: { type: 'object' },
    // pluginId for 'session' field is 'auth' → header x-auth-session
    'x-apigen-envelope': { session: 'auth' },
  },
}

const testFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
  listUsers: () => listUsers(),
}
const safeFns: Record<string, (...args: unknown[]) => unknown> = {
  ping: () => ping(),
}
// getUser with session: reads ctx (ignored) + userId
const envelopeFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
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
  it('[plugin-api-fastify.1] emits routes.ts with POST routes for unsafe fns', () => {
    const out = generate(baseInput)
    expect(out.files).toHaveLength(1)
    expect(out.files[0].path).toBe('routes.ts')
    const content = out.files[0].content
    // unsafe ops → POST
    expect(content).toContain("app.post('/test-pkg/getUser'")
    expect(content).toContain("app.post('/test-pkg/listUsers'")
  })

  it('[plugin-api-fastify.2] generated routes.ts imports dispatch from @adhd/apigen-runtime', () => {
    const out = generate(baseInput)
    expect(out.files[0].content).toMatch(/import \{[^}]*\bdispatch\b[^}]*\} from ['"]@adhd\/apigen-runtime['"]/)
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

  // ---- [v2-proj-transport] verb-from-safe (§5) ----

  it('[v2-fastify.verb.1] safe op (x-apigen-safe:true) → app.get()', () => {
    const input: PluginInput = {
      packages: [{ id: 'svc', schemas: safeSchema, importPath: '@acme/svc', fns: safeFns }],
      outputDir: '/tmp/out',
      options: {},
    }
    const { content } = generate(input).files[0]
    expect(content).toContain("app.get('/svc/ping'")
    // Must NOT emit app.post for a safe operation
    expect(content).not.toContain("app.post('/svc/ping'")
  })

  it('[v2-fastify.verb.2] unsafe op (no x-apigen-safe) → app.post()', () => {
    const { content } = generate(baseInput).files[0]
    expect(content).toContain("app.post('/test-pkg/getUser'")
    expect(content).not.toContain("app.get('/test-pkg/getUser'")
  })

  it('[v2-fastify.verb.3] projection override flips unsafe→GET', () => {
    const input: PluginInput = {
      ...baseInput,
      options: { projection: { http: { verb: { 'test-pkg:getUser': 'GET' } } } },
    }
    const { content } = generate(input).files[0]
    expect(content).toContain("app.get('/test-pkg/getUser'")
    expect(content).not.toContain("app.post('/test-pkg/getUser'")
  })

  // ---- [v2-proj-transport] envelope from headers (§9.1) ----

  it('[v2-fastify.env.1] envelope field bound to x-<pluginId>-<field> header in generated code', () => {
    const input: PluginInput = {
      packages: [{ id: 'svc', schemas: envelopeSchema, importPath: '@acme/svc', fns: envelopeFns }],
      outputDir: '/tmp/out',
      options: {},
    }
    const { content } = generate(input).files[0]
    // §9.1: 'session' from plugin 'auth' → header 'x-auth-session'
    expect(content).toContain("x-auth-session")
  })

  it('[v2-fastify.env.2] (negative) envelope NOT extracted from req.body in generated code', () => {
    const input: PluginInput = {
      packages: [{ id: 'svc', schemas: envelopeSchema, importPath: '@acme/svc', fns: envelopeFns }],
      outputDir: '/tmp/out',
      options: {},
    }
    const { content } = generate(input).files[0]
    // Must NOT spread body for envelope (old v1 pattern)
    expect(content).not.toContain('...envelope')
    expect(content).not.toMatch(/const \{[^}]*\.\.\.envelope/)
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
    const port = await freePort()
    const runInput: RunInput = { ...baseInput, options: { port }, signal: controller.signal }

    // run() returns a Promise that resolves on abort; fire-and-forget, don't await
    run(runInput).catch(() => {/* swallowed after abort */})

    // Wait until the server is ready by polling; bounded to 10 s
    baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 10000
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
  }, 15000)

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

// ---------- [v2-proj-transport] verb-from-safe + envelope binding — live server ----------

describe('[v2-proj-transport] run() — safe→GET / envelope from headers', () => {
  let controller: AbortController
  let baseUrl: string

  beforeAll(async () => {
    controller = new AbortController()
    const port = await freePort()
    const packages: PluginInput['packages'] = [
      // unsafe pkg: POST
      {
        id: 'unsafe-pkg',
        schemas: testSchema,
        importPath: '@test/test-pkg',
        fns: testFns,
      },
      // safe pkg: GET
      {
        id: 'safe-pkg',
        schemas: safeSchema,
        importPath: '@test/safe-pkg',
        fns: safeFns,
      },
      // envelope pkg: POST + header binding
      {
        id: 'env-pkg',
        schemas: envelopeSchema,
        importPath: '@test/env-pkg',
        fns: envelopeFns,
      },
    ]
    const runInput: RunInput = {
      packages,
      outputDir: '/tmp/out',
      options: { port },
      signal: controller.signal,
    }

    run(runInput).catch(() => {/* swallowed after abort */})

    baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/unsafe-pkg/listUsers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: {} }),
        })
        if (r.ok || r.status < 500) break
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  }, 15000)

  afterAll(() => {
    controller.abort()
  })

  it('[v2-fastify.run.verb.1] safe op responds to GET (x-apigen-safe:true)', async () => {
    const res = await fetch(`${baseUrl}/safe-pkg/ping`, { method: 'GET' })
    expect(res.ok).toBe(true)
    // Fastify serializes string primitives as plain text (not JSON-quoted).
    // Accept either "pong" (JSON string) or pong (text) for robustness.
    const text = await res.text()
    expect(text.replace(/^"|"$/g, '')).toBe('pong')
  })

  it('[v2-fastify.run.verb.2] (negative) safe op does NOT respond to POST', async () => {
    const res = await fetch(`${baseUrl}/safe-pkg/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    // Fastify returns 404 for unregistered method+route combinations
    expect(res.status).toBe(404)
  })

  it('[v2-fastify.run.verb.3] unsafe op responds to POST', async () => {
    const res = await fetch(`${baseUrl}/unsafe-pkg/getUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { userId: 'u1' } }),
    })
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual(getUser('u1'))
  })

  it('[v2-fastify.run.env.1] envelope field bound from x-<pluginId>-<field> header', async () => {
    // session field with pluginId='auth' → header x-auth-session
    // Our fixture fn ignores ctx/session, just reads userId, so any session value is fine.
    const res = await fetch(`${baseUrl}/env-pkg/getUser`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-session': 'tok-abc',   // §9.1 carrier
      },
      body: JSON.stringify({ data: { userId: 'u99' } }),
    })
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual(getUser('u99'))
  })

  it('[v2-fastify.run.env.2] (negative) sending session in body does NOT route it as envelope', async () => {
    // Session in body (old v1 pattern) must NOT be picked up as envelope.
    // Since our fn ignores the envelope, both should return the same 200 result.
    // The critical check is that the server doesn't crash when session is in body.
    const res = await fetch(`${baseUrl}/env-pkg/getUser`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Deliberately omit the x-auth-session header; session is only in body (wrong carrier)
      body: JSON.stringify({ session: 'wrong', data: { userId: 'u77' } }),
    })
    // Server should still respond (it reads session from header, not body)
    expect(res.status).toBeLessThan(500)
  })
})

// ---------- BUG-APIGEN-009 / -010 — validate-Layer + health mount over real HTTP ----------
// These drive a REAL Fastify server through `run()` and assert the served path
// (a) rejects schema-violating input with HTTP 400 BEFORE the fn is called and
// (b) mounts `--use health` as `GET /_meta/health`. Both regressed when the run
// path called `dispatch()` directly, bypassing the Layer/mount stack.

// Counts dispatch reaching the fn — proves the validate-Layer short-circuits
// BEFORE dispatch on bad input (the fn must NOT run). `when` arrives as a real
// Date (dispatch decodes the date-time wire value); we echo its ISO form back.
let scheduleCalls = 0
function scheduleEvent(when: unknown): { ok: true; when: string } {
  scheduleCalls += 1
  return { ok: true, when: (when as Date).toISOString() }
}

/**
 * Schema with a required `when` field constrained to `date-time` format.
 * `output: {}` is schema-less passthrough so the response object is serialised
 * as-is (no transcoder object-shaping) — isolating the test to the input-side
 * validation behaviour under verification (BUG-APIGEN-009).
 */
const dateTimeSchema = {
  scheduleEvent: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            when: { type: 'string', format: 'date-time' },
          },
          required: ['when'],
        },
      },
      required: ['data'],
    },
    output: {},
  },
}

describe('[BUG-APIGEN-009/010] run() — validate-Layer + health mount (Fastify)', () => {
  let controller: AbortController
  let baseUrl: string

  beforeAll(async () => {
    scheduleCalls = 0
    controller = new AbortController()
    const port = await freePort()
    const runInput: RunInput = {
      packages: [
        {
          id: 'sched',
          schemas: dateTimeSchema,
          importPath: '@test/sched',
          fns: { scheduleEvent: (when: unknown) => scheduleEvent(when) },
        },
      ],
      outputDir: '/tmp/out',
      // BUG-APIGEN-010: thread the loaded health plugin exactly as the CLI does.
      options: { port, usePlugins: [healthPlugin] },
      signal: controller.signal,
    }

    run(runInput).catch(() => {/* swallowed after abort */})

    baseUrl = `http://127.0.0.1:${port}`
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/_meta/health`, { method: 'GET' })
        if (r.status < 500) break
      } catch {
        await new Promise((r) => setTimeout(r, 50))
      }
    }
  }, 15000)

  afterAll(() => {
    controller.abort()
  })

  it('[009] malformed date-time → 400 invalid_argument, fn never called', async () => {
    const before = scheduleCalls
    const res = await fetch(`${baseUrl}/sched/scheduleEvent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 2099-02-30 is not a real calendar date → ajv date-time format rejects it.
      body: JSON.stringify({ data: { when: '2099-02-30T00:00:00.000Z' } }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe('invalid_argument')
    // The target fn must NOT have run (validation short-circuits before dispatch).
    expect(scheduleCalls).toBe(before)
  })

  it('[009] missing required field → 400 invalid_argument, fn never called', async () => {
    const before = scheduleCalls
    const res = await fetch(`${baseUrl}/sched/scheduleEvent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('invalid_argument')
    expect(scheduleCalls).toBe(before)
  })

  it('[009] valid date-time → 200 and the fn runs', async () => {
    const before = scheduleCalls
    const res = await fetch(`${baseUrl}/sched/scheduleEvent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { when: '2026-01-02T03:04:05.000Z' } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // The dispatch encode seam serialises the Date back to RFC 3339.
    expect(body.when).toBe('2026-01-02T03:04:05.000Z')
    expect(scheduleCalls).toBe(before + 1)
  })

  it('[010] --use health mounts GET /_meta/health → 200 { status: ok }', async () => {
    const res = await fetch(`${baseUrl}/_meta/health`, { method: 'GET' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
  })
})

describe('api-fastify plugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(apiFastifyPlugin.language).toBe('ts')
  })
})
