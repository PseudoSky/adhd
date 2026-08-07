/**
 * py-grpc plugin tests — drives a LIVE Python gRPC server via real grpcurl.
 *
 * NOT gated behind an env var — Python subprocess spawning is non-hermetic
 * setup, not a reason to skip (AGENTS.md §7 "Live testing is mandatory");
 * it always spawns the real server, fires real grpcurl calls, and asserts
 * real responses. `grpcurl` itself may self-skip WITH a visible warning per
 * repo convention if genuinely unavailable in a given environment, but it is
 * present and used unconditionally in this suite's normal run.
 *
 * apigen-serve-core py-grpc-serve-split: `startServer()` now builds a
 * `--plan-file` (via `apigen_python.extractor --emit-json` + the REAL
 * `project()`) before spawning `grpc_server.py` — the server no longer
 * self-extracts or re-derives package/service/method (see `grpc_server.py`'s
 * module docstring). `ensurePlan()` builds it once and caches it for every
 * test in this file, since every `startServer()` call here uses the same
 * FIXTURE_MODULE/NS pair.
 *
 * Tests:
 *   1. grpcurl list → the project()-derived service appears
 *   2. grpcurl describe → the project()-derived methods are listed
 *   3. add_decimal "123.456" → decimal string "123.457" (real Decimal math, not str passthrough)
 *   4. greet "World" → "Hello, World!" plain string round-trip
 *   5. add_decimal with empty data → gRPC error (validation/decode gate)
 *   6. NEGATIVE CONTROL: str-passthrough would cause TypeError → 500; real Decimal → 200
 *      Verify test goes RED when decimal encoding is broken (typeof check)
 *   7. [naming reconciliation] the served package/service/method exactly equal
 *      `@adhd/apigen-engine-naming`'s `project(op).grpc` — including a live
 *      positive check on the project()-derived address AND a negative
 *      control that the OLD divergent `<namespace>.<Namespace>Service/<raw_fn_name>`
 *      address (namespace.capitalize()-based, pre-reconciliation) is now
 *      UNIMPLEMENTED.
 *   8. [streaming deferral] a `streaming:true` operation is explicitly
 *      rejected (non-zero exit, clear error) rather than silently
 *      mishandled — [fix:pygrpc-streaming-deferral].
 *   9. [py-grpc-serve-split] parity gate: a golden-snapshot recapture,
 *      driven the same way (spawn + real grpcurl), against the two-phase
 *      extract/serve split ([def:parity-gate]) — plus a negative control
 *      proving the gate actually fails when the plumbing regresses.
 *
 * All waiting is event-driven (readline + latch / bounded polling), no
 * sleep-based proofs.
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest';
import {
  spawn,
  spawnSync,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import * as readline from 'node:readline';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { ensurePythonEnv } from '@adhd/apigen-python-env';
import { tokenize } from '@adhd/apigen-core-client';
import type { Operation, RunInput, Segment, JSONSchema } from '@adhd/apigen-core-client';
import { project } from '@adhd/apigen-engine-naming';
import { pyGrpcPlugin } from '../lib/plugin';
import {
  captureGolden,
  assertParity,
  proveNegativeControl,
  killChildProcess,
  type GoldenFixture,
  type GoldenSnapshot,
  type ParityDriver,
} from '@adhd/apigen-engine-runtime/test-support';

// Managed interpreter — provisioned from apigen-python's own pyproject.toml
// (grpc extra), exactly like the plugin's run() path. Never bare `python3`.
const PYENV = ensurePythonEnv({ extras: ['grpc'] });
const PYTHON_PKG_DIR = PYENV.pythonPkgDir;
const FIXTURE_MODULE = path.resolve(__dirname, 'fixtures', 'grpc_api.py');
const STREAMING_FIXTURE_MODULE = path.resolve(__dirname, 'fixtures', 'streaming_api.py');
const NS = 'pkg';
// BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: no fixed port. Every
// `startServer()` call below requests an OS-assigned ephemeral port
// (`--port 0`) and learns the actual bound port from the `{"ready":true,
// "port":<n>}` stdout line — see `LiveServer.port`. `liveAddr()` reads it
// off the currently-active `server` so concurrent runs of this suite (or of
// py-grpc alongside py-flask) on the same shared checkout can never collide
// on the same TCP port.
function liveAddr(): string {
  if (!server) {
    throw new Error('py-grpc test: liveAddr() called with no active server');
  }
  return `localhost:${server.port}`;
}

// ---------------------------------------------------------------------------
// --plan-file construction — apigen-serve-core py-grpc-serve-split
//
// Mirrors `plugin.ts`'s own two-phase spawn EXACTLY (extractor --emit-json ->
// real project() -> temp plan file) so these tests drive `grpc_server.py`
// through the SAME real consumer protocol a production `run()` call does,
// not a hand-rolled substitute.
// ---------------------------------------------------------------------------

interface ServePlanGrpc {
  package: string;
  service: string;
  method: string;
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

/** Builds the `--plan-file` payload for `modulePath`/`namespace` via the REAL
 * extractor + project() pipeline, exactly like plugin.ts's run(). Returns the
 * temp file path AND the extracted `Operation[]` (callers often need both). */
