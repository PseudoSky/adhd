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
 *
 * All waiting is event-driven (readline + latch), no sleep-based proofs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { ensurePythonEnv } from '@adhd/apigen-python-env';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, Segment, JSONSchema } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';

// Managed interpreter — provisioned from apigen-python's own pyproject.toml,
// exactly like the plugin's run() path. Never bare `python3`.
const PYENV = ensurePythonEnv();
const PYTHON_PKG_DIR = PYENV.pythonPkgDir;
const FIXTURE_MODULE = path.resolve(__dirname, 'fixtures', 'test_api.py');
const PORT = 49271; // deterministic high port, avoids clashes
const NS = 'testapi';
const BASE = `http://127.0.0.1:${PORT}`;

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
   * Every stderr line emitted by the Python process since spawn, in order —
   * captured from the very first 'data' event (not attached post-hoc), so
   * the route log `start()` prints synchronously before the readiness signal
   * is never missed. Used by the route-log parity test.
   */
  stderrLines: string[];
  stop(): Promise<void>;
}

async function startServer(): Promise<LiveServer> {
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
      String(PORT),
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

  // Wait for {"ready":true} on stdout — bounded to 10 s, event-driven
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout });
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      rl.close();
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
          resolve();
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
    stderrLines,
    async stop() {
      if (proc.killed) return;
      await new Promise<void>((res) => {
        proc.once('exit', () => res());
        proc.kill('SIGTERM');
        setTimeout(res, 2000);
      });
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
  return fetch(`${BASE}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  });
}

async function getHealth(): Promise<Response> {
  return fetch(`${BASE}/_meta/health`);
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
    const res = await fetch(`${BASE}${routeFor(GREET_WITH_CTX_OP)}`, {
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
    const res = await fetch(`${BASE}${routeFor(pyOp('does_not_exist', {}))}`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
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
    const res = await fetch(`${BASE}${route}?msg=hello`);
    expect(res.status).toBe(200);
    expect(await res.json()).toBe('hello');

    // NEGATIVE CONTROL: the pre-fix flat `/ns/echo_str` route must now 404 —
    // proves the derivation actually changed (not merely aliased). Verified
    // manually against the pre-fix flask_server.py: this same request
    // returned 200 there (and the line above's 3-segment GET 404'd), i.e.
    // this assertion is RED against the old code and GREEN against the fix.
    const legacy = await fetch(`${BASE}/${NS}/echo_str`, {
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
    const res = await fetch(`${BASE}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { values: [1, 2, 3] } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBe(6);

    // NEGATIVE CONTROL: the pre-fix flat route 404s now.
    const legacy = await fetch(`${BASE}/${NS}/sum_ints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: { values: [1, 2, 3] } }),
    });
    expect(legacy.status).toBe(404);

    // A GET to the same canonical route must be rejected (POST-only op) —
    // proves the verb, not just the path, is honored.
    const wrongVerb = await fetch(`${BASE}${route}?values=1`);
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
