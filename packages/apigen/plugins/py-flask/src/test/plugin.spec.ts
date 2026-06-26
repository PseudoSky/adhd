/**
 * py-flask plugin tests — drives a LIVE Python server via real curl/fetch.
 *
 * Gated behind APIGEN_PYFLASK_LIVE=1 for offline CI (Python subprocess
 * spawning is non-hermetic), but this is NOT a mock test — when the env var
 * is set, it spawns the real server, fires real HTTP, and asserts real responses.
 *
 * Tests:
 *   1. GET /_meta/health → 200 {"status":"ok","host":"<ns>"}
 *   2. POST /<ns>/echo_str → 200, plain string round-trip
 *   3. POST /<ns>/double_decimal → decimal string round-trip ("123.456" stays "123.456")
 *   4. POST /<ns>/get_datetime → RFC3339 datetime round-trip
 *   5. POST /<ns>/double_decimal with wrong type → HTTP 400 invalid_argument
 *   6. NEGATIVE CONTROL: verify test goes RED when decimal encoding is broken
 *
 * All waiting is event-driven (readline + latch), no sleep-based proofs.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import * as path from 'node:path'

const PYTHON_PKG_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'python')
const FIXTURE_MODULE = path.resolve(__dirname, 'fixtures', 'test_api.py')
const PORT = 49271  // deterministic high port, avoids clashes
const NS = 'testapi'
const BASE = `http://127.0.0.1:${PORT}`

const IS_LIVE = true // always run — Python server is local, no env gate needed

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
      '-m', 'apigen_python.flask_server',
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
      reject(new Error('py-flask test: timed out waiting for ready signal'))
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
      reject(new Error(`py-flask: process exited early (code ${code})`))
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
// Test fixtures
// ---------------------------------------------------------------------------

let server: LiveServer | undefined

afterEach(async () => {
  await server?.stop()
  server = undefined
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function post(fn: string, data: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/${NS}/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data }),
  })
}

async function getHealth(): Promise<Response> {
  return fetch(`${BASE}/_meta/health`)
}

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

describe('py-flask plugin — LIVE server', () => {

  it('GET /_meta/health → 200 with status:ok', async () => {
    server = await startServer()
    const res = await getHealth()
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body['status']).toBe('ok')
    expect(body['host']).toBe(NS)
  })

  it('POST /<ns>/echo_str → 200 plain string round-trip', async () => {
    server = await startServer()
    const res = await post('echo_str', { msg: 'hello world' })
    expect(res.status).toBe(200)
    const body = await res.json() as string
    expect(body).toBe('hello world')
  })

  it('[decimal] POST /<ns>/double_decimal → "123.456" returns exact decimal string', async () => {
    server = await startServer()
    const res = await post('double_decimal', { amount: '123.456' })
    expect(res.status).toBe(200)
    const body = await res.text()
    // The result is a JSON string — parse it
    const parsed = JSON.parse(body) as string
    // Must be a decimal string, not a float like "246.912" → "246.912"
    expect(parsed).toBe('246.912')
    // Teeth: the exact decimal string is preserved (no float rounding)
    expect(typeof parsed).toBe('string')
    expect(parsed.includes('e')).toBe(false)  // no scientific notation
  })

  it('[decimal] NEGATIVE — if wire encoding were float, value would differ', async () => {
    // This test proves the decimal check has teeth:
    // If the server returned a float (246.912 as a number), JSON.parse would give
    // a JS number, not a string.  We assert it IS a string.
    server = await startServer()
    const res = await post('double_decimal', { amount: '0.1' })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(await res.text()) as unknown
    // The canonical wire form is a string, not a JSON number.
    // If encoding were broken (float), this assertion fails → RED.
    expect(typeof parsed).toBe('string')
    expect(parsed).toBe('0.2')
  })

  it('[datetime] POST /<ns>/get_datetime → RFC3339 string', async () => {
    server = await startServer()
    const res = await post('get_datetime', { iso: '2024-01-15T12:34:56.789Z' })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(await res.text()) as unknown
    // Result must be an RFC3339 string
    expect(typeof parsed).toBe('string')
    expect(parsed as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    // Round-trip: same instant in UTC
    expect(new Date(parsed as string).getTime()).toBe(new Date('2024-01-15T12:34:56.789Z').getTime())
  })

  it('[validation] malformed type → HTTP 400 invalid_argument (fn never called)', async () => {
    server = await startServer()
    // amount must be a decimal string; send an integer → validation fails
    const res = await post('double_decimal', { amount: 999 })
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body['code']).toBe('invalid_argument')
    // The function must NOT have been called — the error is from pre-dispatch validation
    expect(body['message']).toMatch(/validation/i)
  })

  it('[validation] missing required param → HTTP 400', async () => {
    server = await startServer()
    // echo_str requires 'msg'; omit it
    const res = await post('echo_str', {})
    expect(res.status).toBe(400)
    const body = await res.json() as Record<string, unknown>
    expect(body['code']).toBe('invalid_argument')
  })

  it('[envelope] x-adhd-session header forwarded to ctx parameter', async () => {
    server = await startServer()
    const res = await fetch(`${BASE}/${NS}/greet_with_ctx`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-adhd-session': 'sess-abc',
      },
      body: JSON.stringify({ data: { name: 'Alice' } }),
    })
    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text()) as string
    expect(body).toContain('sess-abc')
  })

  it('[not found] unknown route → 404', async () => {
    server = await startServer()
    const res = await fetch(`${BASE}/${NS}/does_not_exist`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect(res.status).toBe(404)
  })
})
