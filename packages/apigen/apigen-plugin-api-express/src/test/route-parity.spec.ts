/**
 * Regression test for BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001
 * (packages/apigen/apigen-plugin-api-express/BACKLOG.md): `generate()` and
 * `run()` used to hand-roll `${routePrefix}/${pkg.id}/${fnName}` — the raw,
 * un-kebab-cased export name, never run through `@adhd/apigen-engine-naming`'s
 * `project()` — so a served/generated route never matched
 * `project(op).http.route`, the EXACT formula `@adhd/apigen-plugin-openapi`
 * uses to build the OpenAPI spec's `paths`. A client generated FROM the spec
 * called a route the server never registered → 404.
 *
 * Proof, for a representative op set (unsafe/POST, safe/GET, and a genuine
 * MULTI-SEGMENT `Operation.path` — the shape a non-`index.*` source file
 * produces, per `Operation.path`'s own doc comment: a named export is
 * `[file, name]`):
 *
 *   1. [POSITIVE] api-express's derived route + verb are byte-identical to
 *      `project(op, {}).http` for the SAME `Operation` — the exact call
 *      `apigen-plugin-openapi` makes — proven both for `generate()`'s codegen
 *      output AND for `run()`'s REAL, live-dispatched Express server (no
 *      mocks: a real HTTP round-trip through a real server, real validate
 *      layer, real fn dispatch).
 *   2. [NEGATIVE CONTROL] the OLD `${pkgId}/${fnName}` formula is proven to
 *      diverge from `project(op).http.route` for every multi-word case below
 *      (this is what makes the assertions above have teeth — they would have
 *      failed red against the pre-fix code), and `run()`'s live server is
 *      proven to 404 on the OLD route while the NEW, spec-matching route
 *      dispatches successfully end-to-end.
 *
 * `run()` achieves full parity for the MULTI-SEGMENT case because
 * `RunInput.operations` carries the real `Operation[]` (BUG-APIGEN-024).
 * `generate()`'s `PluginInput` carries no `Operation[]` at all, so its codegen
 * path can only recover a single-path-segment route from `(pkgId, fnName)` —
 * see `../lib/route.ts`'s header comment for the documented limitation and
 * the BACKLOG entry tracking full `PluginInput` parity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generate } from '../lib/generate';
import { run } from '../lib/run';
import healthPlugin from '@adhd/apigen-plugin-health';
import type {
  Operation,
  PluginInput,
  RunInput,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { ApiError } from '@adhd/apigen-base-errors';
import {
  captureGolden,
  assertParity,
} from '@adhd/apigen-engine-runtime/test-support';
import type {
  GoldenFixture,
  GoldenSnapshot,
  ParityDriver,
} from '@adhd/apigen-engine-runtime/test-support';

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

// ---------------------------------------------------------------------------
// Representative op set — real `Operation` fixtures, the same shape the TS
// extractor produces.
// ---------------------------------------------------------------------------

/** unsafe/POST, multi-word namespace + fn name, single-segment path. */
const unsafeOp: Operation = {
  id: 'my-api/get-user-profile',
  host: 'ts',
  namespace: { raw: 'my-api', words: ['my', 'api'] },
  path: [{ raw: 'getUserProfile', words: ['get', 'user', 'profile'] }],
  kind: 'action',
  async: true,
  streaming: false,
  safe: false,
  // A non-primitive (`object`) domain param so FEAT-APIGEN-022's param-shape
  // auto-hoist does NOT flip this to GET — this op is testing the unsafe/POST
  // branch specifically. Properties declared explicitly so the runtime's
  // logical-type decode round-trips them (see `dispatch.ts`'s `decodeArg`,
  // which walks declared `properties` — undeclared bag fields are outside
  // this test's concern, which is route/verb derivation, not decode).
  input: {
    type: 'object',
    properties: {
      filters: {
        type: 'object',
        properties: { active: { type: 'boolean' } },
        required: ['active'],
      },
    },
    required: ['filters'],
  },
  output: { type: 'object' },
  envelope: {},
  typeText: null,
};

/** safe/GET, multi-word namespace + fn name, single-segment path. */
const safeOp: Operation = {
  id: 'my-api/list-all-users',
  host: 'ts',
  namespace: { raw: 'my-api', words: ['my', 'api'] },
  path: [{ raw: 'listAllUsers', words: ['list', 'all', 'users'] }],
  kind: 'action',
  async: true,
  streaming: false,
  safe: true,
  input: { type: 'object', properties: {}, required: [] },
  output: { type: 'array' },
  envelope: {},
  typeText: null,
};

