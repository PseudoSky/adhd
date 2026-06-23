// Canonical contract — envelope-from-metadata (dod.11) + verb-from-safe-with-
// config-override (dod.15), driven through the REAL api-fastify run plugin over
// REAL HTTP. The two test names below are load-bearing: audit-final-v2 keys on
// the substrings `envelope from transport metadata` and
// `verb from safe with config override`.
//
// REAL components: `@adhd/apigen-plugin-api-fastify`'s `run` (a live Fastify
// server), `@adhd/apigen-runtime`'s `dispatch`, `@adhd/apigen-naming`'s envelope
// key + projection-config. Only the domain fns are local — everything that
// implements the contract under test is the real component.
//
// Determinism (CLAUDE.md §6): the server is started on an ephemeral port, awaited
// via a bounded readiness poll (no sleep), and ALWAYS closed via the abort
// controller in afterEach (no orphan listeners).

import { describe, it, expect, afterEach } from 'vitest'
import { run as runFastify } from '@adhd/apigen-plugin-api-fastify'
import { envelopeKey } from '@adhd/apigen-naming'
import type { RunInput } from '@adhd/apigen-core'
import type { ComposedSchemas } from '@adhd/apigen-runtime'

// ---------------------------------------------------------------------------
// Server lifecycle — one abort controller per test, always torn down.
// ---------------------------------------------------------------------------

let controller: AbortController | undefined
let serverPromise: Promise<void> | undefined

afterEach(async () => {
  controller?.abort()
  // Wait for the run() promise to settle (server closed) — bounded.
  if (serverPromise) {
    await Promise.race([
      serverPromise,
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
  }
  controller = undefined
  serverPromise = undefined
})

/** Pick a high ephemeral port deterministically per-test to avoid clashes. */
function startServer(input: Omit<RunInput, 'signal'>, port: number): Promise<void> {
  controller = new AbortController()
  serverPromise = runFastify({ ...input, signal: controller.signal })
  return waitForReady(port)
}

/** Bounded readiness poll — no fixed sleep. */
async function waitForReady(port: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      // Any response (even 404) means the listener is up.
      await fetch(`http://127.0.0.1:${port}/__ready_probe__`, { method: 'GET' })
      return
    } catch {
      await new Promise<void>((r) => setTimeout(r, 25))
    }
  }
  throw new Error(`server on port ${port} did not become ready within 5s`)
}

// ---------------------------------------------------------------------------
// (1) Envelope from transport metadata — dod.11
// ---------------------------------------------------------------------------

describe('canonical: envelope binding', () => {
  it('envelope from transport metadata: header populates envelope, body does NOT', async () => {
    const port = 47561

    // A fn whose FIRST param is `ctx` — dispatch passes it the client built from
    // the envelope's `session`. The fn echoes the session it received, so the
    // HTTP response reveals exactly what reached the envelope.
    const whoAmI = (ctx: { session?: unknown }): { session: unknown } => ({
      session: ctx?.session ?? null,
    })

    // Composed schema declaring a top-level `session` envelope field (alongside
    // the always-present `data` wrapper). This is what makes dispatch source the
    // session from the envelope. `x-apigen-safe: true` → GET so envelope comes
    // from headers (the metadata channel) and data from the query string.
    const schemas: ComposedSchemas = {
      whoAmI: {
        input: {
          type: 'object',
          properties: {
            session: { type: 'string' },
            data: { type: 'object', properties: {} },
          },
          required: ['data'],
        },
        output: { type: 'object' },
        // @ts-expect-error — x-apigen-safe is an extractor-derived hint key.
        'x-apigen-safe': true,
      },
    }

    const input: Omit<RunInput, 'signal'> = {
      packages: [
        {
          id: 'pkg',
          schemas,
          importPath: '',
          fns: { whoAmI: whoAmI as (...a: unknown[]) => unknown },
          // createClient returns the envelope itself as the ctx — so whoAmI's
          // `ctx.session` is exactly the session dispatch pulled from the envelope.
          createClient: async (envelope) => envelope,
        },
      ],
      outputDir: '',
      options: { port },
    }
    await startServer(input, port)

    const sessionHeader = envelopeKey('adhd', 'session') // 'x-adhd-session'

    // (a) session supplied via transport METADATA (header) → reaches envelope.
    const withHeader = await fetch(`http://127.0.0.1:${port}/pkg/whoAmI`, {
      method: 'GET',
      headers: { [sessionHeader]: 'sess-from-header' },
    })
    const headerBody = (await withHeader.json()) as { session: unknown }
    expect(headerBody.session).toBe('sess-from-header')

    // (b) same field placed ONLY in the request body — must NOT reach envelope.
    //     (GET has no body; we send the would-be value as a query param named
    //      `session`, which is the BODY/data channel, not metadata. It must be
    //      ignored for the envelope.)
    const withBody = await fetch(
      `http://127.0.0.1:${port}/pkg/whoAmI?session=sess-from-body`,
      { method: 'GET' },
    )
    const bodyBody = (await withBody.json()) as { session: unknown }
    // Negative control: the body-sourced value did NOT populate the envelope.
    expect(bodyBody.session).toBeNull()
    expect(bodyBody.session).not.toBe('sess-from-body')
  })
})

