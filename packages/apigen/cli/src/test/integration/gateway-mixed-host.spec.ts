// Mixed-host gateway (dod.12 cross-host routing + dod.17 partial availability) —
// drives the REAL gateway (`@adhd/apigen-gateway`'s `createGateway`) across TWO
// real host runtimes:
//
//   - host:ts     → the in-process TS adapter (zero hop), calling a real TS fn.
//   - host:python → a REAL out-of-process Python sidecar
//                   (`python3 -m apigen_python.gateway_adapter`), spoken to over
//                   its line-delimited JSON-RPC wire protocol. This is NOT a mock —
//                   the actual Python process answers `host:python` ops.
//
// Proven outcomes:
//   (dod.12) With both hosts up behind ONE gateway surface, a `host:ts` op is
//            answered by the TS runtime and a `host:python` op by the Python
//            runtime; BOTH return their in-process ground truth.
//   (dod.17) Killing the Python sidecar returns `unavailable` for ONLY its ops,
//            while the TS host KEEPS serving its ground truth (partial
//            availability §13.1). Negative control: the healthy TS host is never
//            taken down by the Python host's death.
//
// Determinism (CLAUDE.md §6): readiness is a bounded poll/latch on the sidecar's
// `{"ready":true}` startup line + a `ready` round-trip — no fixed sleeps. The
// sidecar process is ALWAYS killed in teardown (no orphans), guarded by a
// bounded wait on its exit.

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as path from 'node:path'
import * as readline from 'node:readline'
import {
  createGateway,
  createInProcessHostAdapter,
  isGatewayError,
  type Gateway,
  type HostAdapter,
  type HostRequest,
  type InProcessRuntime,
} from '@adhd/apigen-gateway'
import type { Operation, Transport } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Minimal Operation builders, host-tagged for routing.
// ---------------------------------------------------------------------------

function seg(raw: string) {
  return { raw, words: [raw] }
}

function op(host: string, id: string): Operation {
  return {
    id,
    host,
    namespace: seg(host),
    path: [seg(id)],
    kind: 'action',
    async: true,
    streaming: false,
    safe: false,
    input: { type: 'object', properties: {}, required: [] },
    output: {},
    envelope: {},
    typeText: null,
  }
}

function req(operation: Operation, data: Record<string, unknown> = {}): HostRequest {
  return { operation, data, envelope: {}, transport: 'http' as Transport }
}

// ---------------------------------------------------------------------------
// REAL Python sidecar HostAdapter — spawns python3 + speaks line-JSON-RPC.
// ---------------------------------------------------------------------------

const PYTHON_PKG_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'python')

interface PythonSidecar {
  adapter: HostAdapter
  /** Kill the underlying process and await its exit (bounded). */
  kill(): Promise<void>
  /** The child process handle (for assertions / cleanup). */
  child(): ChildProcessWithoutNullStreams | undefined
}

function createPythonSidecar(host: string): PythonSidecar {
  let proc: ChildProcessWithoutNullStreams | undefined
  let readyLatch: Promise<void> | undefined
  let resolveReady: (() => void) | undefined
  let rejectReady: ((e: unknown) => void) | undefined
  const exitListeners = new Set<(reason: unknown) => void>()
  // Pending JSON-RPC calls keyed by request id.
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let nextId = 1
  let processExited = false

  const adapter: HostAdapter = {
    host,
    hopCost: 1,
    async start() {
      if (proc) return // idempotent
      processExited = false
      readyLatch = new Promise<void>((res, rej) => {
        resolveReady = res
        rejectReady = rej
      })
      proc = spawn('python3', ['-m', 'apigen_python.gateway_adapter'], {
        cwd: PYTHON_PKG_DIR,
        env: { ...process.env, PYTHONPATH: PYTHON_PKG_DIR },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams

      const rl = readline.createInterface({ input: proc.stdout })
      rl.on('line', (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let msg: Record<string, unknown>
        try {
          msg = JSON.parse(trimmed)
        } catch {
          return
        }
        // Startup readiness signal: {"ready": true}
        if (msg['ready'] === true && msg['id'] === undefined) {
          resolveReady?.()
          return
        }
        // JSON-RPC response: {id, result} | {id, error}
        const id = msg['id'] as string | undefined
        if (id !== undefined && pending.has(id)) {
          const { resolve, reject } = pending.get(id)!
          pending.delete(id)
          if ('error' in msg) reject(msg['error'])
          else resolve(msg['result'])
        }
      })

      proc.on('exit', (code) => {
        processExited = true
        const reason = `python sidecar exited (code ${code})`
        // Fail any in-flight calls so the gateway maps them to unavailable.
        for (const [, p] of pending) p.reject(new Error(reason))
        pending.clear()
        rejectReady?.(new Error(reason))
        for (const l of [...exitListeners]) l(reason)
      })
    },
    async ready() {
      if (!proc || processExited) return false
      try {
        // Wait for the startup readiness line (bounded).
        await Promise.race([
          readyLatch,
          new Promise<void>((_, rej) => setTimeout(() => rej(new Error('ready timeout')), 5000)),
        ])
      } catch {
        return false
      }
      // Confirm with a live `ready` round-trip.
      try {
        const r = (await rpc('ready', {})) as { ready?: boolean }
        return r?.ready === true
      } catch {
        return false
      }
    },
    async invoke(request, _signal) {
      if (!proc || processExited) throw new Error(`python host ${host} not serving`)
      return rpc('invoke', {
        operation: request.operation,
        data: request.data,
        envelope: request.envelope,
        transport: request.transport,
      })
    },
    onExit(listener) {
      exitListeners.add(listener)
      return () => exitListeners.delete(listener)
    },
    async stop() {
      await killProc()
    },
  }

  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!proc || processExited || !proc.stdin.writable) {
        reject(new Error('python sidecar not writable'))
        return
      }
      const id = String(nextId++)
      pending.set(id, { resolve, reject })
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      // Bounded per-call deadline so a hung call never hangs the suite.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`python rpc '${method}' timed out`))
        }
      }, 5000)
    })
  }

  async function killProc(): Promise<void> {
    const p = proc
    proc = undefined
    if (!p || p.killed || processExited) return
    await new Promise<void>((resolve) => {
      const done = () => resolve()
      p.once('exit', done)
      p.kill('SIGKILL')
      // Bounded fallback in case exit never fires.
      setTimeout(done, 2000)
    })
  }

  return {
    adapter,
    kill: killProc,
    child: () => proc,
  }
}