/**
 * Genuine MULTI-SEGMENT path (namespace + 2 path segments) — e.g. a
 * `humanize.ts` file exporting `humanizeBytes`. Only `run()` (via
 * `RunInput.operations`) can route this correctly; `generate()`'s
 * `PluginInput` has no `Operation[]` to recover the `humanize` file segment
 * from (see this file's header comment + `../lib/route.ts`).
 */
const multiSegmentOp: Operation = {
  id: 'transform/humanize/humanize-bytes',
  host: 'ts',
  namespace: { raw: 'transform', words: ['transform'] },
  path: [
    { raw: 'humanize', words: ['humanize'] },
    { raw: 'humanizeBytes', words: ['humanize', 'bytes'] },
  ],
  kind: 'action',
  async: true,
  streaming: false,
  safe: false,
  // `array` is explicitly excluded from the primitive-hoist (get-safety.ts),
  // so this stays POST.
  input: {
    type: 'object',
    properties: { values: { type: 'array', items: { type: 'number' } } },
    required: ['values'],
  },
  output: { type: 'number' },
  envelope: {},
  typeText: null,
};

/**
 * `Operation.input` (bare domain schema) → the `ComposedSchemas` shape
 * `generate()`/`run()` actually consume: `data: {}`-wrapped + `x-apigen-safe`
 * stamped — mirrors `compose-schemas.ts`'s real output for `op` exactly
 * (including the `dispatch()`-required `input.properties.data.properties`
 * nesting `dataParamNames()` reads).
 */
function toComposedSchema(op: Operation): Record<string, unknown> {
  const domainProps =
    (op.input['properties'] as Record<string, unknown> | undefined) ?? {};
  const domainRequired = (op.input['required'] as string[] | undefined) ?? [];
  return {
    input: {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: domainProps,
          additionalProperties: false,
          ...(domainRequired.length > 0 ? { required: domainRequired } : {}),
        },
      },
      required: domainRequired.length > 0 ? ['data'] : [],
      additionalProperties: false,
    },
    output: op.output,
    'x-apigen-safe': op.safe,
  };
}

/** The terminal (dispatch-table) key for an op's path — orchestrator.ts's `buildDescriptor` Step 5 convention. */
function terminalFnName(op: Operation): string {
  return op.path[op.path.length - 1].raw;
}