// ---------------------------------------------------------------------------
// (2) Verb from safe, with projection-config override — dod.15
// ---------------------------------------------------------------------------

describe('canonical: HTTP verb derivation', () => {
  it('verb from safe with config override: safe->GET, action->POST, config flips action to GET', async () => {
    const port = 47562

    // `queryOp` is safe (x-apigen-safe:true) → GET. `actionOp` is unsafe → POST
    // by default; an out-of-source projection-config override flips it to GET
    // with NO change to the schema's safe flag (Tenet 1).
    const schemas: ComposedSchemas = {
      queryOp: {
        input: { type: 'object', properties: { data: { type: 'object', properties: {} } }, required: ['data'] },
        output: { type: 'object' },
        // @ts-expect-error — extractor hint key.
        'x-apigen-safe': true,
      },
      actionOp: {
        input: { type: 'object', properties: { data: { type: 'object', properties: {} } }, required: ['data'] },
        output: { type: 'object' },
        // no x-apigen-safe → defaults to POST.
      },
    }

    const input: Omit<RunInput, 'signal'> = {
      packages: [
        {
          id: 'pkg',
          schemas,
          importPath: '',
          fns: {
            queryOp: () => ({ result: 'query-result' }),
            actionOp: () => ({ result: 'action-result' }),
          },
          createClient: async (e) => e,
        },
      ],
      outputDir: '',
      options: {
        port,
        // Out-of-source override: force pkg:actionOp to GET. Source (the schema's
        // missing x-apigen-safe) is untouched.
        projection: { http: { verb: { 'pkg:actionOp': 'GET' } } },
      },
    }
    await startServer(input, port)

    // queryOp is safe → served as GET (POST should 404 / not be registered).
    const queryGet = await fetch(`http://127.0.0.1:${port}/pkg/queryOp`, { method: 'GET' })
    expect(queryGet.status).toBe(200)
    expect(await queryGet.json()).toEqual({ result: 'query-result' })

    // actionOp would default to POST, but the override forces GET — so GET works.
    const actionGet = await fetch(`http://127.0.0.1:${port}/pkg/actionOp`, { method: 'GET' })
    expect(actionGet.status).toBe(200)
    expect(await actionGet.json()).toEqual({ result: 'action-result' })

    // Negative control: with the override active, the action is NOT served on POST
    // (it moved to GET). A regression that ignores the override leaves it on POST,
    // so POST would 200 and GET would 404 — flipping both assertions.
    const actionPost = await fetch(`http://127.0.0.1:${port}/pkg/actionOp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    })
    expect(actionPost.status).toBe(404)
  })
})
