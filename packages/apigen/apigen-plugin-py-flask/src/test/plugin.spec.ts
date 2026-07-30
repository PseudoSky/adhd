/**
 * py-flask plugin tests — drives a LIVE Python server via real curl/fetch.
 *
 * NOT gated behind an env var — Python subprocess spawning is non-hermetic
 * setup, not a reason to skip (AGENTS.md §7 "Live testing is mandatory"); it
 * always spawns the real server, fires real HTTP, and asserts real responses.
 *
 * Tests:
 *   1. GET /_meta/health → 200 {"status":"ok","host":"<ns>"}
 *   2. POST <route> → 200, plain string round-trip
 *   3. POST <route> → decimal string round-trip ("123.456" stays "123.456")
 *   4. POST <route> → RFC3339 datetime round-trip
 *   5. POST <route> with wrong type → HTTP 400 invalid_argument
 *   6. NEGATIVE CONTROL: verify test goes RED when decimal encoding is broken
 *   7. BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001: the served route + verb for
 *      a representative op set (safe/GET-via-primitive-hoist, unsafe/POST,
 *      multi-path-segment) exactly equal `@adhd/apigen-engine-naming`'s
 *      `project(op).http` — including a live-server positive check on the
 *      project()-derived route AND a negative control that the OLD flat
 *      `/<ns>/<fnName>` route now 404s.
 *   8. [py-flask-serve-split] parity gate: a golden-snapshot recapture,
 *      driven the same way (spawn + real fetch), against the two-phase
 *      extract/serve split ([def:parity-gate]) — plus a negative control
 *      proving the gate actually fails when the plumbing regresses.
 *
 * All waiting is event-driven (readline + latch), no sleep-based proofs.
 *
 * apigen-serve-core py-flask-serve-split: `startServer()` now builds a
 * `--plan-file` (via `apigen_python.extractor --emit-json` + the REAL
 * `project()`) before spawning `flask_server.py` — the server no longer
 * accepts being spawned without one (see `flask_server.py`'s module
 * docstring). `ensurePlan()` builds it once and caches it for every test in
 * this file, since every `startServer()` call here uses the same
 * FIXTURE_MODULE/NS pair.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ensurePythonEnv } from '@adhd/apigen-python-env';
import { tokenize, buildBatchMountedOperations } from '@adhd/apigen-core-client';
import type { Operation, RunInput, Segment, JSONSchema } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { pyFlaskPlugin } from '../lib/plugin';
import {
  captureGolden,
  assertParity,
  proveNegativeControl,
  killChildProcess,
  type GoldenFixture,
  type GoldenSnapshot,
  type ParityDriver,
} from '@adhd/apigen-engine-runtime/test-support';

// Managed interpreter — provisioned from apigen-python's own pyproject.toml,
// exactly like the plugin's run() path. Never bare `python3`.
const PYENV = ensurePythonEnv();
const PYTHON_PKG_DIR = PYENV.pythonPkgDir;
const FIXTURE_MODULE = path.resolve(__dirname, 'fixtures', 'test_api.py');
const NS = 'testapi';
// BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: no fixed port. Every
// `startServer()` call below requests an OS-assigned ephemeral port
// (`--port 0`) and learns the actual bound port from the `{"ready":true,
// "port":<n>}` stdout line — see `LiveServer.port`. `base()` reads it off
// the currently-active `server` so concurrent runs of this suite (or of
// py-flask alongside py-grpc) on the same shared checkout can never collide
// on the same TCP port.
function base(): string {
  if (!server) {
    throw new Error('py-flask test: base() called with no active server');
  }
  return `http://127.0.0.1:${server.port}`;
}

// ---------------------------------------------------------------------------
// --plan-file construction — apigen-serve-core py-flask-serve-split
//
// Mirrors `plugin.ts`'s own two-phase spawn EXACTLY (extractor --emit-json ->
// real project() -> temp plan file) so these tests drive `flask_server.py`
// through the SAME real consumer protocol a production `run()` call does,
// not a hand-rolled substitute.
// ---------------------------------------------------------------------------

interface ServePlanRoute {
  route: string;
  verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
}

function runExtractorEmitJson(
  modulePath: string,
  namespace: string
): Promise<Operation[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      PYENV.python,
      ['-m', 'apigen_python.extractor', modulePath, '--namespace', namespace, '--emit-json'],
      {
        cwd: PYTHON_PKG_DIR,
        env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`extractor --emit-json exited ${code}:\n${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as Operation[]);
      } catch (err) {
        reject(new Error(`extractor --emit-json produced invalid JSON: ${err}\n${stdout}`));
      }
    });
  });
}

let cachedPlanPath: Promise<string> | undefined;

/** Builds (once, cached) the `--plan-file` for FIXTURE_MODULE/NS via the REAL
 * extractor + project() pipeline, exactly like plugin.ts's run(). */
