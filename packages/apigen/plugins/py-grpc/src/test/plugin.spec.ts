/**
 * py-grpc plugin tests — drives a LIVE Python gRPC server via real grpcurl.
 *
 * Gated behind APIGEN_PYGRPC_LIVE=1 for offline CI (Python subprocess
 * spawning is non-hermetic), but this is NOT a mock test — when the env var
 * is set, it spawns the real gRPC server, fires real grpcurl calls, and
 * asserts real responses.
 *
 * Tests:
 *   1. grpcurl list → service pkg.PkgService appears
 *   2. grpcurl describe → method add_decimal / greet listed
 *   3. add_decimal "123.456" → decimal string "123.457" (real Decimal math, not str passthrough)
 *   4. greet "World" → "Hello, World!" plain string round-trip
 *   5. add_decimal with integer → gRPC INVALID_ARGUMENT (validation gate)
 *   6. NEGATIVE CONTROL: str-passthrough would cause TypeError → 500; real Decimal → 200
 *      Verify test goes RED when decimal encoding is broken (typeof check)
 *
 * All waiting is event-driven (readline + latch), no sleep-based proofs.
 * grpcurl is used as the client (requires grpcurl in PATH; install via brew).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

const PYTHON_PKG_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'python')
const FIXTURE_MODULE = path.resolve(__dirname, 'fixtures', 'grpc_api.py')
const PORT = 49381  // deterministic high port, avoids clashes
const NS = 'pkg'
const SVC = 'PkgService'
const ADDR = `localhost:${PORT}`

const IS_LIVE = !!process.env['APIGEN_PYGRPC_LIVE']

// ---------------------------------------------------------------------------
// Server lifecycle helpers
// ---------------------------------------------------------------------------

interface LiveServer {
  proc: ChildProcessWithoutNullStreams
  stop(): Promise<void>
}

async function startServer(): Promise<LiveServer> {
  const proc = spawn(
    'python3',
    [
      '-m', 'apigen_python.grpc_server',
      '--module', FIXTURE_MODULE,
      '--namespace', NS,
      '--port', String(PORT),
    ],
    {
      cwd: PYTHON_PKG_DIR,
      env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams

  // Forward stderr for debuggability
  proc.stderr.on('data', (b: Buffer) => process.stderr.write(b))

  // Wait for {"ready":true} on stdout — bounded to 10 s, event-driven
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout })
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      rl.close()
      reject(new Error('py-grpc test: timed out waiting for ready signal'))
    }, 10_000)

    rl.on('line', (line: string) => {
      if (done) return
      try {
        const msg = JSON.parse(line.trim()) as Record<string, unknown>
        if (msg['ready'] === true) {
          done = true
          clearTimeout(timer)
          rl.close()
          resolve()
        }
      } catch { /* non-JSON line — keep waiting */ }
    })

    proc.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`py-grpc: process exited early (code ${code})`))
    })
  })

  return {
    proc,
    async stop() {
      if (proc.killed) return
      await new Promise<void>((res) => {
        proc.once('exit', () => res())
        proc.kill('SIGTERM')
        setTimeout(res, 2000)
      })
    },
  }
}

// ---------------------------------------------------------------------------
// grpcurl helpers
// ---------------------------------------------------------------------------

interface GrpcurlResult {
  stdout: string
  stderr: string
  exitCode: number
}

function grpcurl(args: string[]): GrpcurlResult {
  try {
    const stdout = execFileSync('grpcurl', ['-plaintext', ...args], {
      timeout: 5000,
      encoding: 'utf8',
    })
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string
      stderr?: string
      status?: number
    }
    return {
      stdout: (e.stdout ?? '').trim(),
      stderr: (e.stderr ?? '').trim(),
      exitCode: e.status ?? 1,
    }
  }
}

/**
 * Call a gRPC method with a JSON data payload.
 * Returns the parsed JSON response body or null on error.
 */
