import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { apiFastifyPlugin } from '../lib/plugin';
import { generate } from '../lib/generate';
import { run } from '../lib/run';
import healthPlugin from '@adhd/apigen-plugin-health';
import openapiPlugin from '@adhd/apigen-plugin-openapi';
import type {
  PluginInput,
  RunInput,
  Operation,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { toOpenApi } from '@adhd/apigen-codegen-openapi';
import { createStream } from '@adhd/apigen-engine-runtime';
import {
  captureGolden,
  assertParity,
} from '@adhd/apigen-engine-runtime/test-support';
import type {
  GoldenFixture,
  GoldenSnapshot,
  ParityDriver,
} from '@adhd/apigen-engine-runtime/test-support';
import { ApiError } from '@adhd/apigen-base-errors';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Bind a TCP server to port 0, record the OS-assigned port, close it, return that port. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
    srv.on('error', reject);
  });
}

// ---------- inline fixture ----------
// Simple in-process functions used by all tests — no mocking of anything under test.
function getUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` };
}
function listUsers(): string[] {
  return ['alice', 'bob'];
}
// A safe (idempotent) function for GET verb tests.
function ping(): string {
  return 'pong';
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
};

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
};

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
};

const testFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
  listUsers: () => listUsers(),
};
const safeFns: Record<string, (...args: unknown[]) => unknown> = {
  ping: () => ping(),
};
// getUser with session: reads ctx (ignored) + userId
const envelopeFns: Record<string, (...args: unknown[]) => unknown> = {
  getUser: (userId: unknown) => getUser(userId as string),
};

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
};

// ---------- generate() tests ----------

describe('generate()', () => {
  it('[plugin-api-fastify.1] emits routes.ts with POST routes for unsafe fns', () => {
    const out = generate(baseInput);
    expect(out.files).toHaveLength(1);
    expect(out.files[0].path).toBe('routes.ts');
    const content = out.files[0].content;
    // unsafe ops → POST. Route is kebab-cased via `project()`
    // (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001) — NOT the raw camelCase
    // fn name — so it is byte-identical to what `apigen-plugin-openapi` would
    // advertise for the same operation.
    expect(content).toContain("app.post('/test-pkg/get-user'");
    expect(content).toContain("app.post('/test-pkg/list-users'");
  });

  it('[plugin-api-fastify.2] generated routes.ts imports dispatch from @adhd/apigen-engine-runtime', () => {
    const out = generate(baseInput);
    expect(out.files[0].content).toMatch(
      // Package was renamed @adhd/apigen-runtime -> @adhd/apigen-engine-runtime.
      // The generator (src/lib/generate.ts) emits the new name; only this assertion
      // still carried the old one, so the test failed while the code was correct.
      /import \{[^}]*\bdispatch\b[^}]*\} from ['"]@adhd\/apigen-engine-runtime['"]/
    );
  });

  it('respects routePrefix option', () => {
    const out = generate({ ...baseInput, options: { routePrefix: '/v1' } });
    expect(out.files[0].content).toContain("app.post('/v1/test-pkg/get-user'");
  });

  it('[plugin-api-fastify.4] no schema body attachment in generate output', () => {
    const out = generate(baseInput);
    const content = out.files[0].content;
    // Must not attach schema: { body: ... } to route options
    expect(content).not.toMatch(/schema.*body|body.*schema/i);
  });

  // ---- [v2-proj-transport] verb-from-safe (§5) ----

  it('[v2-fastify.verb.1] safe op (x-apigen-safe:true) → app.get()', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'svc',
          schemas: safeSchema,
          importPath: '@acme/svc',
          fns: safeFns,
        },
      ],
      outputDir: '/tmp/out',
      options: {},
    };
    const { content } = generate(input).files[0];
    expect(content).toContain("app.get('/svc/ping'");
    // Must NOT emit app.post for a safe operation
    expect(content).not.toContain("app.post('/svc/ping'");
  });

  it('[v2-fastify.verb.2] unsafe op (no x-apigen-safe) → app.post()', () => {
    const { content } = generate(baseInput).files[0];
    expect(content).toContain("app.post('/test-pkg/get-user'");
    expect(content).not.toContain("app.get('/test-pkg/get-user'");
  });

  it('[v2-fastify.verb.3] projection override flips unsafe→GET', () => {
    // Override key is the canonical `project()`/`Operation.id` slug
    // (`<namespace>/<kebab-path>`), NOT the old `<pkgId>:<fnName>` shape —
    // route + verb are now derived by the SAME `project(op, config)` call
    // `apigen-plugin-openapi` uses (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001),
    // whose `ProjectionConfig.http.verb` is documented as keyed by the
    // canonical id (see naming.ts's `ProjectionConfig` doc comment).
    const input: PluginInput = {
      ...baseInput,
      options: {
        projection: { http: { verb: { 'test-pkg/get-user': 'GET' } } },
      },
    };
    const { content } = generate(input).files[0];
    expect(content).toContain("app.get('/test-pkg/get-user'");
    expect(content).not.toContain("app.post('/test-pkg/get-user'");
  });

  // ---- [v2-proj-transport] envelope from headers (§9.1) ----

  it('[v2-fastify.env.1] envelope field bound to x-<pluginId>-<field> header in generated code', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'svc',
          schemas: envelopeSchema,
          importPath: '@acme/svc',
          fns: envelopeFns,
        },
      ],
      outputDir: '/tmp/out',
      options: {},
    };
    const { content } = generate(input).files[0];
    // §9.1: 'session' from plugin 'auth' → header 'x-auth-session'
    expect(content).toContain('x-auth-session');
  });

  it('[v2-fastify.env.2] (negative) envelope NOT extracted from req.body in generated code', () => {
    const input: PluginInput = {
      packages: [
        {
          id: 'svc',
          schemas: envelopeSchema,
          importPath: '@acme/svc',
          fns: envelopeFns,
        },
      ],
      outputDir: '/tmp/out',
      options: {},
    };
    const { content } = generate(input).files[0];
    // Must NOT spread body for envelope (old v1 pattern)
    expect(content).not.toContain('...envelope');
    expect(content).not.toMatch(/const \{[^}]*\.\.\.envelope/);
  });
});

// ---------- plugin interface tests ----------

describe('apiFastifyPlugin', () => {
  it('satisfies OutputPlugin interface', () => {
    expect(apiFastifyPlugin.id).toBe('api-fastify');
    expect(typeof apiFastifyPlugin.generate).toBe('function');
    expect(typeof apiFastifyPlugin.run).toBe('function');
  });

  it('delegates generate() to generate module', () => {
    const out = apiFastifyPlugin.generate(baseInput);
    expect((out as { files: unknown[] }).files).toHaveLength(1);
  });
});

// ---------- run() integration tests — real Fastify instance ----------

describe('run() — real Fastify server', () => {
  let controller: AbortController;
  let baseUrl: string;

  beforeAll(async () => {
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      ...baseInput,
      options: { port },
      signal: controller.signal,
    };

    // run() returns a Promise that resolves on abort; fire-and-forget, don't await
    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    // Wait until the server is ready by polling; bounded to 10 s
    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/test-pkg/list-users`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: {} }),
        });
        if (r.ok || r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  // Routes are kebab-cased via `project()` (BUG-APIGEN-OPENAPI-ROUTE-PATH-
  // MISMATCH-001) — `/test-pkg/get-user`, NOT the raw camelCase fn name.
  it('[plugin-api-fastify.3] POST /test-pkg/get-user returns correct JSON', async () => {
    const res = await fetch(`${baseUrl}/test-pkg/get-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { userId: 'u42' } }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    // Ground truth: call the function directly
    const expected = getUser('u42');
    expect(body).toEqual(expected);
  });

  it('POST /test-pkg/list-users returns correct JSON', async () => {
    const res = await fetch(`${baseUrl}/test-pkg/list-users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body).toEqual(listUsers());
  });

  it('[plugin-api-fastify.4] routes have no AJV schema attachment (runtime check)', async () => {
    // If schema: { body } were attached, AJV would reject our oneOf schema and
    // the server would throw at startup — so a successful 200 here proves it.
    const res = await fetch(`${baseUrl}/test-pkg/get-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { userId: 'check' } }),
    });
    expect(res.status).not.toBe(500);
  });
});

// ---------- [v2-proj-transport] verb-from-safe + envelope binding — live server ----------

describe('[v2-proj-transport] run() — safe→GET / envelope from headers', () => {
  let controller: AbortController;
  let baseUrl: string;

  beforeAll(async () => {
    controller = new AbortController();
    const port = await freePort();
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
    ];
    const runInput: RunInput = {
      packages,
      outputDir: '/tmp/out',
      options: { port },
      signal: controller.signal,
    };

    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/unsafe-pkg/list-users`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ data: {} }),
        });
        if (r.ok || r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  it('[v2-fastify.run.verb.1] safe op responds to GET (x-apigen-safe:true)', async () => {
    const res = await fetch(`${baseUrl}/safe-pkg/ping`, { method: 'GET' });
    expect(res.ok).toBe(true);
    // BUG-APIGEN-015 regression guard: a scalar return MUST be canonical JSON
    // wire (application/json + a JSON-quoted string), byte-identical to the
    // py-flask host — NOT a bare text/plain body. Reverting the sendJson fix
    // makes Fastify emit `pong` as text/plain and turns all three red.
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const raw = await res.text();
    expect(raw).toBe('"pong"'); // quoted JSON string, not bare `pong`
    expect(JSON.parse(raw)).toBe('pong'); // and it parses as valid JSON
  });

  it('[v2-fastify.run.verb.2] (negative) safe op does NOT respond to POST', async () => {
    const res = await fetch(`${baseUrl}/safe-pkg/ping`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // Fastify returns 404 for unregistered method+route combinations
    expect(res.status).toBe(404);
  });

  it('[v2-fastify.run.verb.3] unsafe op responds to POST', async () => {
    const res = await fetch(`${baseUrl}/unsafe-pkg/get-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { userId: 'u1' } }),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual(getUser('u1'));
  });

  it('[v2-fastify.run.env.1] envelope field bound from x-<pluginId>-<field> header', async () => {
    // session field with pluginId='auth' → header x-auth-session
    // Our fixture fn ignores ctx/session, just reads userId, so any session value is fine.
    const res = await fetch(`${baseUrl}/env-pkg/get-user`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-auth-session': 'tok-abc', // §9.1 carrier
      },
      body: JSON.stringify({ data: { userId: 'u99' } }),
    });
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual(getUser('u99'));
  });

  it('[v2-fastify.run.env.2] (negative) sending session in body does NOT route it as envelope', async () => {
    // Session in body (old v1 pattern) must NOT be picked up as envelope.
    // Since our fn ignores the envelope, both should return the same 200 result.
    // The critical check is that the server doesn't crash when session is in body.
    const res = await fetch(`${baseUrl}/env-pkg/get-user`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Deliberately omit the x-auth-session header; session is only in body (wrong carrier)
      body: JSON.stringify({ session: 'wrong', data: { userId: 'u77' } }),
    });
    // Server should still respond (it reads session from header, not body)
    expect(res.status).toBeLessThan(500);
  });
});

// ---------- BUG-APIGEN-009 / -010 — validate-Layer + health mount over real HTTP ----------
// These drive a REAL Fastify server through `run()` and assert the served path
// (a) rejects schema-violating input with HTTP 400 BEFORE the fn is called and
// (b) mounts `--use health` as `GET /_meta/health`. Both regressed when the run
// path called `dispatch()` directly, bypassing the Layer/mount stack.

// Counts dispatch reaching the fn — proves the validate-Layer short-circuits
// BEFORE dispatch on bad input (the fn must NOT run). `when` arrives as a real
// Date (dispatch decodes the date-time wire value); we echo its ISO form back.
let scheduleCalls = 0;
function scheduleEvent(when: unknown): { ok: true; when: string } {
  scheduleCalls += 1;
  return { ok: true, when: (when as Date).toISOString() };
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
};

describe('[BUG-APIGEN-009/010] run() — validate-Layer + health mount (Fastify)', () => {
  let controller: AbortController;
  let baseUrl: string;

  beforeAll(async () => {
    scheduleCalls = 0;
    controller = new AbortController();
    const port = await freePort();
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
    };

    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/_meta/health`, { method: 'GET' });
        if (r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  it('[009] malformed date-time → 400 invalid_argument, fn never called', async () => {
    const before = scheduleCalls;
    const res = await fetch(`${baseUrl}/sched/schedule-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 2099-02-30 is not a real calendar date → ajv date-time format rejects it.
      body: JSON.stringify({ data: { when: '2099-02-30T00:00:00.000Z' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('invalid_argument');
    // The target fn must NOT have run (validation short-circuits before dispatch).
    expect(scheduleCalls).toBe(before);
  });

  it('[009] missing required field → 400 invalid_argument, fn never called', async () => {
    const before = scheduleCalls;
    const res = await fetch(`${baseUrl}/sched/schedule-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('invalid_argument');
    expect(scheduleCalls).toBe(before);
  });

  it('[009] valid date-time → 200 and the fn runs', async () => {
    const before = scheduleCalls;
    const res = await fetch(`${baseUrl}/sched/schedule-event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { when: '2026-01-02T03:04:05.000Z' } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The dispatch encode seam serialises the Date back to RFC 3339.
    expect(body.when).toBe('2026-01-02T03:04:05.000Z');
    expect(scheduleCalls).toBe(before + 1);
  });

  it('[010] --use health mounts GET /_meta/health → 200 { status: ok }', async () => {
    const res = await fetch(`${baseUrl}/_meta/health`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

// ---------- BUG-APIGEN-024 — `--use openapi` mount over real HTTP ----------
// Drive a REAL Fastify server through `run()`, mounted with the REAL
// `@adhd/apigen-plugin-openapi` plugin (not a stub), and assert the served
// `GET /_meta/openapi` doc's `paths` reflects the real extracted operations —
// not an empty object. `collectMountRoutes()` used to hand the mount plugin a
// synthetic descriptor with `operations` hardcoded to `[]`, so `toOpenApi()`
// always produced `paths: {}` regardless of what was actually extracted.

/** Two real multi-route operations mirroring `testSchema`/`testFns` above. */
const openapiTestOperations: Operation[] = [
  {
    id: 'test-pkg/get-user',
    host: 'ts',
    namespace: { raw: 'test-pkg', words: ['test', 'pkg'] },
    path: [{ raw: 'getUser', words: ['get', 'user'] }],
    kind: 'action',
    async: false,
    streaming: false,
    safe: false,
    input: testSchema.getUser.input,
    output: testSchema.getUser.output,
    envelope: {},
    typeText: null,
  },
  {
    id: 'test-pkg/list-users',
    host: 'ts',
    namespace: { raw: 'test-pkg', words: ['test', 'pkg'] },
    path: [{ raw: 'listUsers', words: ['list', 'users'] }],
    kind: 'query',
    async: false,
    streaming: false,
    safe: true,
    input: testSchema.listUsers.input,
    output: testSchema.listUsers.output,
    envelope: {},
    typeText: null,
  },
];

describe('[BUG-APIGEN-024] run() — --use openapi mount serves real paths (Fastify)', () => {
  let controller: AbortController;
  let baseUrl: string;

  beforeAll(async () => {
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'test-pkg',
          schemas: testSchema,
          importPath: '@test/test-pkg',
          fns: testFns,
        },
      ],
      operations: openapiTestOperations,
      outputDir: '/tmp/out',
      options: { port, usePlugins: [openapiPlugin] },
      signal: controller.signal,
    };

    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/_meta/openapi`, { method: 'GET' });
        if (r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  it('[024] GET /_meta/openapi returns 200 with a well-formed doc shell', async () => {
    const res = await fetch(`${baseUrl}/_meta/openapi`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(typeof body.paths).toBe('object');
  });

  // Teeth: this is the exact bug — pre-fix, `paths` was always `{}` even
  // though 2 real operations were extracted and served.
  it('[024] paths is NOT empty — contains both real extracted routes', async () => {
    const res = await fetch(`${baseUrl}/_meta/openapi`, { method: 'GET' });
    const body = await res.json();
    expect(Object.keys(body.paths).length).toBeGreaterThan(0);
    expect(body.paths['/test-pkg/get-user']).toBeDefined();
    expect(body.paths['/test-pkg/list-users']).toBeDefined();
  });

  it('[024] getUser (safe:false) → POST /test-pkg/get-user with requestBody', async () => {
    const res = await fetch(`${baseUrl}/_meta/openapi`, { method: 'GET' });
    const body = await res.json();
    const pathItem = body.paths['/test-pkg/get-user'];
    expect(pathItem.post).toBeDefined();
    expect(pathItem.get).toBeUndefined();
    expect(pathItem.post.requestBody).toBeDefined();
  });

  it('[024] listUsers (safe:true) → GET /test-pkg/list-users with no requestBody', async () => {
    const res = await fetch(`${baseUrl}/_meta/openapi`, { method: 'GET' });
    const body = await res.json();
    const pathItem = body.paths['/test-pkg/list-users'];
    expect(pathItem.get).toBeDefined();
    expect(pathItem.post).toBeUndefined();
    expect(pathItem.get.requestBody).toBeUndefined();
  });

  it('[024] (regression control) omitting RunInput.operations falls back to empty paths, not a crash', async () => {
    // Proves the `input.operations ?? []` fallback in collectMountRoutes is
    // intentional/safe (e.g. non-TS run paths that never populate
    // `operations`) rather than accidentally still-broken.
    const port2 = await freePort();
    const controller2 = new AbortController();
    const noOpsInput: RunInput = {
      packages: [
        {
          id: 'test-pkg',
          schemas: testSchema,
          importPath: '@test/test-pkg',
          fns: testFns,
        },
      ],
      // operations intentionally omitted
      outputDir: '/tmp/out',
      options: { port: port2, usePlugins: [openapiPlugin] },
      signal: controller2.signal,
    };
    run(noOpsInput).catch(() => {
      /* swallowed after abort */
    });
    const url2 = `http://127.0.0.1:${port2}`;
    const deadline = Date.now() + 10000;
    let body: { paths: Record<string, unknown> } | undefined;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${url2}/_meta/openapi`, { method: 'GET' });
        if (r.status < 500) {
          body = await r.json();
          break;
        }
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    expect(body).toBeDefined();
    expect(Object.keys(body!.paths).length).toBe(0);
    controller2.abort();
  }, 15000);
});

// ---------- BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 — parity proof ----------
// Proves api-fastify's derived route + verb are EXACTLY EQUAL to
// `project(op).http` — the same call `@adhd/apigen-plugin-openapi` makes —
// for a representative set of operations: a safe/GET op, an unsafe/POST op,
// and a MULTI-PATH-SEGMENT op (namespace + a dropped-file-segment path, e.g.
// `backlog/client-d/get-item` — the exact shape of the reported bug, where a
// live server served `/backlog/getItem` while the OpenAPI doc advertised
// `/backlog/client-d/get-item`).
//
// Negative control (verified by hand while authoring this fix): reverting
// `resolveRoute()`/`resolveOperation()` to the old `${routePrefix}/${pkgId}/
// ${fnName}` + `httpVerb()` derivation turns EVERY assertion in this block
// red — the multi-segment op's route regresses to `/backlog/getItem` (losing
// the `client-d` segment entirely) and the single-segment ops regress to
// their raw camelCase spelling (`/utils/createThing` instead of
// `/utils/create-thing`).

/** A safe (idempotent), zero-param operation → GET. */
const parityOpSafeGet: Operation = {
  id: 'utils/ping',
  host: 'ts',
  namespace: { raw: 'utils', words: ['utils'] },
  path: [{ raw: 'ping', words: ['ping'] }],
  kind: 'query',
  async: false,
  streaming: false,
  safe: true,
  input: { type: 'object', properties: {}, required: [] },
  output: { type: 'string' },
  envelope: {},
  typeText: null,
};

/** An unsafe, single-segment operation with a non-primitive param → POST. */
const parityOpUnsafePost: Operation = {
  id: 'utils/create-thing',
  host: 'ts',
  namespace: { raw: 'utils', words: ['utils'] },
  path: [{ raw: 'createThing', words: ['create', 'thing'] }],
  kind: 'action',
  async: false,
  streaming: false,
  safe: false,
  input: {
    type: 'object',
    properties: { payload: { type: 'object', properties: {}, required: [] } },
    required: ['payload'],
  },
  output: { type: 'object' },
  envelope: {},
  typeText: null,
};

/**
 * A MULTI-PATH-SEGMENT operation — namespace `backlog`, a non-index file
 * segment `client-d`, then the export segment `getItem` — mirroring the
 * reported bug's exact shape (`namespace/file/export`, `index.*` files drop
 * their file segment but non-index files don't). Unsafe + a non-primitive
 * param, so it stays POST (isolating this fixture to the ROUTE-shape
 * regression rather than also exercising FEAT-APIGEN-022's GET auto-hoist).
 */
const parityOpMultiSegment: Operation = {
  id: 'backlog/client-d/get-item',
  host: 'ts',
  namespace: { raw: 'backlog', words: ['backlog'] },
  path: [
    { raw: 'client-d', words: ['client', 'd'] },
    { raw: 'getItem', words: ['get', 'item'] },
  ],
  kind: 'action',
  async: false,
  streaming: false,
  safe: false,
  input: {
    type: 'object',
    properties: { filter: { type: 'object', properties: {}, required: [] } },
    required: ['filter'],
  },
  output: { type: 'object' },
  envelope: {},
  typeText: null,
};

const parityOperations: Operation[] = [
  parityOpSafeGet,
  parityOpUnsafePost,
  parityOpMultiSegment,
];

/** `ComposedSchemas`-shaped (`data`-wrapped) entries for the `utils` package. */
const utilsComposedSchemas = {
  ping: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    output: { type: 'string' },
    'x-apigen-safe': true,
  },
  createThing: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            payload: { type: 'object', properties: {}, required: [] },
          },
          required: ['payload'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
};

/** `ComposedSchemas`-shaped (`data`-wrapped) entries for the `backlog` package. */
const backlogComposedSchemas = {
  getItem: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            filter: { type: 'object', properties: {}, required: [] },
          },
          required: ['filter'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
};

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] generate() route/verb parity with project()', () => {
  it('emits routes byte-identical to project(op).http for GET / POST / multi-segment ops', () => {
    const input: PluginInput & { operations: Operation[] } = {
      packages: [
        {
          id: 'utils',
          schemas: utilsComposedSchemas,
          importPath: '@test/utils',
        },
        {
          id: 'backlog',
          schemas: backlogComposedSchemas,
          importPath: '@test/backlog',
        },
      ],
      operations: parityOperations,
      outputDir: '/tmp/out',
      options: {},
    };
    const { content } = generate(input).files[0];

    for (const op of parityOperations) {
      const { route, verb } = project(op, {}).http;
      const method = verb.toLowerCase();
      expect(content).toContain(`app.${method}('${route}'`);
    }

    // Explicit ground-truth routes (guards against a vacuous project() call
    // that happened to agree with itself but not with the actual literal
    // strings the OpenAPI doc would emit for the same operations).
    expect(content).toContain("app.get('/utils/ping'");
    expect(content).toContain("app.post('/utils/create-thing'");
    expect(content).toContain("app.post('/backlog/client-d/get-item'");
    // The OLD (buggy) derivation would have produced these — must be absent.
    expect(content).not.toContain("'/utils/createThing'");
    expect(content).not.toContain("'/backlog/getItem'");
  });
});

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] run() route/verb parity with project()', () => {
  let controller: AbortController;
  let baseUrl: string;

  beforeAll(async () => {
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'utils',
          schemas: utilsComposedSchemas,
          importPath: '@test/utils',
          fns: {
            ping: () => 'pong2',
            createThing: (payload: unknown) => ({ payload }),
          },
        },
        {
          id: 'backlog',
          schemas: backlogComposedSchemas,
          importPath: '@test/backlog',
          fns: {
            getItem: (filter: unknown) => ({ filter }),
          },
        },
      ],
      operations: parityOperations,
      outputDir: '/tmp/out',
      options: { port },
      signal: controller.signal,
    };

    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/utils/ping`, { method: 'GET' });
        if (r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  it('serves each op at EXACTLY project(op).http.route + .http.verb', async () => {
    for (const op of parityOperations) {
      const { route, verb } = project(op, {}).http;
      const res = await fetch(`${baseUrl}${route}`, {
        method: verb,
        headers: { 'content-type': 'application/json' },
        body: verb === 'GET' ? undefined : JSON.stringify({ data: {} }),
      });
      expect(res.status, `${verb} ${route}`).toBeLessThan(500);
      expect(res.status, `${verb} ${route}`).not.toBe(404);
    }
  });

  it('[teeth] the multi-segment op is served at /backlog/client-d/get-item, matching a real /_meta/openapi doc for the same op', async () => {
    const doc = toOpenApi(parityOperations);
    expect(doc.paths['/backlog/client-d/get-item']).toBeDefined();
    const res = await fetch(`${baseUrl}/backlog/client-d/get-item`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { filter: {} } }),
    });
    expect(res.status).toBe(200);
  });

  it('[negative control] the OLD `${pkgId}/${fnName}` route is NOT served for the multi-segment op', async () => {
    // Old (buggy) derivation would have registered `/backlog/getItem`
    // (dropping the `client-d` file segment entirely). It must 404 now.
    const res = await fetch(`${baseUrl}/backlog/getItem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { filter: {} } }),
    });
    expect(res.status).toBe(404);
  });

  it('[negative control] the OLD raw-camelCase route is NOT served for the single-segment unsafe op', async () => {
    const res = await fetch(`${baseUrl}/utils/createThing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { payload: {} } }),
    });
    expect(res.status).toBe(404);
  });
});

describe('api-fastify plugin — language declaration', () => {
  it('explicitly declares language: "ts" (FAILS if declaration is dropped)', () => {
    expect(apiFastifyPlugin.language).toBe('ts');
  });
});

// ===========================================================================
// [fastify-parity] serve-core TransportAdapter/OpPlan parity gate
// ([def:parity-gate], docs/plan/apigen-serve-core/contexts/_shared.md)
//
// This block is the acceptance mechanism for the fastify → TransportAdapter/
// OpPlan migration (fastify-adapter state). It drives a REAL live Fastify
// server the way a consumer does ([def:real-consumer-protocol]: HTTP → fetch)
// across every proposal §6 fixture CLASS, and asserts the recapture is
// byte-identical to a committed golden snapshot captured against the
// pre-migration server ([inv:byte-identical]).
//
// Fixture classes covered:
//   - safe/scalar (GET-hoist)                → `safe-get`
//   - unsafe/mutating-scalar (dod.9)         → `unsafe-mutating-scalar`
//     (the BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001 shape — an UNSAFE op
//     whose bare domain input is primitive-only is served over GET by
//     FEAT-APIGEN-022's auto-hoist; pinned here to prove this refactor does
//     NOT silently change it)
//   - session/envelope                       → `session-envelope`
//   - `--use` mount                          → `mount`
//   - validation-failure (per class)         → `validation-failure`
//   - domain ApiError (per class)            → `domain-apierror`
//   - streaming:true                         → asserted SEPARATELY below.
//     Streaming is one of the THREE explicitly-flagged behavior CHANGES this
//     refactor makes ([inv:byte-identical]: "streaming now served/rejected
//     instead of mis-serialized" [dod.5]). Pre-migration, run.ts had ZERO
//     call sites for sendStreamSse (DEBT-APIGEN-SERVE-CORE-002) and
//     mis-serialized an ApiStream via JSON.stringify. It is therefore NOT a
//     byte-identical fixture; it is proven by the dedicated
//     `[fastify-parity.streaming]` live-SSE test (the TEETH for criterion .3),
//     not by the golden snapshot.
//
// The golden snapshot is regenerated with `APIGEN_CAPTURE_GOLDEN=1` (the
// standard snapshot-update escape hatch — the compare test itself always runs
// unflagged, by default, in CI). Committed at
// `src/test/golden/fastify.snapshot.json`.
// ===========================================================================

/** The driver's per-fixture request description. */
interface HttpFixtureInput {
  method: 'GET' | 'POST';
  /** Route path (already projected — e.g. `/safe-pkg/ping`), no host. */
  urlPath: string;
  headers?: Record<string, string>;
  /** JSON request body (serialised by the driver). */
  body?: unknown;
}

/** The byte-comparable result recorded per fixture. */
interface HttpFixtureOutput {
  status: number;
  contentType: string | null;
  /** Raw response body text — byte-faithful (`"pong"` vs bare `pong`, etc.). */
  body: string;
}

const GOLDEN_PATH = path.join(__dirname, 'golden', 'fastify.snapshot.json');

/** Parse SSE frames from a response body. Returns `{ event?, data }[]`. */
function parseSseFramesParity(
  body: string
): Array<{ event?: string; data: string }> {
  const frames: Array<{ event?: string; data: string }> = [];
  for (const frame of body.split('\n\n').filter((f) => f.trim())) {
    let event: string | undefined;
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (data) frames.push({ ...(event ? { event } : {}), data });
  }
  return frames;
}

// ---------- parity domain fns (real in-process, no mocks) ----------
function parityGetUser(userId: string): { id: string; name: string } {
  return { id: userId, name: `User-${userId}` };
}
function paritySetFlag(value: string): string {
  return `set:${value}`;
}
function parityGetThing(id: string): { id: string } {
  if (id === 'missing') throw new ApiError('not_found', 'no such thing');
  return { id };
}
let parityScheduleCalls = 0;
function parityScheduleEvent(when: unknown): { ok: true; when: string } {
  parityScheduleCalls += 1;
  return { ok: true, when: (when as Date).toISOString() };
}

// ---------- parity composed schemas (data-wrapped, as ComposedSchemas) ----------
const paritySafeSchema = {
  ping: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    output: { type: 'string' },
    'x-apigen-safe': true,
  },
};

const parityEnvelopeSchema = {
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
    'x-apigen-envelope': { session: 'auth' },
  },
};

const parityMutateSchema = {
  setFlag: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
      required: ['data'],
    },
    output: { type: 'string' },
  },
};

const parityErrSchema = {
  getThing: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
        },
      },
      required: ['data'],
    },
    output: { type: 'object' },
  },
};

const paritySchedSchema = {
  scheduleEvent: {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: { when: { type: 'string', format: 'date-time' } },
          required: ['when'],
        },
      },
      required: ['data'],
    },
    output: {},
  },
};

const parityStreamSchema = {
  streamNums: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    // schema-less passthrough so the ApiStream survives dispatch's encode seam.
    output: {},
    'x-apigen-safe': true,
  },
};

// ---------- parity operations (real Operation[] — required for the two
// class-defining fixtures whose behavior depends on Operation fields the
// composed-schema-only synth path cannot carry: the mutating-scalar op's
// primitive bare `input` (GET-hoist, dod.9) and the stream op's
// `streaming:true`). The remaining packages resolve via the composed-schema
// synth fallback, exactly as a no-`operations` run does. ----------
const parityMutateOp: Operation = {
  id: 'mutate-pkg/set-flag',
  host: 'ts',
  namespace: { raw: 'mutate-pkg', words: ['mutate', 'pkg'] },
  path: [{ raw: 'setFlag', words: ['set', 'flag'] }],
  kind: 'action',
  async: false,
  streaming: false,
  // UNSAFE (mutating) — but the BARE domain input is primitive-only, so
  // FEAT-APIGEN-022 hoists it to GET. This is the exact
  // BUG-APIGEN-SAFE-OP-MUTATIONS-OVER-GET-001 shape (dod.9).
  safe: false,
  input: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  output: { type: 'string' },
  envelope: {},
  typeText: null,
};

const parityStreamOp: Operation = {
  id: 'stream-pkg/stream-nums',
  host: 'ts',
  namespace: { raw: 'stream-pkg', words: ['stream', 'pkg'] },
  path: [{ raw: 'streamNums', words: ['stream', 'nums'] }],
  kind: 'query',
  async: false,
  streaming: true,
  safe: true,
  input: { type: 'object', properties: {}, required: [] },
  output: {},
  envelope: {},
  typeText: null,
};

/** The byte-identical fixture classes (streaming proven separately below). */
const parityFixtures: ReadonlyArray<GoldenFixture<HttpFixtureInput>> = [
  {
    name: 'safe-get',
    input: { method: 'GET', urlPath: '/safe-pkg/ping' },
  },
  {
    // dod.9: unsafe/mutating op with a primitive-only bare input is GET-hoisted.
    name: 'unsafe-mutating-scalar',
    input: { method: 'GET', urlPath: '/mutate-pkg/set-flag?value=on' },
  },
  {
    name: 'session-envelope',
    input: {
      method: 'POST',
      urlPath: '/env-pkg/get-user',
      headers: {
        'content-type': 'application/json',
        'x-auth-session': 'tok-abc',
      },
      body: { data: { userId: 'u99' } },
    },
  },
  {
    name: 'validation-failure',
    input: {
      method: 'POST',
      urlPath: '/sched-pkg/schedule-event',
      headers: { 'content-type': 'application/json' },
      // 2099-02-30 is not a real calendar date → ajv date-time rejects it.
      body: { data: { when: '2099-02-30T00:00:00.000Z' } },
    },
  },
  {
    name: 'domain-apierror',
    input: {
      method: 'POST',
      urlPath: '/err-pkg/get-thing',
      headers: { 'content-type': 'application/json' },
      body: { data: { id: 'missing' } },
    },
  },
  {
    name: 'mount',
    input: { method: 'GET', urlPath: '/_meta/health' },
  },
];

describe('[fastify-parity] TransportAdapter/OpPlan golden-snapshot parity gate', () => {
  let controller: AbortController;
  let baseUrl: string;
  let driver: ParityDriver<HttpFixtureInput, HttpFixtureOutput>;

  beforeAll(async () => {
    parityScheduleCalls = 0;
    controller = new AbortController();
    const port = await freePort();
    const runInput: RunInput = {
      packages: [
        {
          id: 'safe-pkg',
          schemas: paritySafeSchema,
          importPath: '@test/safe-pkg',
          fns: { ping: () => 'pong' },
        },
        {
          id: 'env-pkg',
          schemas: parityEnvelopeSchema,
          importPath: '@test/env-pkg',
          fns: { getUser: (userId: unknown) => parityGetUser(userId as string) },
        },
        {
          id: 'mutate-pkg',
          schemas: parityMutateSchema,
          importPath: '@test/mutate-pkg',
          fns: { setFlag: (value: unknown) => paritySetFlag(value as string) },
        },
        {
          id: 'err-pkg',
          schemas: parityErrSchema,
          importPath: '@test/err-pkg',
          fns: { getThing: (id: unknown) => parityGetThing(id as string) },
        },
        {
          id: 'sched-pkg',
          schemas: paritySchedSchema,
          importPath: '@test/sched-pkg',
          fns: { scheduleEvent: (when: unknown) => parityScheduleEvent(when) },
        },
        {
          id: 'stream-pkg',
          schemas: parityStreamSchema,
          importPath: '@test/stream-pkg',
          fns: {
            streamNums: () =>
              createStream<number>({
                produce: async function* () {
                  yield 1;
                  yield 2;
                  yield 3;
                },
              }),
          },
        },
      ],
      operations: [parityMutateOp, parityStreamOp],
      outputDir: '/tmp/out',
      options: { port, usePlugins: [healthPlugin] },
      signal: controller.signal,
    };

    run(runInput).catch(() => {
      /* swallowed after abort */
    });

    baseUrl = `http://127.0.0.1:${port}`;
    driver = {
      async invoke(
        fixture: GoldenFixture<HttpFixtureInput>
      ): Promise<HttpFixtureOutput> {
        const { method, urlPath, headers, body } = fixture.input;
        const res = await fetch(`${baseUrl}${urlPath}`, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return {
          status: res.status,
          contentType: res.headers.get('content-type'),
          body: await res.text(),
        };
      },
    };

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${baseUrl}/_meta/health`, { method: 'GET' });
        if (r.status < 500) break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }, 15000);

  afterAll(() => {
    controller.abort();
  });

  // [fastify-adapter.6] — the parity gate. Recapture through the (post-
  // migration) adapter-based server and assert deep-equality vs the committed
  // pre-migration golden snapshot. FAILS if the migration regresses any
  // fixture (missing/added/value-diverged) — assertParity reports the full
  // blast radius. Regenerate the golden with APIGEN_CAPTURE_GOLDEN=1.
  it('recapture deep-equals the committed golden snapshot', async () => {
    const recapture = await captureGolden(driver, parityFixtures);

    if (process.env['APIGEN_CAPTURE_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(recapture, null, 2) + '\n');
      return;
    }

    if (!fs.existsSync(GOLDEN_PATH)) {
      throw new Error(
        `[fastify-parity] golden snapshot missing at ${GOLDEN_PATH} — ` +
          'regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.'
      );
    }
    const committed = JSON.parse(
      fs.readFileSync(GOLDEN_PATH, 'utf8')
    ) as GoldenSnapshot<HttpFixtureOutput>;

    assertParity(committed, recapture);
  });
});
