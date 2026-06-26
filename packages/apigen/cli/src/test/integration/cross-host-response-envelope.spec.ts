// BUG-APIGEN-015 regression guard — cross-host RESPONSE-envelope conformance.
//
// Proves that the api-fastify TS host and the py-flask Python host emit
// BYTE-IDENTICAL HTTP response bodies for scalar logical-type returns
// (Decimal, datetime/Date).  This is the seam that the conformance suite
// missed: it tested encode/decode FUNCTIONS, not the full HTTP response
// envelope.  Driving both REAL servers closes that gap.
//
// What is proven:
//   (1) api-fastify Decimal return → body `"123.457"` with `content-type:
//       application/json` (NOT bare `123.457` with `text/plain` — that was
//       the BUG-APIGEN-015 regression).
//   (2) py-flask Decimal return   → same bytes.
//   (3) Byte-identical assertion: both bodies are exactly the same string,
//       so a cross-language client can consume either uniformly.
//   (4) datetime / Date round-trip: same byte-equality guarantee.
//
// TEETH — the test fails if api-fastify reverts to text/plain:
//   - The content-type assertion `expect(ct).toContain('application/json')`
//     fires immediately.
//   - The body assertion `expect(tsBody).toBe('"123.457"')` (note the outer
//     quotes) fails if the body is the bare string `123.457`.
//   - The byte-equality assertion `expect(tsBody).toBe(pyBody)` fails because
//     py-flask always emits `"123.457"` (canonical JSON string).
//
// Architecture:
//   - TS host: spawned via the BUILT CLI (`node dist/…/cli/index.js run
//     --type api-fastify`) so this drives the REAL bundled artifact.
//   - Python host: spawned via `python3 -m apigen_python.flask_server`
//     directly (same subprocess path as the CLI's py-flask plugin uses) with
//     PYTHONPATH pointing at packages/apigen/python.
//   - Fixture: a tiny shared TypeScript surface + the matching Python
//     surface, both implementing `price(v: Decimal): Decimal` and
//     `when(): datetime/Date` with known outputs for comparison.
//
// Live: runs BY DEFAULT, unflagged (CLAUDE.md §6 "Live testing is mandatory").
// Local servers are NOT a paid third-party service — no env gating.
// The test requires `python3` on PATH; a missing interpreter FAILS loudly.

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as net from 'node:net'
import * as readline from 'node:readline'

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The bundled standalone CLI — guaranteed present via dependsOn:["build"]. */
const CLI_PATH = (() => {
  let dir = __dirname
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'dist/packages/apigen/cli/index.js')
    if (fs.existsSync(candidate)) return candidate
    dir = path.dirname(dir)
  }
  return path.resolve(__dirname, '../../../../../dist/packages/apigen/cli/index.js')
})()

/** Absolute path to packages/apigen/python — used as PYTHONPATH. */
const PYTHON_PKG_DIR = (() => {
  let dir = __dirname
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, 'packages/apigen/python')
    if (fs.existsSync(path.join(candidate, 'apigen_python'))) return candidate
    dir = path.dirname(dir)
  }
  return path.resolve(__dirname, '../../../../../packages/apigen/python')
})()

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * TypeScript surface: `price(v: Decimal): Decimal` returns v + 0.001.
 * Uses the standard `@format decimal` JSDoc alias so extraction emits
 * `{type:'string', format:'decimal'}` without needing the decimal.js class.
 */
const TS_FIXTURE = `
/** @format decimal */
export type Decimal = string;

/** Add a small increment to a decimal price. */
export async function price(v: Decimal): Promise<Decimal> {
  // Decimal strings: just parse + add to keep the fixture dependency-free.
  const result = (parseFloat(v) + 0.001).toFixed(3);
  return result as Decimal;
}

/** Return a fixed date-time string (identity for wire comparison). */
export async function when(): Promise<string> {
  return "2024-01-15T12:00:00.000Z";
}
`.trim()

/**
 * Python surface: matching functions for byte-equality comparison.
 * Returns the same values as the TS fixture for the same inputs.
 */
const PY_FIXTURE = `
from decimal import Decimal as D

__all__ = ["price", "when"]

def price(v: D) -> D:
    """Add 0.001 to a Decimal price."""
    return v + D("0.001")

def when() -> str:
    """Return a fixed date-time string."""
    return "2024-01-15T12:00:00.000Z"
`.trim()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Allocate a free TCP port via the OS (listen-then-close). */
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

/**
 * Wait for an HTTP endpoint to respond (bounded poll — no fixed sleep).
 * Retries every 100 ms until `timeoutMs` is exhausted.
 */
