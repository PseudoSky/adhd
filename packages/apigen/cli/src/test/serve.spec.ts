import { describe, it, expect, afterEach } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fs from 'node:fs'
import {
  parseMounts,
  namespaceOfSource,
  namespaceFromUrl,
  resolveHosts,
  aggregateHealth,
  findFreePort,
  startServe,
  type Host,
} from '../lib/commands/serve'

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers — fast, deterministic, no spawning.
// ───────────────────────────────────────────────────────────────────────────

describe('[serve.parseMounts] --mount <ns>=<plugin> parsing', () => {
  it('parses ns=plugin pairs into a record', () => {
    expect(parseMounts(['a=api-fastify', 'b=py-flask'])).toEqual({
      a: 'api-fastify',
      b: 'py-flask',
    })
  })

  it('throws on a pair missing the = separator', () => {
    expect(() => parseMounts(['bad'])).toThrowError(/<namespace>=<plugin>/)
  })

  it('throws on an empty namespace or plugin side', () => {
    expect(() => parseMounts(['=plugin'])).toThrow()
    expect(() => parseMounts(['ns='])).toThrow()
  })
})

describe('[serve.namespaceOfSource] filename stem becomes the namespace', () => {
  it('strips directory and extension', () => {
    expect(namespaceOfSource('/x/y/users.ts')).toBe('users')
    expect(namespaceOfSource('billing.py')).toBe('billing')
    expect(namespaceOfSource('/a/b/api.mts')).toBe('api')
  })
})

describe('[serve.namespaceFromUrl] leading path segment routing', () => {
  it('extracts the namespace from the URL path', () => {
    expect(namespaceFromUrl('/users/getUser')).toBe('users')
    expect(namespaceFromUrl('/users/getUser?x=1')).toBe('users')
    expect(namespaceFromUrl('/_meta/health')).toBe('_meta')
    expect(namespaceFromUrl('/b/add_decimal')).toBe('b')
    expect(namespaceFromUrl('/')).toBe('')
  })
})

describe('[serve.resolveHosts] partition by language → plugin', () => {
  it('routes .ts → api-fastify and .py → py-flask by default', () => {
    const hosts = resolveHosts(['/x/a.ts', '/x/b.py'], {})
    expect(hosts.map((h) => [h.namespace, h.language, h.plugin, h.transport])).toEqual([
      ['a', 'ts', 'api-fastify', 'http'],
      ['b', 'py', 'py-flask', 'http'],
    ])
  })

  it('honours a --mount override for a namespace', () => {
    const hosts = resolveHosts(['/x/a.ts'], { a: 'api-express' })
    expect(hosts[0]?.plugin).toBe('api-express')
    expect(hosts[0]?.transport).toBe('http')
  })

  it('sets transport=grpc for py-grpc plugin', () => {
    const hosts = resolveHosts(['/x/b.py'], { b: 'py-grpc' })
    expect(hosts[0]?.plugin).toBe('py-grpc')
    expect(hosts[0]?.transport).toBe('grpc')
  })

  it('throws on an unrecognised extension', () => {
    expect(() => resolveHosts(['/x/readme.md'], {})).toThrowError(
      /unrecognised extension/,
    )
  })

  it('throws on duplicate namespaces (prefix collision)', () => {
    expect(() => resolveHosts(['/x/api.ts', '/y/api.py'], {})).toThrowError(
      /duplicate namespace/,
    )
  })
})

describe('[serve.aggregateHealth] merged per-host status (§13.1)', () => {
  const mk = (ns: string, alive: boolean, ready: boolean): Host => ({
    namespace: ns,
    language: 'ts',
    plugin: 'api-fastify',
    source: `/x/${ns}.ts`,
    port: 0,
    transport: 'http',
    alive,
    ready,
  })

  it('reports ok when every host is ready', () => {
    expect(aggregateHealth([mk('a', true, true), mk('b', true, true)])).toEqual({
      status: 'ok',
      hosts: { a: 'ready', b: 'ready' },
    })
  })

  it('reports degraded with the dead host down, others still ready (partial availability)', () => {
    expect(aggregateHealth([mk('a', true, true), mk('b', false, false)])).toEqual({
      status: 'degraded',
      hosts: { a: 'ready', b: 'down' },
    })
  })

  it('a host that is alive but not yet ready is down', () => {
    expect(aggregateHealth([mk('a', true, false)])).toEqual({
      status: 'degraded',
      hosts: { a: 'down' },
    })
  })
})

