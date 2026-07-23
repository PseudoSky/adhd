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
import { generate } from '../lib/generate';
import { run } from '../lib/run';
import type {
  Operation,
  PluginInput,
  RunInput,
} from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';

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