async function waitForHttp(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(url)
      return
    } catch (e) {
      lastErr = e
      await new Promise<void>((r) => setTimeout(r, 100))
    }
  }
  throw new Error(
    `waitForHttp: ${url} never responded within ${timeoutMs}ms — last error: ${String(lastErr)}`,
  )
}

/**
 * Wait for a Python subprocess to emit `{"ready":true}` on stdout.
 * Bounded to `timeoutMs`; rejects on early process exit.
 */
function waitForPythonReady(
  proc: ChildProcessWithoutNullStreams,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: proc.stdout })
    let settled = false
    function settle(fn: () => void) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl.close()
      fn()
    }
    const timer = setTimeout(() => {
      settle(() => reject(new Error('py-flask: timed out waiting for {"ready":true}')))
    }, timeoutMs)
    rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line.trim()) as Record<string, unknown>
        if (msg['ready'] === true) settle(() => resolve())
      } catch { /* non-JSON lines ignored */ }
    })
    proc.on('exit', (code) => {
      settle(() => reject(new Error(`py-flask: python3 exited prematurely (code ${code})`)))
    })
  })
}

/** Kill a child process and wait (bounded) for it to exit. */
async function kill(proc: ChildProcessWithoutNullStreams): Promise<void> {
  if (proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve() }, 2000)
    proc.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

// ---------------------------------------------------------------------------
// Server lifecycle management
// ---------------------------------------------------------------------------

interface LiveServer {
  port: number
  ns: string
  proc?: ChildProcessWithoutNullStreams
  abort?: AbortController
  teardown: () => Promise<void>
}

const liveServers: LiveServer[] = []

afterEach(async () => {
  // Always tear down every server spawned in this test file, even on failure.
  await Promise.all(liveServers.map((s) => s.teardown()))
  liveServers.length = 0
})

/**
 * Spawn the TS api-fastify server via the bundled CLI.
 * Returns when the server is ready to accept requests.
 */