describe('[serve.findFreePort] allocates distinct usable loopback ports', () => {
  it('returns a positive port number', async () => {
    const p = await findFreePort()
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(65536)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// LIVE behavioural suite — drives the REAL serve stack: spawns real
// `apigen run` children (TS fastify + Python flask), proxies cross-language
// calls through the front, proves partial availability by killing the Python
// child, and proves orphan-free teardown.
//
// RUNS BY DEFAULT (no env flag): the serve front is the headline feature; a
// gated suite would let the real cross-language path rot unseen (the exact
// blind spot that hid BUG-009..013). The CLI bundle is guaranteed present via
// the `test` target's `dependsOn:["build"]`; `python3` is a hard prerequisite
// and a missing interpreter FAILS loudly rather than skipping. Only `grpcurl`
// (an optional external binary) degrades gracefully — its gRPC assertions
// self-skip with a warning when it is absent, never hiding a TS/Python failure.
//
// Determinism: every wait is a bounded poll of a real HTTP round-trip or a
// real process exit event — never a fixed sleep that races the system.
// ───────────────────────────────────────────────────────────────────────────

describe('[serve.live] real cross-language serve front', () => {
  let tmpDir: string | undefined
  let shutdownFn: (() => Promise<void>) | undefined

  afterEach(async () => {
    // Always tear the stack down so a failing assertion never leaks children.
    if (shutdownFn) {
      await shutdownFn()
      shutdownFn = undefined
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      tmpDir = undefined
    }
  })

  /**
   * The bundled standalone CLI — children are spawned as `node <bundle> run …`.
   * Walk up from this test file until a `dist/packages/apigen/cli/index.js`
   * exists, so the path is robust to how vitest sets `__dirname`/`--root`.
   */
  const cliPath = (() => {
    let dir = __dirname
    for (let i = 0; i < 12; i++) {
      const candidate = path.join(dir, 'dist/packages/apigen/cli/index.js')
      if (fs.existsSync(candidate)) return candidate
      dir = path.dirname(dir)
    }
    return path.resolve(__dirname, '../../../../../dist/packages/apigen/cli/index.js')
  })()

  /** Bounded poll of an HTTP endpoint until `predicate(status)` holds. */
  async function pollUntil(
    fn: () => Promise<Response>,
    predicate: (status: number) => boolean,
    timeoutMs = 10000,
  ): Promise<Response> {
    const deadline = Date.now() + timeoutMs
    let last: Response | undefined
    while (Date.now() < deadline) {
      try {
        last = await fn()
        if (predicate(last.status)) return last
      } catch {
        /* connection refused while child restarts — keep polling */
      }
      await new Promise<void>((r) => setTimeout(r, 100))
    }
    throw new Error(`pollUntil exceeded ${timeoutMs}ms (last status ${last?.status})`)
  }

  it(
    'proxies TS + Python calls, isolates a dead host to 503, and leaves zero orphans',
    { timeout: 60000 },
    async () => {
      // The built CLI bundle must exist (run `nx build apigen-cli` first).
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath}`).toBe(true)

      // --- fixtures: one TS source, one Python Decimal source ---
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-serve-'))
      const aTs = path.join(tmpDir, 'a.ts')
      const bPy = path.join(tmpDir, 'b.py')
      fs.writeFileSync(
        aTs,
        `export async function addNumbers(a: number, b: number): Promise<number> { return a + b }\n` +
        `export async function greet(name: string): Promise<string> { return \`hello, \${name}\` }\n`,
      )
      fs.writeFileSync(
        bPy,
        `from decimal import Decimal\n\n` +
        `def add_decimal(amount: Decimal) -> Decimal:\n` +
        `    return amount + Decimal("0.001")\n`,
      )

      const port = await findFreePort()
      const { hosts, shutdown } = await startServe({
        sources: [aTs, bPy],
        port,
        cliPath,
        log: () => undefined,
      })
      shutdownFn = shutdown
      const base = `http://127.0.0.1:${port}`

      // --- both hosts ready ---
      const health0 = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string
        hosts: Record<string, string>
      }
      expect(health0).toEqual({ status: 'ok', hosts: { a: 'ready', b: 'ready' } })

      // --- TS call through the front (in-process TS host) ---
      const tsRes = await fetch(`${base}/a/addNumbers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { a: 2, b: 40 } }),
      })
      expect(tsRes.status).toBe(200)
      expect(await tsRes.json()).toBe(42)

      // --- Python Decimal call through the proxy: exact decimal string ---
      const pyRes = await fetch(`${base}/b/add_decimal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { amount: '123.456' } }),
      })
      expect(pyRes.status).toBe(200)
      expect(await pyRes.json()).toBe('123.457')

      // --- partial availability: kill the Python child, /b/* → 503, /a/* → 200 ---
      const pyHost = hosts.find((h) => h.namespace === 'b')
      expect(pyHost?.child?.pid).toBeDefined()
      pyHost?.child?.kill('SIGKILL')

      // Bounded wait until the front observes the death (exit event flips alive).
      const downRes = await pollUntil(
        () =>
          fetch(`${base}/b/add_decimal`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: { amount: '1.0' } }),
          }),
        (s) => s === 503,
      )
      expect(downRes.status).toBe(503)
      const downBody = (await downRes.json()) as {
        details?: { gatewayCode?: string; host?: string }
      }
      expect(downBody.details?.gatewayCode).toBe('unavailable')
      expect(downBody.details?.host).toBe('b')

      // The TS host keeps serving — a dead host fails ONLY its own ops.
      const stillUp = await fetch(`${base}/a/addNumbers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { a: 1, b: 1 } }),
      })
      expect(stillUp.status).toBe(200)
      expect(await stillUp.json()).toBe(2)

      // Aggregate health now degraded with b down, a still ready.
      const health1 = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string
        hosts: Record<string, string>
      }
      expect(health1).toEqual({ status: 'degraded', hosts: { a: 'ready', b: 'down' } })

      // --- orphan-free teardown: shutdown kills the remaining TS child ---
      const tsHost = hosts.find((h) => h.namespace === 'a')
      const tsPid = tsHost?.child?.pid
      expect(tsPid).toBeDefined()

      await shutdown()
      shutdownFn = undefined

      // Prove the surviving child actually exited (no orphan).  A live process
      // answers `kill(pid, 0)`; a reaped one throws ESRCH.  Bounded poll.
      const exited = await (async () => {
        const deadline = Date.now() + 5000
        while (Date.now() < deadline) {
          try {
            process.kill(tsPid as number, 0)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true
          }
          await new Promise<void>((r) => setTimeout(r, 100))
        }
        return false
      })()
      expect(exited, `TS child pid ${tsPid} should be gone after shutdown`).toBe(true)
      expect(tsHost?.alive).toBe(false)
    },
  )

  it(
    'mounts a gRPC host (py-grpc) on the same front port as HTTP hosts',
    { timeout: 60000 },
    async () => {
      // The built CLI bundle must exist (run `nx build apigen-cli` first).
      expect(fs.existsSync(cliPath), `built CLI not found at ${cliPath}`).toBe(true)

      // Locate grpcurl — required for this test.
      const grpcurlPath = (() => {
        const candidates = ['/opt/homebrew/bin/grpcurl', '/usr/local/bin/grpcurl', '/usr/bin/grpcurl']
        for (const c of candidates) { if (fs.existsSync(c)) return c }
        return null
      })()
      if (!grpcurlPath) {
        console.warn('[serve.grpc.live] grpcurl not found — skipping gRPC assertions')
      }

      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigen-grpc-serve-'))
      const aTs = path.join(tmpDir, 'a.ts')
      const bPy = path.join(tmpDir, 'b.py')
      fs.writeFileSync(
        aTs,
        `export async function addNumbers(a: number, b: number): Promise<number> { return a + b }\n`,
      )
      fs.writeFileSync(
        bPy,
        `from decimal import Decimal\n\n` +
        `def add_decimal(amount: Decimal) -> Decimal:\n` +
        `    return amount + Decimal("0.001")\n\n` +
        `def greet(name: str) -> str:\n` +
        `    return f"Hello, {name}!"\n`,
      )

      const port = await findFreePort()
      const { hosts, shutdown } = await startServe({
        sources: [aTs, bPy],
        port,
        mounts: { b: 'py-grpc' },
        cliPath,
        log: () => undefined,
      })
      shutdownFn = shutdown
      const base = `http://127.0.0.1:${port}`

      // Verify transport tags.
      const tsHost = hosts.find((h) => h.namespace === 'a')
      const grpcHost = hosts.find((h) => h.namespace === 'b')
      expect(tsHost?.transport).toBe('http')
      expect(grpcHost?.transport).toBe('grpc')

      // --- aggregate health: both hosts ready ---
      const health0 = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string
        hosts: Record<string, string>
      }
      expect(health0).toEqual({ status: 'ok', hosts: { a: 'ready', b: 'ready' } })

      // --- TS host serves HTTP on the same port ---
      const tsRes = await fetch(`${base}/a/addNumbers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { a: 2, b: 40 } }),
      })
      expect(tsRes.status).toBe(200)
      expect(await tsRes.json()).toBe(42)

      // --- gRPC host: call via grpcurl routed through the front port ---
      if (grpcurlPath) {
        const { spawn } = await import('node:child_process')

        /**
         * Run grpcurl asynchronously so the Node.js event loop remains free
         * to process the in-process h2 server's requests.
         * `spawnSync` would block the event loop, preventing the proxy from
         * forwarding packets while grpcurl waits — causing a 10 s timeout.
         */
        const runGrpcurl = (args: string[], timeoutMs = 10000): Promise<{
          status: number | null
          stdout: string
          stderr: string
        }> => new Promise((resolve) => {
          let stdout = ''
          let stderr = ''
          const child = spawn(grpcurlPath!, args, { encoding: 'utf8' } as never)
          child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
          child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
          const timer = setTimeout(() => {
            child.kill()
            resolve({ status: null, stdout, stderr })
          }, timeoutMs)
          child.once('exit', (code) => {
            clearTimeout(timer)
            resolve({ status: code, stdout, stderr })
          })
        })

        // gRPC call through the front (HTTP/2 h2c, detected by PRI preface)
        const grpcResult = await runGrpcurl([
          '-plaintext',
          '-d', JSON.stringify({ data: { amount: '123.456' } }),
          `127.0.0.1:${port}`,
          'b.BService/add_decimal',
        ])
        // grpc-status 0 = OK
        expect(grpcResult.status, `grpcurl exit; stderr=${grpcResult.stderr?.slice(0, 300)}`).toBe(0)
        const grpcBody = JSON.parse(grpcResult.stdout) as { data: string }
        const grpcResult2 = JSON.parse(grpcBody.data) as string
        expect(grpcResult2, 'Decimal round-trip through gRPC front').toBe('123.457')

        // --- gRPC plain string call ---
        const greetResult = await runGrpcurl([
          '-plaintext',
          '-d', JSON.stringify({ data: { name: 'FrontProxy' } }),
          `127.0.0.1:${port}`,
          'b.BService/greet',
        ])
        expect(greetResult.status, `grpcurl greet exit; stderr=${greetResult.stderr?.slice(0,200)}`).toBe(0)
        const greetBody = JSON.parse(greetResult.stdout) as { data: string }
        expect(JSON.parse(greetBody.data)).toBe('Hello, FrontProxy!')

        // --- kill gRPC host → gRPC calls return UNAVAILABLE (status 14), TS still works ---
        expect(grpcHost?.child?.pid).toBeDefined()
        grpcHost?.child?.kill('SIGKILL')

        // Bounded wait until alive flips false.
        const grpcDown = await (async () => {
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            if (grpcHost && !grpcHost.alive) return true
            await new Promise<void>((r) => setTimeout(r, 100))
          }
          return false
        })()
        expect(grpcDown, 'gRPC host should be dead').toBe(true)

        // gRPC call to dead host → UNAVAILABLE (grpcurl exits non-zero).
        const deadResult = await runGrpcurl([
          '-plaintext',
          '-d', JSON.stringify({ data: { amount: '1.0' } }),
          `127.0.0.1:${port}`,
          'b.BService/add_decimal',
        ], 5000)
        // Exit non-zero because the server returned a gRPC error status.
        expect(
          deadResult.status !== 0 || deadResult.stderr.includes('Unavailable') ||
          deadResult.stderr.includes('unavailable') || deadResult.stderr.includes('UNAVAILABLE'),
          `Expected gRPC error after host death; stderr=${deadResult.stderr?.slice(0,300)} exit=${deadResult.status}`,
        ).toBe(true)
      }

      // TS still serves even after gRPC child death.
      const stillUp = await fetch(`${base}/a/addNumbers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: { a: 1, b: 1 } }),
      })
      expect(stillUp.status).toBe(200)
      expect(await stillUp.json()).toBe(2)

      // Aggregate health degraded: b down, a still ready.
      const healthDeg = (await (await fetch(`${base}/_meta/health`)).json()) as {
        status: string
        hosts: Record<string, string>
      }
      expect(healthDeg.status).toBe('degraded')
      expect(healthDeg.hosts['a']).toBe('ready')
      expect(healthDeg.hosts['b']).toBe('down')

      await shutdown()
      shutdownFn = undefined
    },
  )
})