function ensurePlan(): Promise<string> {
  if (!cachedPlanPath) {
    cachedPlanPath = runExtractorEmitJson(FIXTURE_MODULE, NS).then((operations) => {
      const routes: Record<string, ServePlanRoute> = {};
      for (const op of operations) {
        const { verb, route } = project(op).http;
        routes[op.id] = { route, verb };
      }
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-py-flask-test-plan-'));
      const planPath = path.join(dir, 'plan.json');
      fs.writeFileSync(planPath, JSON.stringify({ operations, routes }));
      return planPath;
    });
  }
  return cachedPlanPath;
}

afterAll(() => {
  if (cachedPlanPath) {
    void cachedPlanPath.then((p) => {
      try {
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Route/verb parity helpers — BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001
//
// Builds the SAME `Operation`-shaped descriptor that
// `apigen_python.extractor.extract_module()` produces for a function in
// `fixtures/test_api.py` (namespace = NS; path = [fileSegment, exportSegment]
// — `test_api.py` is not `index`/`main`, so the file segment is NOT dropped),
// then calls the real `@adhd/apigen-engine-naming` `project()` on it. This is the
// authority both api-fastify/openapi/mcp AND (independently, since Python
// cannot import this TS package) apigen_python.flask_server's `_route_for_op`
// / `_http_verb` must agree with byte-for-byte.
// ---------------------------------------------------------------------------

function seg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

// `_normalise_filename('test_api.py')` (extractor.py) → strip '.py', then
// dots/underscores → hyphens → 'test-api'.
const FILE_SEG = seg('test-api');
const NS_SEG = seg(NS);

/**
 * Builds a synthetic `Operation` mirroring what the Python extractor emits
 * for `fnName` in `fixtures/test_api.py`. Only `namespace`/`path` (route) and
 * `safe`/`input` (verb) are load-bearing for `project(op).http`; the rest are
 * filled with harmless placeholders.
 */
function pyOp(fnName: string, input: JSONSchema, safe = false): Operation {
  return {
    id: `${NS}/test-api/${tokenize(fnName).join('-')}`,
    host: 'python',
    namespace: NS_SEG,
    path: [FILE_SEG, seg(fnName)],
    kind: 'action',
    async: false,
    streaming: false,
    safe,
    input,
    output: {},
    envelope: {},
    typeText: null,
  };
}

const PRIMITIVE_STRING_INPUT = (propName: string): JSONSchema => ({
  type: 'object',
  properties: { [propName]: { type: 'string' } },
  required: [propName],
});

// Representative op set (task requirement: safe/GET, unsafe/POST, multi-segment):
//   - echo_str:   primitive-only (string) input, safe:false → GET-hoisted (FEAT-APIGEN-022)
//   - sum_ints:   array (non-primitive) input → stays POST
//   - both are inherently multi-segment: namespace + file-seg + export-seg (3 segments)
const ECHO_STR_OP = pyOp('echo_str', PRIMITIVE_STRING_INPUT('msg'));
const SUM_INTS_OP = pyOp('sum_ints', {
  type: 'object',
  properties: { values: { type: 'array', items: { type: 'integer' } } },
  required: ['values'],
});
const GREET_WITH_CTX_OP = pyOp('greet_with_ctx', PRIMITIVE_STRING_INPUT('name'));

/** Canonical route for `fnName` in the fixture module, per `project()`. */
function routeFor(op: Operation): string {
  return project(op).http.route;
}

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

interface LiveServer {
  proc: ChildProcessWithoutNullStreams;
  /**
   * The ACTUAL bound port, read back from the `{"ready":true,"port":<n>}`
   * stdout line (BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001) — never the
   * requested port, since `startServer()` always requests ephemeral (0).
   */
  port: number;
  /**
   * Every stderr line emitted by the Python process since spawn, in order —
   * captured from the very first 'data' event (not attached post-hoc), so
   * the route log `start()` prints synchronously before the readiness signal
   * is never missed. Used by the route-log parity test.
   */
  stderrLines: string[];
  stop(): Promise<void>;
}

/**
 * @param port - TCP port to request. Defaults to `0` (OS-assigned ephemeral
 *   — BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001), so concurrent test runs on
 *   the same shared checkout can never collide on the same port. Callers
 *   that need a genuinely fixed port (e.g. the streaming-rejection test,
 *   which never actually binds) may still pass one explicitly.
 */
async function startServer(port = 0): Promise<LiveServer> {
  const planPath = await ensurePlan();
  const proc = spawn(
    PYENV.python,
    [
      '-m',
      'apigen_python.flask_server',
      '--module',
      FIXTURE_MODULE,
      '--namespace',
      NS,
      '--port',
      String(port),
      '--plan-file',
      planPath,
    ],
    {
      cwd: PYTHON_PKG_DIR,
      env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  ) as ChildProcessWithoutNullStreams;

  // Capture + forward stderr for debuggability (captured from spawn, so the
  // route-log lines start() prints before the ready signal are never missed
  // by a listener attached after startServer() resolves).
  const stderrLines: string[] = [];
  const stderrRl = readline.createInterface({ input: proc.stderr });
  stderrRl.on('line', (line: string) => {
    stderrLines.push(line);
    process.stderr.write(line + '\n');
  });

  // Wait for {"ready":true,"port":<n>} on stdout — bounded to 10 s,
  // event-driven. Resolves with the ACTUAL bound port.
  const boundPort = await new Promise<number>((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rl.close();
      // Never made it to ready within the deadline — nothing to gracefully
      // drain, so kill immediately rather than leaving it running
      // (BUG-APIGEN-TEST-SUBPROCESS-TEARDOWN-LEAK-001).
      proc.kill('SIGKILL');
      reject(new Error('py-flask test: timed out waiting for ready signal'));
    }, 10_000);

    rl.on('line', (line: string) => {
      if (done) return;
      try {
        const msg = JSON.parse(line.trim()) as Record<string, unknown>;
        if (msg['ready'] === true) {
          done = true;
          clearTimeout(timer);
          rl.close();
          resolve(msg['port'] as number);
        }
      } catch {
        /* non-JSON line — keep waiting */
      }
    });

    proc.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new Error(`py-flask: process exited early (code ${code})`));
    });
  });

  return {
    proc,
    port: boundPort,
    stderrLines,
    async stop() {
      // Awaits the REAL exit event (SIGTERM, escalating to SIGKILL if it
      // doesn't die within the grace period) — never a bare timer that
      // resolves regardless of whether the process actually died
      // (BUG-APIGEN-TEST-SUBPROCESS-TEARDOWN-LEAK-001).
      await killChildProcess(proc);
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let server: LiveServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(
  fn: string,
  data: Record<string, unknown>
): Promise<Response> {
  // Route derivation depends only on namespace/path (not `input`), so an
  // empty input schema is fine here — this drives every call through the
  // SAME `project()`-derived canonical route the server now serves
  // (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001), not the old flat
  // `/<ns>/<fnName>` shape.
  const route = routeFor(pyOp(fn, {}));
  return fetch(`${base()}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
}

async function getHealth(): Promise<Response> {
  return fetch(`${base()}/_meta/health`);
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

describe('py-flask plugin — LIVE server', () => {
  it('GET /_meta/health → 200 with status:ok', async () => {
    server = await startServer();
    const res = await getHealth();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['status']).toBe('ok');
    expect(body['host']).toBe(NS);
  });

  it('POST /<ns>/echo_str → 200 plain string round-trip', async () => {
    server = await startServer();
    const res = await post('echo_str', { msg: 'hello world' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as string;
    expect(body).toBe('hello world');
  });

  it('[decimal] POST /<ns>/double_decimal → "123.456" returns exact decimal string', async () => {
    server = await startServer();
    const res = await post('double_decimal', { amount: '123.456' });
    expect(res.status).toBe(200);
    const body = await res.text();
    // The result is a JSON string — parse it
    const parsed = JSON.parse(body) as string;
    // Must be a decimal string, not a float like "246.912" → "246.912"
    expect(parsed).toBe('246.912');
    // Teeth: the exact decimal string is preserved (no float rounding)
    expect(typeof parsed).toBe('string');
    expect(parsed.includes('e')).toBe(false); // no scientific notation
  });

  it('[decimal] NEGATIVE — if wire encoding were float, value would differ', async () => {
    // This test proves the decimal check has teeth:
    // If the server returned a float (246.912 as a number), JSON.parse would give
    // a JS number, not a string.  We assert it IS a string.
    server = await startServer();
    const res = await post('double_decimal', { amount: '0.1' });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as unknown;
    // The canonical wire form is a string, not a JSON number.
    // If encoding were broken (float), this assertion fails → RED.
    expect(typeof parsed).toBe('string');
    expect(parsed).toBe('0.2');
  });

  it('[datetime] POST /<ns>/get_datetime → RFC3339 string', async () => {
    server = await startServer();
    const res = await post('get_datetime', { iso: '2024-01-15T12:34:56.789Z' });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(await res.text()) as unknown;
    // Result must be an RFC3339 string
    expect(typeof parsed).toBe('string');
    expect(parsed as string).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    // Round-trip: same instant in UTC
    expect(new Date(parsed as string).getTime()).toBe(
      new Date('2024-01-15T12:34:56.789Z').getTime()
    );
  });

  it('[validation] malformed type → HTTP 400 invalid_argument (fn never called)', async () => {
    server = await startServer();
    // amount must be a decimal string; send an integer → validation fails
    const res = await post('double_decimal', { amount: 999 });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('invalid_argument');
    // The function must NOT have been called — the error is from pre-dispatch validation
    expect(body['message']).toMatch(/validation/i);
  });

  it('[validation] missing required param → HTTP 400', async () => {
    server = await startServer();
    // echo_str requires 'msg'; omit it
    const res = await post('echo_str', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['code']).toBe('invalid_argument');
  });

  it('[envelope] x-adhd-session header forwarded to ctx parameter', async () => {
    server = await startServer();
    const res = await fetch(`${base()}${routeFor(GREET_WITH_CTX_OP)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-adhd-session': 'sess-abc',
      },
      body: JSON.stringify({ data: { name: 'Alice' } }),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as string;
    expect(body).toContain('sess-abc');
  });

  it('[not found] unknown route → 404', async () => {
    server = await startServer();
    const res = await fetch(`${base()}${routeFor(pyOp('does_not_exist', {}))}`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Batch/bulk fan-out mount (BATCH_0.0.1.md §2.1/§5, batch-rollout F6) — the
// `_batch/<kind>` route is opt-in ONLY via `input.options.usePlugins`
// containing a plugin whose `id === 'batch'` (the SAME `readUsePlugins`
// convention every other TS host already reads its own `--use` plugins off
// of — see `plugin.ts`'s "Phase 1.5" comment). Drives the REAL production
// entrypoint (`pyFlaskPlugin.run()`) with real HTTP, never a bypass — the
// same standard the golden-snapshot parity suite above already holds itself
// to (AGENTS.md §7).
// ---------------------------------------------------------------------------

describe('py-flask plugin — batch mount (BATCH_0.0.1.md, batch-rollout F6)', () => {
  it('usePlugins: [{id:"batch"}] adds a real, dispatchable _batch/<kind> route (partial-failure fan-out)', async () => {
    const controller = new AbortController();
    let runPromise: Promise<void> | undefined;

    const portPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('[py-flask-batch] server did not report a bound port within 15s'));
      }, 15000);
      const runInput: RunInput = {
        packages: [{ id: NS, schemas: {}, importPath: FIXTURE_MODULE }],
        outputDir: '/tmp/out',
        options: {
          port: 0,
          namespace: NS,
          usePlugins: [{ id: 'batch' }],
          onListening: (port: number) => {
            clearTimeout(timer);
            resolve(port);
          },
        },
        signal: controller.signal,
      };
      runPromise = pyFlaskPlugin.run(runInput).catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });

    try {
      const boundPort = await portPromise;
      const base = `http://127.0.0.1:${boundPort}`;

      // Compute the expected batch route the SAME way plugin.ts itself does
      // (buildBatchMountedOperations + project()) — never a hand-guessed
      // literal, so this test breaks if that derivation ever drifts.
      const operations = await runExtractorEmitJson(FIXTURE_MODULE, NS);
      const batchOps = buildBatchMountedOperations({ host: 'py', operations });
      expect(batchOps.length).toBeGreaterThan(0);
      const batchRoute = project(batchOps[0]).http.route;

      const echoOp = operations.find((o) => o.id.endsWith('echo-str'));
      if (!echoOp) {
        throw new Error('[py-flask-batch] echo_str operation not found in extracted operations');
      }

      const res = await fetch(`${base}${batchRoute}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operation: echoOp.id,
          items: [{ msg: 'one' }, { msg: 123 }, { msg: 'two' }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body).toHaveLength(3);
      expect(body[0]).toEqual({ index: 0, status: 'fulfilled', value: 'one' });
      expect(body[1]['status']).toBe('rejected');
      expect((body[1]['reason'] as Record<string, unknown>)['code']).toBe('invalid_argument');
      expect(body[2]).toEqual({ index: 2, status: 'fulfilled', value: 'two' });
    } finally {
      controller.abort();
      if (runPromise) await runPromise;
    }
  }, 20000);

  it('usePlugins absent (default): the batch route does NOT exist — opt-in only, never a runtime flag', async () => {
    server = await startServer();
    const operations = await runExtractorEmitJson(FIXTURE_MODULE, NS);
    const batchOps = buildBatchMountedOperations({ host: 'py', operations });
    const batchRoute = project(batchOps[0]).http.route;

    const res = await fetch(`${base()}${batchRoute}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'irrelevant', items: [] }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001 — route/verb parity with
// @adhd/apigen-engine-naming's project() (the SAME authority api-fastify/openapi/mcp
// derive their routes from).
// ---------------------------------------------------------------------------

describe('py-flask plugin — route/verb parity with project() (BUG-APIGEN-OPENAPI-ROUTE-PATH-MISMATCH-001)', () => {
  it('project(): echo_str (primitive-only input, safe:false) hoists to GET at a 3-segment kebab route', () => {
    const { verb, route } = project(ECHO_STR_OP).http;
    expect(verb).toBe('GET');
    expect(route).toBe('/testapi/test-api/echo-str');
    // Multi-path-segment: namespace + file-seg + export-seg.
    expect(route.split('/').filter(Boolean)).toEqual([
      'testapi',
      'test-api',
      'echo-str',
    ]);
  });

  it('project(): sum_ints (array/non-primitive input) stays POST at its 3-segment kebab route', () => {
    const { verb, route } = project(SUM_INTS_OP).http;
    expect(verb).toBe('POST');
    expect(route).toBe('/testapi/test-api/sum-ints');
  });

  it('LIVE: the server exposes GET at the project()-derived route for echo_str, and the OLD flat route 404s', async () => {
    server = await startServer();
    const { verb, route } = project(ECHO_STR_OP).http;
    expect(verb).toBe('GET');

    // Positive: a real GET request to the project()-derived, kebab, 3-segment
    // route succeeds.
    const res = await fetch(`${base()}${route}?msg=hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBe('hello');

    // NEGATIVE CONTROL: the pre-fix flat `/ns/echo_str` route must now 404 —
    // proves the derivation actually changed (not merely aliased). Verified
    // manually against the pre-fix flask_server.py: this same request
    // returned 200 there (and the line above's 3-segment GET 404'd), i.e.
    // this assertion is RED against the old code and GREEN against the fix.
    const legacy = await fetch(`${base()}/${NS}/echo_str`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { msg: 'hello' } }),
    });
    expect(legacy.status).toBe(404);
  });

  it('LIVE: the server exposes POST-only at the project()-derived route for sum_ints, and the OLD flat route 404s', async () => {
    server = await startServer();
    const { verb, route } = project(SUM_INTS_OP).http;
    expect(verb).toBe('POST');

    // Positive: POST to the project()-derived, kebab, 3-segment route.
    const res = await fetch(`${base()}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { values: [1, 2, 3] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(6);

    // NEGATIVE CONTROL: the pre-fix flat route 404s now.
    const legacy = await fetch(`${base()}/${NS}/sum_ints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { values: [1, 2, 3] } }),
    });
    expect(legacy.status).toBe(404);

    // A GET to the same canonical route must be rejected (POST-only op) —
    // proves the verb, not just the path, is honored.
    const wrongVerb = await fetch(`${base()}${route}?values=1`);
    expect(wrongVerb.status).toBe(405);
  });

  it('LIVE: the served stderr route log matches project() for every fixture op', async () => {
    server = await startServer();
    // `server.stderrLines` is captured from process spawn (see startServer()),
    // so start()'s route-log lines — printed synchronously before the
    // ready signal — are guaranteed to already be present by the time
    // startServer() resolves.
    const lines = server.stderrLines;

    for (const op of [ECHO_STR_OP, SUM_INTS_OP]) {
      const { verb, route } = project(op).http;
      const logLine = lines.find((l) => l.includes(route));
      expect(
        logLine,
        `expected a stderr route-log line containing ${route} (from:\n${lines.join('\n')})`
      ).toBeDefined();
      expect(logLine).toMatch(new RegExp(`^\\s*${verb}\\s+${route.replace(/[-/]/g, '\\$&')}$`));
    }
  });
});

// ===========================================================================
// [py-flask-serve-split] serve-core extract/serve-split parity gate
// ([def:parity-gate], docs/plan/apigen-serve-core/contexts/_shared.md)
//
// Drives a REAL live py-flask server the way a consumer does
// ([def:real-consumer-protocol]: spawn + `fetch`) across a representative
// fixture set (safe-GET-hoist, unsafe/array-input POST, session-envelope,
// decimal/datetime round-trip, validation-failure, health, 404), and asserts
// the recapture (through the two-phase extract/serve split) is byte-
// identical to a committed golden snapshot captured against the
// PRE-MIGRATION single-phase self-extracting server
// ([inv:byte-identical]). py-flask has no streaming transport (unlike
// fastify/mcp), so there is no separate streaming carve-out here.
//
// The golden snapshot is regenerated with `APIGEN_CAPTURE_GOLDEN=1` (the
// standard snapshot-update escape hatch — the compare test itself always
// runs unflagged, by default, in CI). Committed at
// `src/test/golden/py-flask.snapshot.json` — captured against HEAD (the
// pre-migration commit) via a real spawned subprocess + real HTTP, from a
// throwaway git worktree, BEFORE this state's Python/TS changes were made.
// ===========================================================================

interface HttpFixtureInput {
  method: 'GET' | 'POST';
  /** Route path (already projected — e.g. `/testapi/test-api/echo-str`), no host. */
  urlPath: string;
  headers?: Record<string, string>;
  body?: unknown;
}

interface HttpFixtureOutput {
  status: number;
  contentType: string | null;
  body: string;
}

// BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: no fixed PARITY_PORT — this
// suite's own server (below) requests ephemeral port 0 and learns the
// actual bound port via the `onListening` escape hatch.
const PARITY_GOLDEN_PATH = path.join(__dirname, 'golden', 'py-flask.snapshot.json');

/** Route for `fnName` in the fixture module, with an empty input schema —
 * route derivation depends only on namespace/path (see `routeFor` above). */
function parityRoute(fnName: string): string {
  return routeFor(pyOp(fnName, {}));
}

const parityFixtures: ReadonlyArray<GoldenFixture<HttpFixtureInput>> = [
  {
    // echo_str: primitive-only (string) input → GET-hoisted (FEAT-APIGEN-022).
    name: 'safe-get',
    input: { method: 'GET', urlPath: `${parityRoute('echo_str')}?msg=hello` },
  },
  {
    // sum_ints: array (non-primitive) input → stays POST.
    name: 'unsafe-post-array-input',
    input: {
      method: 'POST',
      urlPath: parityRoute('sum_ints'),
      headers: { 'content-type': 'application/json' },
      body: { data: { values: [1, 2, 3] } },
    },
  },
  {
    // greet_with_ctx: x-adhd-session header forwarded to the ctx parameter.
    name: 'session-envelope',
    input: {
      method: 'POST',
      urlPath: parityRoute('greet_with_ctx'),
      headers: { 'content-type': 'application/json', 'x-adhd-session': 'sess-parity' },
      body: { data: { name: 'Alice' } },
    },
  },
  {
    name: 'decimal-roundtrip',
    input: {
      method: 'POST',
      urlPath: parityRoute('double_decimal'),
      headers: { 'content-type': 'application/json' },
      body: { data: { amount: '123.456' } },
    },
  },
  {
    name: 'datetime-roundtrip',
    input: {
      method: 'POST',
      urlPath: parityRoute('get_datetime'),
      headers: { 'content-type': 'application/json' },
      body: { data: { iso: '2024-01-15T12:34:56.789Z' } },
    },
  },
  {
    // wrong type for a decimal-formatted param -> 400 BEFORE the fn runs.
    name: 'validation-failure',
    input: {
      method: 'POST',
      urlPath: parityRoute('double_decimal'),
      headers: { 'content-type': 'application/json' },
      body: { data: { amount: 999 } },
    },
  },
  {
    name: 'health',
    input: { method: 'GET', urlPath: '/_meta/health' },
  },
  {
    name: 'not-found',
    input: { method: 'GET', urlPath: '/testapi/test-api/does-not-exist' },
  },
];

describe('[py-flask-parity] extract/serve-split golden-snapshot parity gate', () => {
  let controller: AbortController;
  let driver: ParityDriver<HttpFixtureInput, HttpFixtureOutput>;
  let runPromise: Promise<void>;

  beforeAll(async () => {
    // Drive the REAL production entrypoint (`pyFlaskPlugin.run()`), NOT the
    // test-local `startServer()` spawn helper the earlier LIVE-server blocks
    // use — the negative control below patches `plugin.ts`'s two-phase spawn
    // itself, so the parity gate must actually exercise that code path for
    // the patch's effect to be observable (a gate that bypasses the thing it
    // patches would stay GREEN no matter what — AGENTS.md §7 "drive the real
    // entrypoint, never a bypass").
    controller = new AbortController();

    // BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: request an OS-assigned
    // ephemeral port (0) and learn the real one via `onListening` — the
    // production `RunInput`/`OutputPlugin` types are untouched; `options` is
    // already an untyped bag and `onListening` is plugin.ts's own escape
    // hatch (see its module docstring). `onListening` fires only after
    // plugin.ts's own `waitForReady()` has already parsed the server's
    // `{"ready":true}` line, so by the time `portPromise` resolves the
    // server is genuinely accepting connections — no separate health-poll
    // loop is needed.
    const portPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('[py-flask-parity] server did not report a bound port within 15s'));
      }, 15000);
      const runInput: RunInput = {
        packages: [{ id: NS, schemas: {}, importPath: FIXTURE_MODULE }],
        outputDir: '/tmp/out',
        options: {
          port: 0,
          namespace: NS,
          onListening: (port: number) => {
            clearTimeout(timer);
            resolve(port);
          },
        },
        signal: controller.signal,
      };
      runPromise = pyFlaskPlugin.run(runInput).catch((err: unknown) => {
        // If the process died before reporting readiness, surface that as
        // the portPromise rejection reason instead of waiting out the timer.
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    const boundPort = await portPromise;
    const base = `http://127.0.0.1:${boundPort}`;

    driver = {
      async invoke(fixture: GoldenFixture<HttpFixtureInput>): Promise<HttpFixtureOutput> {
        const { method, urlPath, headers, body } = fixture.input;
        const res = await fetch(`${base}${urlPath}`, {
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
  }, 20000);

  afterAll(async () => {
    // Await the actual subprocess exit (plugin.ts's abort handler now
    // escalates SIGTERM -> SIGKILL and only settles on real exit) — never
    // fire-and-forget, or a slow-to-die Python process outlives the test
    // suite and leaks (BUG-APIGEN-TEST-SUBPROCESS-TEARDOWN-LEAK-001).
    controller.abort();
    await runPromise;
  });

  // [py-flask-serve-split.6] the parity gate. Recapture through the
  // (post-migration) two-phase extract/serve split and assert deep-equality
  // vs the committed pre-migration golden snapshot. FAILS if the migration
  // regresses any fixture. Regenerate the golden with APIGEN_CAPTURE_GOLDEN=1.
  it('recapture deep-equals the committed golden snapshot', async () => {
    const recapture = await captureGolden(driver, parityFixtures);

    if (process.env['APIGEN_CAPTURE_GOLDEN'] === '1') {
      fs.mkdirSync(path.dirname(PARITY_GOLDEN_PATH), { recursive: true });
      fs.writeFileSync(
        PARITY_GOLDEN_PATH,
        JSON.stringify(recapture, null, 2) + '\n'
      );
      return;
    }

    if (!fs.existsSync(PARITY_GOLDEN_PATH)) {
      throw new Error(
        `[py-flask-parity] golden snapshot missing at ${PARITY_GOLDEN_PATH} — ` +
          'regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.'
      );
    }
    const committed = JSON.parse(
      fs.readFileSync(PARITY_GOLDEN_PATH, 'utf8')
    ) as GoldenSnapshot<HttpFixtureOutput>;

    assertParity(committed, recapture);
  });
});

// ---------------------------------------------------------------------------
// [py-flask-serve-split.7] negative control ([inv:negative-control],
// AGENTS.md §7 pt 2): a parity suite that has never been shown to fail is
// not a gate.
//
// Patching `plugin.ts` on disk cannot affect an ALREADY-imported test
// process (this same file's earlier tests already spawned servers via the
// unmodified `plugin.ts`-equivalent flow) — so `runner` spawns a genuinely
// FRESH `vitest` child process per check, which re-transforms the plugin's
// source from disk from scratch every time. That is what makes the patch's
// effect actually observable: RED means the freshly-spawned process's own
// golden-parity check failed; GREEN means it passed.
// ---------------------------------------------------------------------------

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`findRepoRoot: no ".git" found walking up from ${startDir}`);
    }
    dir = parent;
  }
}

describe('[py-flask-serve-split.7] negative control — the parity gate actually gates', () => {
  it(
    'applying neg-control/py-flask-serve-split.patch turns the golden-parity check RED; reverting turns it GREEN',
    async () => {
      const repoRoot = findRepoRoot(__dirname);
      const patchPath = path.join(
        repoRoot,
        'docs/plan/apigen-serve-core/neg-control/py-flask-serve-split.patch'
      );

      function runGoldenParityCheckInFreshProcess(): void {
        const result = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            path.join(repoRoot, 'packages/apigen/apigen-plugin-py-flask/vite.config.ts'),
            '-t',
            'recapture deep-equals the committed golden snapshot',
          ],
          { cwd: repoRoot, encoding: 'utf8' }
        );
        if (result.status !== 0) {
          throw new Error(
            `golden-parity check failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`
          );
        }
      }

      await proveNegativeControl(runGoldenParityCheckInFreshProcess, patchPath, {
        cwd: repoRoot,
      });
    },
    60000
  );
});