async function startTsServer(
  fixturePath: string,
  port: number,
  ns: string,
): Promise<LiveServer> {
  expect(
    fs.existsSync(CLI_PATH),
    `Built CLI not found at ${CLI_PATH} — run 'nx build apigen-cli' first.`,
  ).toBe(true)

  const ac = new AbortController()
  // The CLI process handles its own AbortController internally; we just kill
  // it when done.
  const proc = spawn(
    'node',
    [
      CLI_PATH,
      'run',
      '--source', fixturePath,
      '--type', 'api-fastify',
      '--namespace', ns,
      '--opt', `port=${port}`,
      '--opt', 'host=127.0.0.1',
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  ) as ChildProcessWithoutNullStreams

  proc.stderr.on('data', () => { /* suppress */ })
  proc.stdout.on('data', () => { /* suppress */ })

  // Wait until the fastify server accepts connections.
  await waitForHttp(`http://127.0.0.1:${port}/__probe__`, 15_000)

  const server: LiveServer = {
    port,
    ns,
    proc,
    abort: ac,
    teardown: async () => { if (proc) await kill(proc) },
  }
  liveServers.push(server)
  return server
}

/**
 * Spawn the Python py-flask server directly via `python3 -m
 * apigen_python.flask_server`. The CLI's py-flask plugin does the same
 * thing internally; spawning directly keeps the test self-contained and
 * avoids the round-trip through the CLI's run-v1 path for a .py source.
 */
async function startPyServer(
  fixturePath: string,
  port: number,
  ns: string,
): Promise<LiveServer> {
  const proc = spawn(
    'python3',
    [
      '-m', 'apigen_python.flask_server',
      '--module', fixturePath,
      '--namespace', ns,
      '--host', '127.0.0.1',
      '--port', String(port),
    ],
    {
      cwd: PYTHON_PKG_DIR,
      env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ) as ChildProcessWithoutNullStreams

  proc.stderr.on('data', () => { /* suppress */ })

  await waitForPythonReady(proc, 15_000)

  const server: LiveServer = {
    port,
    ns,
    proc,
    teardown: async () => { if (proc) await kill(proc) },
  }
  liveServers.push(server)
  return server
}

// ---------------------------------------------------------------------------
// Cross-host RESPONSE-envelope conformance
// ---------------------------------------------------------------------------

describe('[cross-host-response-envelope] BUG-APIGEN-015 regression guard', () => {
  it(
    'api-fastify and py-flask emit byte-identical JSON responses for scalar Decimal returns',
    { timeout: 60_000 },
    async () => {
      // Write fixtures to a temp dir.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-xhost-'))
      const tsFixture = path.join(tmpDir, 'price_api.ts')
      const pyFixture = path.join(tmpDir, 'price_api.py')
      fs.writeFileSync(tsFixture, TS_FIXTURE)
      fs.writeFileSync(pyFixture, PY_FIXTURE)

      try {
        const [tsPort, pyPort] = await Promise.all([freePort(), freePort()])

        const NS = 'price_api'

        // Spawn both servers in parallel (independent processes).
        const [tsServer, pyServer] = await Promise.all([
          startTsServer(tsFixture, tsPort, NS),
          startPyServer(pyFixture, pyPort, NS),
        ])

        const tsBase = `http://127.0.0.1:${tsServer.port}/${NS}/price`
        const pyBase = `http://127.0.0.1:${pyServer.port}/${NS}/price`

        // POST the same Decimal input to both servers.
        const body = JSON.stringify({ data: { v: '123.456' } })
        const headers = { 'Content-Type': 'application/json' }

        const [tsRes, pyRes] = await Promise.all([
          fetch(tsBase, { method: 'POST', headers, body }),
          fetch(pyBase, { method: 'POST', headers, body }),
        ])

        expect(tsRes.status, 'api-fastify must return 200').toBe(200)
        expect(pyRes.status, 'py-flask must return 200').toBe(200)

        // ── (1) TS host content-type must be application/json ──────────────
        // BUG-APIGEN-015: before the fix, api-fastify returned text/plain for
        // scalar logical returns.  This assertion fires immediately if reverted.
        const tsCt = tsRes.headers.get('content-type') ?? ''
        expect(tsCt, 'api-fastify content-type must be application/json').toContain(
          'application/json',
        )

        // ── (2) TS body must be a JSON string (with surrounding quotes) ────
        const tsBody = await tsRes.text()
        expect(
          tsBody,
          'api-fastify Decimal return must be a JSON-encoded string "123.457" (with quotes)',
        ).toBe('"123.457"')

        // ── (3) PY body ────────────────────────────────────────────────────
        const pyBody = await pyRes.text()
        expect(
          pyBody,
          'py-flask Decimal return must be a JSON-encoded string "123.457" (with quotes)',
        ).toBe('"123.457"')

        // ── (4) BYTE-IDENTICAL assertion ───────────────────────────────────
        // The headline cross-language guarantee: same bytes, same content-type.
        // A client that JSON.parses either body gets the lossless string "123.457".
        expect(
          tsBody,
          'api-fastify and py-flask Decimal responses must be byte-identical',
        ).toBe(pyBody)

        // Confirm JSON.parse round-trips correctly (no precision loss).
        expect(JSON.parse(tsBody) as string).toBe('123.457')
        expect(JSON.parse(pyBody) as string).toBe('123.457')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  it(
    'api-fastify returns application/json (not text/plain) — TEETH: reverts sendJson → test goes RED',
    { timeout: 60_000 },
    async () => {
      // This test isolates the content-type assertion as a standalone teeth check.
      // If sendJson() in api-fastify/run.ts is reverted to `reply.send(string)`,
      // fastify will emit `text/plain; charset=utf-8` and the assertions below fail.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-xhost-ct-'))
      const tsFixture = path.join(tmpDir, 'price_api.ts')
      fs.writeFileSync(tsFixture, TS_FIXTURE)

      try {
        const NS2 = 'price_api'
        const tsPort = await freePort()
        await startTsServer(tsFixture, tsPort, NS2)

        // Use Decimal `0.000` input → fixture returns `0.001` (0 + 0.001).
        // The TS fixture adds 0.001, so `0.000` → `"0.001"` on the wire.
        const res = await fetch(
          `http://127.0.0.1:${tsPort}/${NS2}/price`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: { v: '0.000' } }),
          },
        )

        expect(res.status).toBe(200)
        const ct = res.headers.get('content-type') ?? ''
        // TEETH: reverts sendJson → text/plain → this fails.
        expect(ct).toContain('application/json')

        const raw = await res.text()
        // TEETH: reverts sendJson → bare `0.001` (no quotes) instead of
        // `"0.001"` (JSON string). JSON.parse of the bare number returns a
        // float, not a string; JSON.parse of the quoted string returns "0.001".
        // The assertion below fails in both cases if sendJson is reverted.
        expect(typeof JSON.parse(raw)).toBe('string')

        // Negative control: a bare number `0.001` parsed from text/plain would
        // be typeof 'number', not 'string'. This is the BUG-APIGEN-015 symptom.
        expect(typeof JSON.parse(raw)).not.toBe('number')
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )
})