describe('[BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001] route/verb parity with project(op).http', () => {
  // -------------------------------------------------------------------------
  // generate() — static codegen
  // -------------------------------------------------------------------------
  describe('generate() — codegen route/verb byte-identical to project(op).http', () => {
    it('[positive] unsafe op → POST at exactly project(op).http.route', () => {
      const expected = project(unsafeOp, {}).http;
      expect(expected).toEqual({
        verb: 'POST',
        route: '/my-api/get-user-profile',
      });

      const input: PluginInput = {
        packages: [
          {
            id: unsafeOp.namespace.raw,
            schemas: { [terminalFnName(unsafeOp)]: toComposedSchema(unsafeOp) },
            importPath: '@test/my-api',
          },
        ],
        outputDir: '/tmp/out',
        options: {},
      };
      const { content } = generate(input).files[0];
      expect(content).toContain(`router.post('${expected.route}'`);
      expect(content).not.toContain(`router.get('${expected.route}'`);
    });

    it('[positive] safe op → GET at exactly project(op).http.route', () => {
      const expected = project(safeOp, {}).http;
      expect(expected).toEqual({
        verb: 'GET',
        route: '/my-api/list-all-users',
      });

      const input: PluginInput = {
        packages: [
          {
            id: safeOp.namespace.raw,
            schemas: { [terminalFnName(safeOp)]: toComposedSchema(safeOp) },
            importPath: '@test/my-api',
          },
        ],
        outputDir: '/tmp/out',
        options: {},
      };
      const { content } = generate(input).files[0];
      expect(content).toContain(`router.get('${expected.route}'`);
      expect(content).not.toContain(`router.post('${expected.route}'`);
    });

    it('[negative control] the pre-fix `${pkgId}/${fnName}` formula diverges from project(op).http.route — proves this test has teeth', () => {
      const expected = project(unsafeOp, {}).http;
      const oldRoute = `/${unsafeOp.namespace.raw}/${terminalFnName(unsafeOp)}`;
      // The pre-fix code would have emitted `oldRoute`. It must differ from
      // `expected.route` or this test proves nothing.
      expect(oldRoute).toBe('/my-api/getUserProfile');
      expect(oldRoute).not.toBe(expected.route);

      const input: PluginInput = {
        packages: [
          {
            id: unsafeOp.namespace.raw,
            schemas: { [terminalFnName(unsafeOp)]: toComposedSchema(unsafeOp) },
            importPath: '@test/my-api',
          },
        ],
        outputDir: '/tmp/out',
        options: {},
      };
      const { content } = generate(input).files[0];
      expect(content).not.toContain(`'${oldRoute}'`);
      expect(content).toContain(`'${expected.route}'`);
    });
  });

  // -------------------------------------------------------------------------
  // run() — REAL Express server, no mocks
  // -------------------------------------------------------------------------
  describe('run() — REAL Express server route/verb byte-identical to project(op).http', () => {
    let controller: AbortController;
    let baseUrl: string;

    beforeAll(async () => {
      controller = new AbortController();
      const port = await freePort();

      const runInput: RunInput = {
        packages: [
          {
            id: unsafeOp.namespace.raw,
            schemas: {
              [terminalFnName(unsafeOp)]: toComposedSchema(unsafeOp),
            },
            importPath: '@test/my-api',
            fns: {
              [terminalFnName(unsafeOp)]: (filters: unknown) => ({
                ok: true,
                filters,
              }),
            },
          },
          {
            id: safeOp.namespace.raw,
            schemas: { [terminalFnName(safeOp)]: toComposedSchema(safeOp) },
            importPath: '@test/my-api',
            fns: { [terminalFnName(safeOp)]: () => ['alice', 'bob'] },
          },
          {
            id: multiSegmentOp.namespace.raw,
            schemas: {
              [terminalFnName(multiSegmentOp)]:
                toComposedSchema(multiSegmentOp),
            },
            importPath: '@test/transform',
            fns: {
              [terminalFnName(multiSegmentOp)]: (values: unknown) =>
                (values as number[]).length,
            },
          },
        ],
        // BUG-APIGEN-024's mechanism: the REAL merged descriptor, exactly as
        // `orchestrateRun()` threads it through.
        operations: [unsafeOp, safeOp, multiSegmentOp],
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
          const r = await fetch(
            `${baseUrl}${project(safeOp, {}).http.route}`,
            { method: 'GET' }
          );
          if (r.status < 500) break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    }, 15000);

    afterAll(() => {
      controller.abort();
    });

    it('[positive] unsafe op served at project(op).http.route via POST', async () => {
      const expected = project(unsafeOp, {}).http;
      expect(expected).toEqual({
        verb: 'POST',
        route: '/my-api/get-user-profile',
      });
      const res = await fetch(`${baseUrl}${expected.route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { filters: { active: true } } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, filters: { active: true } });
    });

    it('[positive] safe op served at project(op).http.route via GET', async () => {
      const expected = project(safeOp, {}).http;
      expect(expected).toEqual({
        verb: 'GET',
        route: '/my-api/list-all-users',
      });
      const res = await fetch(`${baseUrl}${expected.route}`, {
        method: 'GET',
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(['alice', 'bob']);
    });

    it('[positive] MULTI-SEGMENT op served at project(op).http.route — full path fidelity via RunInput.operations', async () => {
      const expected = project(multiSegmentOp, {}).http;
      expect(expected).toEqual({
        verb: 'POST',
        route: '/transform/humanize/humanize-bytes',
      });
      const res = await fetch(`${baseUrl}${expected.route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { values: [1, 2, 3] } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toBe(3);
    });

    it('[negative control] the pre-fix flat `${pkgId}/${fnName}` route 404s — the exact reported bug (spec client 404s against the server) is fixed', async () => {
      // Pre-fix, `${pkg.id}/${fnName}` (= `transform/humanizeBytes`) is what
      // the server would have registered for `multiSegmentOp` — discarding
      // the `humanize` file segment entirely and never kebab-casing. An
      // OpenAPI-spec-generated client would never call this URL (the spec
      // advertises `/transform/humanize/humanize-bytes`); it must now 404.
      const oldRoute = `/${multiSegmentOp.namespace.raw}/${terminalFnName(
        multiSegmentOp
      )}`;
      expect(oldRoute).toBe('/transform/humanizeBytes');
      expect(oldRoute).not.toBe(project(multiSegmentOp, {}).http.route);

      const res = await fetch(`${baseUrl}${oldRoute}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { values: [1, 2, 3] } }),
      });
      expect(res.status).toBe(404);
    });
  });
});

// ===========================================================================
// [express-parity] serve-core TransportAdapter/OpPlan parity gate
// ([def:parity-gate], docs/plan/apigen-serve-core/contexts/_shared.md)
//
// This block is the acceptance mechanism for the express → TransportAdapter/
// OpPlan migration (express-adapter state), mirroring the committed
// `[fastify-parity]` gate (`apigen-plugin-api-fastify/src/test/plugin.spec.ts`)
// exactly. It drives a REAL live Express server the way a consumer does
// ([def:real-consumer-protocol]: HTTP → fetch) across every byte-identical
// fixture CLASS, and asserts the recapture (through the POST-migration,
// `TransportAdapter`/`OpPlan`-based server) is byte-identical to a committed
// golden snapshot captured against the PRE-migration server
// ([inv:byte-identical]).
//
// Fixture classes covered (express has no streaming — see the migration's
// scope note in `run.ts`'s header comment, so no streaming fixture exists
// here, unlike fastify's):
//   - safe/scalar (GET-hoist)                → `safe-get`
//   - unsafe/mutating-scalar (dod.9)         → `unsafe-mutating-scalar`
//     (an UNSAFE op whose bare domain input is primitive-only is served over
//     GET by FEAT-APIGEN-022's auto-hoist; pinned here to prove this
//     refactor does NOT silently change it — BUG-APIGEN-SAFE-OP-MUTATIONS-
//     OVER-GET-001)
//   - session/envelope                       → `session-envelope`
//   - `--use` mount                          → `mount`
//   - validation-failure (per class)         → `validation-failure`
//   - domain ApiError (per class)            → `domain-apierror`
//
// `void-return` is captured into the SAME golden snapshot file (for the
// historical record — the golden capture protocol always drives every
// fixture through ONE `captureGolden` pass) but is EXCLUDED from the
// `assertParity` byte-identical group and asserted SEPARATELY below: this is
// the ONE intentional, flagged behavior change this migration makes
// ([inv:byte-identical] exception, DEBT-APIGEN-SERVE-CORE-003 —
// `undefined -> null`). Its committed golden value is the PRE-migration
// result (`200`, empty body); the dedicated test proves the POST-migration
// server now sends `200` with body `"null"` instead, and that this genuinely
// differs from the committed pre-migration value (so the fixture has teeth,
// not a copy-pasted no-op assertion).
//
// The golden snapshot is regenerated with `APIGEN_CAPTURE_GOLDEN=1` (the
// standard snapshot-update escape hatch — the compare test itself always
// runs unflagged, by default, in CI). Committed at
// `src/test/golden/express.snapshot.json`.
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
  /** Raw response body text — byte-faithful (`"pong"` vs bare `pong`, an empty string, etc.). */
  body: string;
}

const GOLDEN_PATH = path.join(__dirname, 'golden', 'express.snapshot.json');

/** The one fixture name EXCLUDED from the byte-identical parity group (DEBT-003). */
const VOID_RETURN_FIXTURE = 'void-return';

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
function parityScheduleEvent(when: unknown): { ok: true; when: string } {
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

/** DEBT-APIGEN-SERVE-CORE-003 fixture: a void-returning (no-domain-output) op. */
const parityVoidSchema = {
  doNothing: {
    input: {
      type: 'object',
      properties: { data: { type: 'object', properties: {}, required: [] } },
      required: ['data'],
    },
    output: {},
  },
};

// ---------- parity operations (real Operation[] — required for the
// class-defining fixture whose behavior depends on the BARE `Operation.input`
// the composed-schema-only synth path cannot carry: the mutating-scalar op's
// primitive bare input (GET-hoist, dod.9). The remaining packages resolve via
// the composed-schema synth fallback, exactly as a no-`operations` run does. ----------
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

/** The byte-identical fixture classes (void-return proven separately below). */
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
  {
    // DEBT-APIGEN-SERVE-CORE-003 — EXCLUDED from the byte-identical
    // assertParity group below (see `VOID_RETURN_FIXTURE`); captured here so
    // the pre-migration value lives in the same committed snapshot.
    name: VOID_RETURN_FIXTURE,
    input: {
      method: 'POST',
      urlPath: '/void-pkg/do-nothing',
      headers: { 'content-type': 'application/json' },
      body: { data: {} },
    },
  },
];

describe('[express-parity] TransportAdapter/OpPlan golden-snapshot parity gate', () => {
  let controller: AbortController;
  let baseUrl: string;
  let driver: ParityDriver<HttpFixtureInput, HttpFixtureOutput>;

  beforeAll(async () => {
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
          id: 'void-pkg',
          schemas: parityVoidSchema,
          importPath: '@test/void-pkg',
          // DEBT-APIGEN-SERVE-CORE-003 fixture fn: returns nothing.
          fns: { doNothing: () => undefined },
        },
      ],
      operations: [parityMutateOp],
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

  // [express-adapter.4] — the parity gate. Recapture through the (post-
  // migration) adapter-based server and assert deep-equality vs the
  // committed pre-migration golden snapshot, EXCLUDING the flagged
  // `void-return` fixture (asserted separately below). FAILS if the
  // migration regresses any byte-identical fixture (missing/added/value-
  // diverged) — assertParity reports the full blast radius. Regenerate the
  // golden with APIGEN_CAPTURE_GOLDEN=1.
  it('recapture deep-equals the committed golden snapshot (byte-identical classes)', async () => {
    const recapture = await captureGolden(driver, parityFixtures);

    if (process.env['APIGEN_CAPTURE_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(GOLDEN_PATH, JSON.stringify(recapture, null, 2) + '\n');
      return;
    }

    if (!fs.existsSync(GOLDEN_PATH)) {
      throw new Error(
        `[express-parity] golden snapshot missing at ${GOLDEN_PATH} — ` +
          'regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.'
      );
    }
    const committed = JSON.parse(
      fs.readFileSync(GOLDEN_PATH, 'utf8')
    ) as GoldenSnapshot<HttpFixtureOutput>;

    // [express-parity] exclude the flagged void-return fixture from the
    // byte-identical group — it is proven (and its intentional divergence
    // from the committed pre-migration value asserted) by the dedicated test
    // below, not by strict equality here.
    const committedByteIdentical: GoldenSnapshot<HttpFixtureOutput> = {
      ...committed,
    };
    const recaptureByteIdentical: GoldenSnapshot<HttpFixtureOutput> = {
      ...recapture,
    };
    delete committedByteIdentical[VOID_RETURN_FIXTURE];
    delete recaptureByteIdentical[VOID_RETURN_FIXTURE];

    assertParity(committedByteIdentical, recaptureByteIdentical);
  });

  // [express-adapter.4] TEETH — DEBT-APIGEN-SERVE-CORE-003: the ONE flagged,
  // intentional behavior change. Verified by direct measurement against the
  // real PRE-migration server (see `run.ts`'s header comment): pre-migration,
  // a void-returning op sent `200` with an EMPTY body (`""`) — NOT the `204`
  // the original backlog description assumed. Post-migration it sends `200`
  // with body `"null"`. This test proves BOTH halves: the committed golden
  // (captured pre-migration) really is the empty-body shape, AND the live
  // POST-migration server now sends `"null"` instead — so this fixture has
  // teeth (it is not a no-op parity exception).
  it('[DEBT-APIGEN-SERVE-CORE-003] void-return op: undefined -> null (was empty body, not 204)', async () => {
    if (!fs.existsSync(GOLDEN_PATH)) {
      throw new Error(
        `[express-parity] golden snapshot missing at ${GOLDEN_PATH} — ` +
          'regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.'
      );
    }
    const committed = JSON.parse(
      fs.readFileSync(GOLDEN_PATH, 'utf8')
    ) as GoldenSnapshot<HttpFixtureOutput>;
    const preMigration = committed[VOID_RETURN_FIXTURE];
    expect(preMigration).toBeDefined();
    // The committed pre-migration golden value: 200, empty body.
    expect(preMigration.status).toBe(200);
    expect(preMigration.body).toBe('');

    const res = await fetch(`${baseUrl}/void-pkg/do-nothing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The flagged behavior change: undefined -> null (was empty body).
    expect(body).toBe('null');
    expect(body).not.toBe(preMigration.body);
  });
});