async function buildPlan(
  modulePath: string,
  namespace: string
): Promise<{ planPath: string; operations: Operation[] }> {
  const operations = await runExtractorEmitJson(modulePath, namespace);
  const grpcMap: Record<string, ServePlanGrpc> = {};
  for (const op of operations) {
    const g = project(op).grpc;
    grpcMap[op.id] = { package: g.package, service: g.service, method: g.method };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-py-grpc-test-plan-'));
  const planPath = path.join(dir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({ operations, grpc: grpcMap }));
  return { planPath, operations };
}

const tempPlanDirs: string[] = [];
let cachedPlanPath: Promise<string> | undefined;

/** Builds (once, cached) the `--plan-file` for FIXTURE_MODULE/NS. */
function ensurePlan(): Promise<string> {
  if (!cachedPlanPath) {
    cachedPlanPath = buildPlan(FIXTURE_MODULE, NS).then(({ planPath }) => {
      tempPlanDirs.push(path.dirname(planPath));
      return planPath;
    });
  }
  return cachedPlanPath;
}

afterAll(() => {
  for (const dir of tempPlanDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// ---------------------------------------------------------------------------
// Naming helpers — build the SAME `Operation`-shaped descriptor that
// `apigen_python.extractor.extract_module()` produces for a function in
// `fixtures/grpc_api.py` (namespace = NS; path = [fileSegment, exportSegment]
// — `grpc_api.py` is not `index`/`main`, so the file segment is NOT dropped),
// then calls the real `@adhd/apigen-engine-naming` `project()` on it. This is
// the authority every other transport derives its names from AND (since
// Python cannot import this TS package) `apigen_python.grpc_server`'s
// injected `--plan-file` must agree with byte-for-byte.
// ---------------------------------------------------------------------------

function seg(raw: string): Segment {
  return { raw, words: tokenize(raw) };
}

// `_normalise_filename('grpc_api.py')` (extractor.py) → strip '.py', then
// dots/underscores → hyphens → 'grpc-api'.
const FILE_SEG = seg('grpc-api');
const NS_SEG = seg(NS);

function pyOp(fnName: string, input: JSONSchema, safe = false): Operation {
  return {
    id: `${NS}/grpc-api/${tokenize(fnName).join('-')}`,
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

const ADD_DECIMAL_OP = pyOp('add_decimal', {
  type: 'object',
  properties: { amount: { type: 'string', format: 'decimal' } },
  required: ['amount'],
});
const GREET_OP = pyOp('greet', {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
});
const GREET_WITH_CTX_OP = pyOp('greet_with_ctx', {
  type: 'object',
  properties: { name: { type: 'string' } },
  required: ['name'],
});

/** Full `<package>.<Service>/<Method>` gRPC address for `op`, per `project()`. */
function grpcAddrFor(op: Operation): string {
  const g = project(op).grpc;
  return `${g.package}.${g.service}/${g.method}`;
}

// project(ADD_DECIMAL_OP).grpc ⇒ { package: 'pkg.grpc_api', service: 'GrpcApi',
// method: 'AddDecimal' } — computed once for the module-level constants below
// rather than re-derived ad hoc per test.
const SVC_ADDR = (() => {
  const g = project(ADD_DECIMAL_OP).grpc;
  return `${g.package}.${g.service}`;
})();

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
  stderrLines: string[];
  stop(): Promise<void>;
}

/**
 * Spawns `apigen_python.grpc_server` with the given `--plan-file` and waits
 * for `{"ready":true,"port":<n>}` — bounded to 10 s, event-driven.
 *
 * @param port - TCP port to request. Defaults to `0` (OS-assigned ephemeral
 *   — BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001).
 */
async function startServerWithPlan(planPath: string, port = 0): Promise<LiveServer> {
  const proc = spawn(
    PYENV.python,
    [
      '-m',
      'apigen_python.grpc_server',
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

  const stderrLines: string[] = [];
  const stderrRl = readline.createInterface({ input: proc.stderr });
  stderrRl.on('line', (line: string) => {
    stderrLines.push(line);
    process.stderr.write(line + '\n');
  });

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
      reject(new Error('py-grpc test: timed out waiting for ready signal'));
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
      reject(new Error(`py-grpc: process exited early (code ${code})`));
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

async function startServer(port = 0): Promise<LiveServer> {
  const planPath = await ensurePlan();
  return startServerWithPlan(planPath, port);
}

// ---------------------------------------------------------------------------
// grpcurl helpers
// ---------------------------------------------------------------------------

interface GrpcurlResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function grpcurl(args: string[]): GrpcurlResult {
  try {
    const stdout = execFileSync('grpcurl', ['-plaintext', ...args], {
      timeout: 5000,
      encoding: 'utf8',
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * Call a gRPC method with a JSON data payload.
 * Returns the raw grpcurl result (parse `.stdout` as JSON on success).
 */
function grpcCall(
  addr: string,
  fullMethod: string,
  data: Record<string, unknown>,
  metadata?: Record<string, string>
): GrpcurlResult {
  const metaArgs = metadata
    ? Object.entries(metadata).flatMap(([k, v]) => ['-H', `${k}: ${v}`])
    : [];
  return grpcurl([...metaArgs, '-d', JSON.stringify(data), addr, fullMethod]);
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
// Live tests
// ---------------------------------------------------------------------------

describe('py-grpc plugin — LIVE gRPC server', () => {
  it('grpcurl list → the project()-derived service appears', async () => {
    server = await startServer();
    const result = grpcurl([liveAddr(), 'list']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(SVC_ADDR);
  });

  it('grpcurl describe → project()-derived methods AddDecimal, Greet listed', async () => {
    server = await startServer();
    const result = grpcurl([liveAddr(), 'describe', SVC_ADDR]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(project(ADD_DECIMAL_OP).grpc.method);
    expect(result.stdout).toContain(project(GREET_OP).grpc.method);
  });

  it('[decimal] add_decimal "123.456" → "123.457" exact decimal string', async () => {
    server = await startServer();
    // Send amount as decimal string — canonical wire for Decimal
    const result = grpcCall(liveAddr(), grpcAddrFor(ADD_DECIMAL_OP), {
      data: { amount: '123.456' },
    });
    expect(result.exitCode).toBe(0);

    // Response: {"data": "\"123.457\""} — data field is JSON-encoded result
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(typeof body['data']).toBe('string');

    // Parse the inner JSON: the string "123.457"
    const decoded = JSON.parse(body['data'] as string) as unknown;
    expect(typeof decoded).toBe('string');
    expect(decoded).toBe('123.457');

    // TEETH: If decimal encoding were broken (str passthrough), the fn would
    // throw TypeError ("can only concatenate str (not Decimal) to str") and
    // the server would return INTERNAL, not a 200 with a decimal string.
    // The exitCode=0 + exact decimal string together prove real Decimal was used.
    expect(decoded).not.toContain('e'); // no scientific notation
  });

  it('[decimal] add_decimal "0.1" → "0.101" (float would give 0.10100000...001)', async () => {
    server = await startServer();
    const result = grpcCall(liveAddr(), grpcAddrFor(ADD_DECIMAL_OP), {
      data: { amount: '0.1' },
    });
    expect(result.exitCode).toBe(0);

    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const decoded = JSON.parse(body['data'] as string) as unknown;

    // Canonical: exact decimal string, not float
    expect(typeof decoded).toBe('string');
    expect(decoded).toBe('0.101');

    // NEGATIVE CONTROL: if result were a JSON number (float wire), JSON.parse
    // would give a JavaScript number — typeof would be 'number' not 'string'.
    // This assertion would then FAIL, proving the test has teeth.
    expect(typeof decoded).not.toBe('number');
  });

  it('[string] greet "World" → "Hello, World!" plain string round-trip', async () => {
    server = await startServer();
    const result = grpcCall(liveAddr(), grpcAddrFor(GREET_OP), {
      data: { name: 'World' },
    });
    expect(result.exitCode).toBe(0);

    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const decoded = JSON.parse(body['data'] as string) as unknown;
    expect(decoded).toBe('Hello, World!');
  });

  it('[envelope] x-adhd-session metadata forwarded to ctx parameter', async () => {
    server = await startServer();
    const result = grpcCall(
      liveAddr(),
      grpcAddrFor(GREET_WITH_CTX_OP),
      { data: { name: 'Alice' } },
      { 'x-adhd-session': 'sess-abc' }
    );
    expect(result.exitCode).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, unknown>;
    const decoded = JSON.parse(body['data'] as string) as unknown;
    expect(decoded).toContain('sess-abc');
  });

  it('[validation] calling add_decimal without amount → gRPC error (non-zero exit)', async () => {
    server = await startServer();
    // Proto3 string fields always have a default of "". Sending {"data":{}} means
    // grpcurl omits the field, and the server receives amount="" (proto3 default).
    // Validation passes (empty string is a string), but Decimal("") raises at
    // runtime → server returns gRPC error.
    //
    // We test the observable: non-zero exit code (some gRPC error, not success).
    const result = grpcCall(liveAddr(), grpcAddrFor(ADD_DECIMAL_OP), { data: {} });
    expect(result.exitCode).not.toBe(0);
    // The error must not be a connection error — it must be a gRPC-level error
    expect(result.stderr).not.toContain('connection refused');
  });

  it('[reflection] grpcurl describe returns typed Data sub-message', async () => {
    server = await startServer();
    const g = project(ADD_DECIMAL_OP).grpc;
    const result = grpcurl([
      liveAddr(),
      'describe',
      `${g.package}.${g.method}Request.Data`,
    ]);
    expect(result.exitCode).toBe(0);
    // The Data sub-message should have an 'amount' field
    expect(result.stdout).toContain('amount');
  });
});

// ---------------------------------------------------------------------------
// [py-grpc-serve-split.5] naming reconciliation — the served package/service/
// method exactly equal `@adhd/apigen-engine-naming`'s `project(op).grpc`, the
// SAME derivation every other transport uses. `grpc_server.py` previously
// carried an unrelated inline naming scheme (see its module docstring); this
// proves that scheme is genuinely gone, not merely aliased, via a live
// negative control against the OLD address shape.
// ---------------------------------------------------------------------------

describe('py-grpc plugin — naming reconciliation with project() (py-grpc-serve-split.5)', () => {
  it('project(): add_decimal → package "pkg.grpc_api", service "GrpcApi", method "AddDecimal"', () => {
    const g = project(ADD_DECIMAL_OP).grpc;
    expect(g.package).toBe('pkg.grpc_api');
    expect(g.service).toBe('GrpcApi');
    expect(g.method).toBe('AddDecimal');
  });

  it('project(): greet_with_ctx → method "GreetWithCtx" (multi-word Pascal-cased)', () => {
    const g = project(GREET_WITH_CTX_OP).grpc;
    expect(g.method).toBe('GreetWithCtx');
  });

  it('LIVE: the server answers at the project()-derived address, and the OLD divergent address is now UNIMPLEMENTED', async () => {
    server = await startServer();
    const addr = liveAddr();

    // Positive: the project()-derived address works.
    const ok = grpcCall(addr, grpcAddrFor(ADD_DECIMAL_OP), { data: { amount: '1.000' } });
    expect(ok.exitCode).toBe(0);

    // NEGATIVE CONTROL: the pre-reconciliation address
    // (`<namespace>.<Namespace>Service/<raw_fn_name>`, the previous inline
    // scheme this state deleted) must now be UNIMPLEMENTED — proves the
    // derivation actually changed, not merely aliased. Verified manually
    // against the pre-fix grpc_server.py: this same call returned 200 there
    // (and the project()-derived address above 404'd/UNIMPLEMENTED'd), i.e.
    // this assertion is RED against the old code and GREEN against the fix.
    const legacy = grpcCall(
      addr,
      `${NS}.PkgService/add_decimal`,
      { data: { amount: '1.000' } }
    );
    expect(legacy.exitCode).not.toBe(0);
    // grpcurl resolves the target service via server reflection — since the
    // old address's service is no longer registered (only the
    // project()-derived one is), grpcurl reports it as not exposed rather
    // than the server returning a wire-level UNIMPLEMENTED status.
    expect(legacy.stderr.toLowerCase()).toContain('does not expose service');
  });
});

// ---------------------------------------------------------------------------
// [fix:pygrpc-streaming-deferral] — a `streaming:true` op is explicitly
// rejected (clear error, non-zero exit), never silently mishandled as a
// plain unary call. Documented, already-tracked deferral — gRPC natively
// supports streaming; implementing it is out of scope for this split.
// ---------------------------------------------------------------------------

describe('py-grpc plugin — streaming deferral ([fix:pygrpc-streaming-deferral])', () => {
  it('a streaming:true operation makes the server exit non-zero with a clear error, never silently unary-dispatched', async () => {
    const { planPath } = await buildPlan(STREAMING_FIXTURE_MODULE, NS);
    tempPlanDirs.push(path.dirname(planPath));

    const proc = spawn(
      PYENV.python,
      [
        '-m',
        'apigen_python.grpc_server',
        '--module',
        STREAMING_FIXTURE_MODULE,
        '--namespace',
        NS,
        '--port',
        // 0 (ephemeral) — this server rejects the streaming op in
        // _build_state(), BEFORE add_insecure_port() ever runs, so no port
        // is ever actually bound; kept ephemeral for consistency
        // (BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001) rather than as a fix
        // for an actual collision risk here.
        '0',
        '--plan-file',
        planPath,
      ],
      {
        cwd: PYTHON_PKG_DIR,
        env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    ) as ChildProcessWithoutNullStreams;

    let stderr = '';
    proc.stderr.on('data', (b: Buffer) => (stderr += b.toString()));

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Expected to self-exit rejecting the streaming op; if it didn't,
        // don't leave it running (BUG-APIGEN-TEST-SUBPROCESS-TEARDOWN-LEAK-001).
        proc.kill('SIGKILL');
        reject(new Error('streaming-rejection test: server did not exit within 5s'));
      }, 5000);
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/streaming/i);
    expect(stderr).not.toContain('"ready": true');
  }, 10000);
});

// ===========================================================================
// [py-grpc-serve-split] serve-core extract/serve-split parity gate
// ([def:parity-gate], docs/plan/apigen-serve-core/contexts/_shared.md)
//
// Drives a REAL live py-grpc server the way a consumer does
// ([def:real-consumer-protocol]: spawn + real `grpcurl`) across a
// representative fixture set (mutating-scalar decimal math x2, plain-string,
// session-envelope, validation-failure), and asserts the recapture (through
// the two-phase extract/serve split, NEW project()-reconciled addressing) is
// equivalent to a committed golden snapshot.
//
// UNLIKE py-flask's parity gate, byte-identical ADDRESSING is not the
// invariant here — py-grpc-serve-split's whole point (criterion .5) is that
// the served address CHANGES (the old inline naming was a divergent, unrelated
// scheme — see grpc_server.py's module docstring). What must stay identical
// is the RESULT of each call: the underlying Python functions' decimal math,
// string encoding, envelope extraction, and validation gate are untouched by
// the naming fix, so their OUTPUT values are byte-identical pre/post
// migration even though the WIRE ADDRESS used to reach them is not (and is
// exercised independently above, in the "naming reconciliation" block).
//
// The committed golden (`golden/py-grpc.snapshot.json`) was captured against
// the PRE-MIGRATION single-phase self-extracting server (git-show'd from the
// pre-migration commit into a temp file, spawned directly, called via the
// OLD `pkg.PkgService/<raw_fn_name>` addressing) — a one-time historical
// capture (unlike py-flask, this cannot be regenerated via an
// APIGEN_CAPTURE_GOLDEN=1 escape hatch against "the old server" after this
// commit lands, since the old code no longer exists at HEAD once merged; see
// `docs/apigen/proposals/py-extract-serve-split-findings.md`). Going
// forward, APIGEN_CAPTURE_GOLDEN=1 recaptures via the (now singular) NEW
// driver and overwrites the committed baseline — the same convention every
// other transport's parity gate uses for intentional future changes.
// ===========================================================================

interface GrpcFixtureInput {
  /** Full `<package>.<Service>/<Method>` address to call. */
  method: string;
  data: Record<string, unknown>;
  metadata?: Record<string, string>;
}

interface GrpcFixtureOutput {
  ok: boolean;
  decoded?: unknown;
}

// BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: no fixed PARITY_PORT — this
// suite's own server (below) requests ephemeral port 0 and learns the
// actual bound port via the `onListening` escape hatch.
const PARITY_GOLDEN_PATH = path.join(__dirname, 'golden', 'py-grpc.snapshot.json');

const parityFixtures: ReadonlyArray<GoldenFixture<GrpcFixtureInput>> = [
  {
    name: 'decimal-roundtrip',
    input: { method: grpcAddrFor(ADD_DECIMAL_OP), data: { data: { amount: '123.456' } } },
  },
  {
    name: 'decimal-precision',
    input: { method: grpcAddrFor(ADD_DECIMAL_OP), data: { data: { amount: '0.1' } } },
  },
  {
    name: 'string-roundtrip',
    input: { method: grpcAddrFor(GREET_OP), data: { data: { name: 'World' } } },
  },
  {
    name: 'session-envelope',
    input: {
      method: grpcAddrFor(GREET_WITH_CTX_OP),
      data: { data: { name: 'Alice' } },
      metadata: { 'x-adhd-session': 'sess-parity' },
    },
  },
  {
    name: 'validation-failure',
    input: { method: grpcAddrFor(ADD_DECIMAL_OP), data: { data: {} } },
  },
];

describe('[py-grpc-parity] extract/serve-split golden-snapshot parity gate', () => {
  let controller: AbortController;
  let driver: ParityDriver<GrpcFixtureInput, GrpcFixtureOutput>;
  let runPromise: Promise<void>;
  let addr: string;

  beforeAll(async () => {
    // Drive the REAL production entrypoint (`pyGrpcPlugin.run()`), NOT the
    // test-local `startServer()` spawn helper the earlier LIVE-server blocks
    // use — the negative control below patches `plugin.ts`'s two-phase spawn
    // itself, so the parity gate must actually exercise that code path for
    // the patch's effect to be observable (AGENTS.md §7 "drive the real
    // entrypoint, never a bypass").
    controller = new AbortController();

    // BUG-APIGEN-TEST-FIXED-PORT-COLLISION-001: request an OS-assigned
    // ephemeral port (0) and learn the real one via `onListening` — the
    // production `RunInput`/`OutputPlugin` types are untouched; `options` is
    // already an untyped bag and `onListening` is plugin.ts's own escape
    // hatch (see its module docstring). `onListening` fires only after
    // plugin.ts's own `waitForReady()` has already parsed the server's
    // `{"ready":true}` line, so by the time `portPromise` resolves the
    // server is genuinely accepting connections — no separate grpcurl-poll
    // loop is needed.
    const portPromise = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('[py-grpc-parity] server did not report a bound port within 15s'));
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
      runPromise = pyGrpcPlugin.run(runInput).catch((err: unknown) => {
        // If the process died before reporting readiness, surface that as
        // the portPromise rejection reason instead of waiting out the timer.
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    const boundPort = await portPromise;
    addr = `localhost:${boundPort}`;

    driver = {
      async invoke(fixture: GoldenFixture<GrpcFixtureInput>): Promise<GrpcFixtureOutput> {
        const { method, data, metadata } = fixture.input;
        const result = grpcCall(addr, method, data, metadata);
        if (result.exitCode !== 0) {
          return { ok: false };
        }
        const body = JSON.parse(result.stdout) as Record<string, unknown>;
        const decoded = JSON.parse(body['data'] as string) as unknown;
        return { ok: true, decoded };
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

  // [py-grpc-serve-split.3/.5] the parity gate. Recapture through the
  // (post-migration) two-phase extract/serve split, reconciled naming
  // addressing, and assert deep-equality vs the committed pre-migration
  // golden snapshot (comparing RESULT VALUES — see the block comment above
  // for why addressing itself is intentionally NOT part of the invariant
  // here). FAILS if the migration regresses any fixture's underlying result.
  // Regenerate the golden with APIGEN_CAPTURE_GOLDEN=1 for FUTURE changes
  // (see block comment — the initial baseline was a one-time historical
  // capture against the pre-migration server, not regenerable this way).
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
        `[py-grpc-parity] golden snapshot missing at ${PARITY_GOLDEN_PATH} — ` +
          'regenerate with APIGEN_CAPTURE_GOLDEN=1 before comparing.'
      );
    }
    const committed = JSON.parse(
      fs.readFileSync(PARITY_GOLDEN_PATH, 'utf8')
    ) as GoldenSnapshot<GrpcFixtureOutput>;

    assertParity(committed, recapture);
  });
});

// ---------------------------------------------------------------------------
// [py-grpc-serve-split.4] negative control ([inv:negative-control],
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

describe('[py-grpc-serve-split.4] negative control — the parity gate actually gates', () => {
  it(
    'applying neg-control/py-grpc-serve-split.patch turns the golden-parity check RED; reverting turns it GREEN',
    async () => {
      const repoRoot = findRepoRoot(__dirname);
      const patchPath = path.join(
        repoRoot,
        'docs/plan/apigen-serve-core/neg-control/py-grpc-serve-split.patch'
      );

      function runGoldenParityCheckInFreshProcess(): void {
        const result = spawnSync(
          process.execPath,
          [
            path.join(repoRoot, 'node_modules/vitest/vitest.mjs'),
            'run',
            '--config',
            path.join(repoRoot, 'packages/apigen/apigen-plugin-py-grpc/vite.config.ts'),
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

// ===========================================================================
// [BUG-APIGEN-053] parent-death watchdog
//
// `grpc_server.py`'s only teardown path (before this fix) was the TS
// parent's `input.signal` 'abort' handler (plugin.ts's `run()`), which
// requires the TS parent to be ALIVE to fire it — it never runs if the
// parent is itself SIGKILLed/OOM-killed/crashes. Real-component proof: a
// real intermediate Node harness process (`spawn-and-hold.mjs`, NEVER this
// suite's own process) spawns a REAL `python -m apigen_python.grpc_server`
// grandchild; the harness is SIGKILLed and the grandchild's death is proven
// by POLLING `process.kill(pid, 0)` to a bounded deadline — never a sleep,
// never a log-message assertion.
// ===========================================================================

describe('[BUG-APIGEN-053] parent-death watchdog', () => {
  const HARNESS_PATH = path.resolve(
    __dirname,
    '../../../python-env/src/test-support/spawn-and-hold.mjs'
  );

  // Safety net: force-SIGKILL any harness/grandchild PID captured by the
  // CURRENTLY RUNNING test — including a deliberately-RED run (e.g. the
  // manual negative control documented alongside this suite: temporarily
  // commenting out `start_parent_death_watchdog()` in grpc_server.py) — so a
  // failing assertion never itself leaves a live orphan behind.
  let activeHarness: ChildProcessWithoutNullStreams | undefined;
  let activeChildPid: number | undefined;

  afterEach(() => {
    if (activeHarness && !activeHarness.killed) {
      try {
        activeHarness.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }
    if (activeChildPid !== undefined) {
      try {
        process.kill(activeChildPid, 'SIGKILL');
      } catch {
        /* already dead, or never existed — fine either way */
      }
    }
    activeHarness = undefined;
    activeChildPid = undefined;
  });

  /**
   * Polls (never a single sleep-then-check) for `pid`'s death via the
   * zero-signal probe (`process.kill(pid, 0)` throws ESRCH once the process
   * is gone), every 100ms, bounded to `deadlineMs`. Resolves `true` if the
   * process died within the deadline, `false` if still alive when the
   * deadline elapsed.
   */
  async function pollForDeath(pid: number, deadlineMs = 10_000): Promise<boolean> {
    const start = Date.now();
    for (;;) {
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (!alive) return true;
      if (Date.now() - start >= deadlineMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it(
    'a Python host survives its own spawning process being SIGKILLed, then self-terminates within a bounded deadline (poll, never sleep)',
    async () => {
      const planPath = await ensurePlan();
      const harness = spawn(
        'node',
        [
          HARNESS_PATH,
          PYENV.python,
          '-m',
          'apigen_python.grpc_server',
          '--module',
          FIXTURE_MODULE,
          '--namespace',
          NS,
          '--host',
          '127.0.0.1',
          '--port',
          '0',
          '--plan-file',
          planPath,
        ],
        {
          // The harness spawns the grandchild WITHOUT its own explicit
          // cwd/env (see spawn-and-hold.mjs) -- Node then defaults the
          // grandchild's cwd/env to the harness process's own, so setting
          // them HERE (identically to startServer()'s direct spawn) is what
          // propagates PYTHONPATH/cwd through to the grandchild.
          cwd: PYTHON_PKG_DIR,
          env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      ) as ChildProcessWithoutNullStreams;
      activeHarness = harness;

      // First stdout line from the harness itself is `{"childPid":<n>}`;
      // every subsequent line is the grandchild's own stdout, forwarded
      // verbatim (prefixed) — keep reading until the grandchild's real
      // `{"ready": true, ...}` readiness line appears.
      const childPid = await new Promise<number>((resolve, reject) => {
        const rl = readline.createInterface({ input: harness.stdout });
        let sawPid: number | undefined;
        const timer = setTimeout(() => {
          rl.close();
          reject(
            new Error('[BUG-APIGEN-053] harness/grandchild did not report readiness within 15s')
          );
        }, 15_000);

        rl.on('line', (line: string) => {
          if (sawPid === undefined) {
            try {
              const msg = JSON.parse(line) as { childPid?: number };
              if (typeof msg.childPid === 'number') {
                sawPid = msg.childPid;
                activeChildPid = sawPid;
              }
            } catch {
              /* the harness's own first line is always valid JSON; ignore
                 anything else while we're still waiting for it */
            }
            return;
          }
          if (line.includes('"ready": true') || line.includes('"ready":true')) {
            clearTimeout(timer);
            rl.close();
            resolve(sawPid as number);
          }
        });

        harness.on('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`[BUG-APIGEN-053] harness exited early (code ${code})`));
        });
      });

      // Sanity: the grandchild is genuinely alive and listening before we
      // do anything to it.
      expect(() => process.kill(childPid, 0)).not.toThrow();

      // Kill ONLY the intermediate harness — never the grandchild directly.
      // This is the SIGKILL the real-world parent (a vitest worker/matrix
      // runner) would receive; the grandchild must detect it via stdin EOF.
      harness.kill('SIGKILL');

      const died = await pollForDeath(childPid, 10_000);
      expect(died).toBe(true);
    },
    20_000
  );

  it(
    'a Python host torn down gracefully (normal suite path) also disappears within the same bounded deadline, proven by PID poll',
    async () => {
      const live = await startServer();
      server = live;
      const pid = live.proc.pid;
      if (pid === undefined) {
        throw new Error('[BUG-APIGEN-053] startServer(): spawned process has no pid');
      }
      activeChildPid = pid;
      expect(() => process.kill(pid, 0)).not.toThrow();

      await live.stop();
      server = undefined;

      const died = await pollForDeath(pid, 10_000);
      expect(died).toBe(true);
    },
    20_000
  );
});