// ---------------------------------------------------------------------------
// REAL in-process TS runtime — a tiny harness returning ground truth.
// ---------------------------------------------------------------------------

/** Ground-truth TS fns keyed by operation id. */
const TS_FNS: Record<string, (data: Record<string, unknown>) => unknown> = {
  'ts/double': (data) => ({ host: 'ts', value: (data['n'] as number) * 2 }),
}

const tsRuntime: InProcessRuntime = {
  async invoke(request: HostRequest): Promise<unknown> {
    const fn = TS_FNS[request.operation.id]
    if (!fn) throw new Error(`no ts fn for ${request.operation.id}`)
    return fn(request.data)
  },
}

// ---------------------------------------------------------------------------
// Lifecycle — always stop the gateway (which kills the sidecar) in teardown.
// ---------------------------------------------------------------------------

let gateway: Gateway | undefined
let sidecar: PythonSidecar | undefined

afterEach(async () => {
  await gateway?.stop()
  await sidecar?.kill()
  gateway = undefined
  sidecar = undefined
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gateway mixed-host: REAL TS + REAL Python sidecar', () => {
  it('routes each op to its owning runtime; both return ground truth (dod.12)', async () => {
    sidecar = createPythonSidecar('python')
    const tsAdapter = createInProcessHostAdapter('ts', tsRuntime)

    gateway = createGateway({ adapters: [tsAdapter, sidecar.adapter] })
    await gateway.start()

    // Both hosts must be ready behind the single surface.
    const health = await gateway.health()
    expect(health.hosts['ts'].status).toBe('ready')
    expect(health.hosts['python'].status).toBe('ready')
    expect(health.serving).toBe(true)

    // host:ts op → answered by the TS runtime (ground truth: n*2 with host tag).
    const tsResult = (await gateway.route(req(op('ts', 'ts/double'), { n: 21 }))) as {
      host: string
      value: number
    }
    expect(tsResult).toEqual({ host: 'ts', value: 42 })

    // host:python op → answered by the REAL Python runtime (echo plugin).
    const pyResult = (await gateway.route(
      req(op('python', 'echo/echo'), { message: 'cross-host' }),
    )) as { host: string; message: string; echo: boolean }
    expect(pyResult).toEqual({ message: 'cross-host', host: 'python', echo: true })

    // Teeth: the two results came from DIFFERENT runtimes (host tags differ),
    // proving each op was answered by its OWNER, not a single runtime.
    expect(tsResult.host).toBe('ts')
    expect(pyResult.host).toBe('python')
  })

  it('killing the Python sidecar fails ONLY its ops; TS keeps serving (dod.17)', async () => {
    sidecar = createPythonSidecar('python')
    const tsAdapter = createInProcessHostAdapter('ts', tsRuntime)

    // No restart — a killed sidecar stays down so we can observe partial
    // availability deterministically (maxRestarts:1 with a long backoff would
    // race; we park it down by giving up immediately).
    gateway = createGateway({
      adapters: [tsAdapter, sidecar.adapter],
      backoff: { delayMs: () => 60_000, maxRestarts: 1 },
    })
    await gateway.start()

    // Baseline: both hosts serve.
    const pyBefore = (await gateway.route(
      req(op('python', 'echo/echo'), { message: 'alive' }),
    )) as { host: string }
    expect(pyBefore.host).toBe('python')
    const tsBefore = (await gateway.route(req(op('ts', 'ts/double'), { n: 5 }))) as { value: number }
    expect(tsBefore.value).toBe(10)

    // Kill the Python sidecar and await its exit so the gateway observes it down.
    await sidecar.kill()
    // Let the gateway's supervision mark it down (its onExit fired synchronously
    // on process exit; the first failed restart parks it down). We drive this
    // deterministically by re-probing health until python is no longer ready,
    // bounded.
    const deadline = Date.now() + 5000
    let pyDown = false
    while (Date.now() < deadline) {
      const h = await gateway.health()
      if (h.hosts['python'].status !== 'ready') {
        pyDown = true
        break
      }
      await new Promise<void>((r) => setTimeout(r, 25))
    }
    expect(pyDown).toBe(true)

    // Python ops now fail with `unavailable` (partial availability).
    let pyErr: unknown
    try {
      await gateway.route(req(op('python', 'echo/echo'), { message: 'gone' }))
    } catch (e) {
      pyErr = e
    }
    expect(pyErr).toBeDefined()
    expect(isGatewayError(pyErr)).toBe(true)

    // Negative control: the healthy TS host is UNAFFECTED — it keeps serving its
    // ground truth. A whole-surface failure would make this throw too → red.
    const tsAfter = (await gateway.route(req(op('ts', 'ts/double'), { n: 9 }))) as { value: number }
    expect(tsAfter.value).toBe(18)
  })
})