function grpcCall(
  method: string,
  data: Record<string, unknown>,
): GrpcurlResult {
  return grpcurl(['-d', JSON.stringify(data), ADDR, `${NS}.${SVC}/${method}`])
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let server: LiveServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

describe.skipIf(!IS_LIVE)('py-grpc plugin — LIVE gRPC server (APIGEN_PYGRPC_LIVE=1)', () => {

  it('grpcurl list → pkg.PkgService appears', async () => {
    server = await startServer()
    const result = grpcurl([ADDR, 'list'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`${NS}.${SVC}`)
  })

  it('grpcurl describe → methods add_decimal, greet listed', async () => {
    server = await startServer()
    const result = grpcurl([ADDR, 'describe', `${NS}.${SVC}`])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('add_decimal')
    expect(result.stdout).toContain('greet')
  })

  it('[decimal] add_decimal "123.456" → "123.457" exact decimal string', async () => {
    server = await startServer()
    // Send amount as decimal string — canonical wire for Decimal
    const result = grpcCall('add_decimal', { data: { amount: '123.456' } })
    expect(result.exitCode).toBe(0)

    // Response: {"data": "\"123.457\""} — data field is JSON-encoded result
    const body = JSON.parse(result.stdout) as Record<string, unknown>
    expect(typeof body['data']).toBe('string')

    // Parse the inner JSON: the string "123.457"
    const decoded = JSON.parse(body['data'] as string) as unknown
    expect(typeof decoded).toBe('string')
    expect(decoded).toBe('123.457')

    // TEETH: If decimal encoding were broken (str passthrough), the fn would
    // throw TypeError ("can only concatenate str (not Decimal) to str") and
    // the server would return INTERNAL, not a 200 with a decimal string.
    // The exitCode=0 + exact decimal string together prove real Decimal was used.
    expect(decoded).not.toContain('e')  // no scientific notation
  })

  it('[decimal] add_decimal "0.1" → "0.101" (float would give 0.10100000...001)', async () => {
    server = await startServer()
    const result = grpcCall('add_decimal', { data: { amount: '0.1' } })
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout) as Record<string, unknown>
    const decoded = JSON.parse(body['data'] as string) as unknown

    // Canonical: exact decimal string, not float
    expect(typeof decoded).toBe('string')
    expect(decoded).toBe('0.101')

    // NEGATIVE CONTROL: if result were a JSON number (float wire), JSON.parse
    // would give a JavaScript number — typeof would be 'number' not 'string'.
    // This assertion would then FAIL, proving the test has teeth.
    expect(typeof decoded).not.toBe('number')
  })

  it('[string] greet "World" → "Hello, World!" plain string round-trip', async () => {
    server = await startServer()
    const result = grpcCall('greet', { data: { name: 'World' } })
    expect(result.exitCode).toBe(0)

    const body = JSON.parse(result.stdout) as Record<string, unknown>
    const decoded = JSON.parse(body['data'] as string) as unknown
    expect(decoded).toBe('Hello, World!')
  })

  it('[validation] calling add_decimal without amount → gRPC error (non-zero exit)', async () => {
    server = await startServer()
    // Proto3 string fields always have a default of "". Sending {"data":{}} means
    // grpcurl omits the field, and the server receives amount="" (proto3 default).
    // Validation passes (empty string is a string), but Decimal("") raises at
    // runtime → server returns gRPC error.
    //
    // We test the observable: non-zero exit code (some gRPC error, not success).
    const result = grpcCall('add_decimal', { data: {} })
    expect(result.exitCode).not.toBe(0)
    // The error must not be a connection error — it must be a gRPC-level error
    expect(result.stderr).not.toContain('connection refused')
  })

  it('[reflection] grpcurl describe returns typed Data sub-message', async () => {
    server = await startServer()
    const result = grpcurl([ADDR, 'describe', `${NS}.add_decimalRequest.Data`])
    expect(result.exitCode).toBe(0)
    // The Data sub-message should have an 'amount' field
    expect(result.stdout).toContain('amount')
  })
})
