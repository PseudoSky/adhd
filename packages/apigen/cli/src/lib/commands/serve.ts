/**
 * `apigen serve` — one HTTP front mounting many sources across many languages.
 *
 * ```
 * apigen serve --source a.ts --source b.py --port 8080 [--mount <ns>=<plugin>] …
 * ```
 *
 * Design (a small distributed system, SPEC §13 / §13.1):
 *
 *   1. **Partition by language → plugin.** Each `--source` is routed by its
 *      extension via {@link languageOfSource}: `.ts → api-fastify`, `.py →
 *      py-flask`.  A `--mount <ns>=<plugin>` override pins a namespace to an
 *      explicit plugin.  Each source's namespace defaults to its filename stem.
 *
 *   2. **Spawn + supervise, in-memory.** Every source is started as a child
 *      `apigen run --type <plugin> --source <file> --namespace <ns> --opt
 *      port=<free>` subprocess on a free loopback port.  The TS host is given
 *      `--use health` so it also mounts `GET /_meta/health`; the Python host
 *      serves that route natively.  Readiness is proven by a **bounded poll of
 *      the child's `GET /_meta/health`** — no fixed sleeps.  Every child PID is
 *      tracked for teardown.
 *
 *   3. **Front = a prefix reverse-proxy** on `--port`.  Each child already
 *      serves under its namespace (`/<ns>/<fn>`), so the front forwards
 *      `/<ns>/*` to the owning child verbatim (method, headers incl.
 *      `content-type` + `x-adhd-*`, body) and streams the response back.
 *
 *   4. **Merged health + partial availability.** `GET /_meta/health` aggregates
 *      every child's `ready`/`down` status.  If a child dies, **only its
 *      `/<ns>/*` routes return 503 `unavailable`** (§13.1) — every other host
 *      keeps serving.  On `SIGINT`/`SIGTERM` (or front shutdown) all children
 *      are killed and the process exits clean: zero orphans.
 *
 * @module commands/serve
 */

import { Command } from 'commander'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { languageOfSource, type PluginLanguage } from '@adhd/apigen-core'

// ---------------------------------------------------------------------------
// Language → default plugin
// ---------------------------------------------------------------------------

/**
 * Default plugin id per host language.  A `--mount <ns>=<plugin>` override
 * takes precedence over this table.
 */
const DEFAULT_PLUGIN_FOR_LANGUAGE: Partial<Record<PluginLanguage, string>> = {
  ts: 'api-fastify',
  py: 'py-flask',
}

// ---------------------------------------------------------------------------
// Host model
// ---------------------------------------------------------------------------

/** A single mounted source: its namespace, language, plugin, file, and runtime. */
export interface Host {
  /** Namespace prefix this host serves under (`/<ns>/*`). */
  namespace: string
  /** The host language (`ts` | `py` | …). */
  language: PluginLanguage
  /** The plugin id driving the child (`api-fastify`, `py-flask`, …). */
  plugin: string
  /** Absolute path to the source file. */
  source: string
  /** Internal loopback port the child listens on. */
  port: number
  /** The child process (set once spawned). */
  child?: ChildProcess
  /** Liveness flag flipped to `false` when the child exits. */
  alive: boolean
  /** Readiness flag flipped to `true` once `_meta/health` answered ok. */
  ready: boolean
}

/** Per-host status in the aggregate `_meta/health` (§13.1). */
export type HostHealthStatus = 'ready' | 'down'

// ---------------------------------------------------------------------------
// Parsing helpers (pure — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Parse `--mount <ns>=<plugin>` pairs into a `{ ns → plugin }` record.
 *
 * @throws if a pair is missing the `=` separator or has an empty side.
 */
export function parseMounts(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const pair of pairs) {
    const i = pair.indexOf('=')
    if (i <= 0 || i === pair.length - 1) {
      throw new Error(
        `--mount expects <namespace>=<plugin> (got "${pair}")`,
      )
    }
    out[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return out
}

/** Derive a source's default namespace: its filename stem. */
export function namespaceOfSource(file: string): string {
  return path.basename(file, path.extname(file))
}

/**
 * Resolve the {@link Host} descriptors (sans runtime fields) for the given
 * `--source` list, applying any `--mount` overrides.
 *
 * Resolution per source:
 *   1. `language = languageOfSource(file)` — unknown extension → error.
 *   2. `namespace = stem(file)`.
 *   3. `plugin = mounts[namespace] ?? DEFAULT_PLUGIN_FOR_LANGUAGE[language]`.
 *
 * @throws on an unknown extension, an unmappable language, or a duplicate
 *         namespace (two sources would collide on the same `/<ns>/*` prefix).
 */
export function resolveHosts(
  sources: string[],
  mounts: Record<string, string>,
): Host[] {
  const hosts: Host[] = []
  const seen = new Set<string>()
  for (const src of sources) {
    const source = path.resolve(src)
    const language = languageOfSource(source)
    if (language === undefined) {
      throw new Error(
        `--source ${src}: unrecognised extension; expected one of ` +
        `.ts/.tsx/.mts/.cts (TypeScript) or .py (Python)`,
      )
    }
    const namespace = namespaceOfSource(source)
    if (seen.has(namespace)) {
      throw new Error(
        `duplicate namespace "${namespace}" — two sources resolve to the same ` +
        `/${namespace}/* prefix; rename one file or use --mount to disambiguate`,
      )
    }
    seen.add(namespace)
    const plugin =
      mounts[namespace] ?? DEFAULT_PLUGIN_FOR_LANGUAGE[language]
    if (!plugin) {
      throw new Error(
        `no default plugin for language "${language}" (source ${src}); ` +
        `pin one with --mount ${namespace}=<plugin>`,
      )
    }
    hosts.push({
      namespace,
      language,
      plugin,
      source,
      port: 0,
      alive: false,
      ready: false,
    })
  }
  return hosts
}

/**
 * Extract the leading path segment of a request URL (the namespace).
 *
 * `/users/getUser?x=1` → `users`; `/_meta/health` → `_meta`; `/` → `''`.
 */
export function namespaceFromUrl(url: string): string {
  const pathOnly = url.split('?')[0] ?? ''
  const trimmed = pathOnly.startsWith('/') ? pathOnly.slice(1) : pathOnly
  const slash = trimmed.indexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(0, slash)
}

// ---------------------------------------------------------------------------
// Free-port allocation
// ---------------------------------------------------------------------------

/**
 * Ask the OS for a free loopback TCP port by binding port 0 and reading back
 * the assigned port, then releasing it.  There is an unavoidable TOCTOU window
 * between release and the child binding it; in practice the child binds within
 * milliseconds and the kernel does not immediately re-hand the same ephemeral
 * port, so collisions are vanishingly rare.  Each host gets its own port.
 */
export function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('could not determine a free port')))
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Readiness probe (bounded poll of the child's _meta/health — no fixed sleeps)
// ---------------------------------------------------------------------------

/** Probe `GET http://127.0.0.1:<port>/_meta/health` once; resolve true on 2xx. */
function probeHealthOnce(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/_meta/health', timeout: 1000 },
      (res) => {
        const ok = (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300
        res.resume() // drain
        resolve(ok)
      },
    )
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Poll a host's `_meta/health` until it answers 2xx or the deadline passes.
 *
 * Event-driven: it re-probes on a short interval, but each probe is a real HTTP
 * round-trip to the child — readiness is the child *actually answering*, never
 * a wall-clock sleep.  Aborts early (rejects) if the child exits first.
 *
 * @param host       - The host to probe.
 * @param timeoutMs  - Overall budget (default 15 s — Python cold-start + import).
 * @param intervalMs - Delay between probes (default 100 ms).
 */
export async function waitForReady(
  host: Host,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!host.alive) {
      throw new Error(
        `host "${host.namespace}" (${host.plugin}) exited before becoming ready`,
      )
    }
    if (await probeHealthOnce(host.port)) {
      host.ready = true
      return
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `host "${host.namespace}" (${host.plugin}) did not become ready within ` +
    `${timeoutMs}ms (port ${host.port})`,
  )
}

// ---------------------------------------------------------------------------
// Child supervision
// ---------------------------------------------------------------------------

/**
 * The path used to re-invoke this CLI for a child `run`.  When the CLI is the
 * bundled standalone (`dist/.../index.js`), `process.argv[1]` is that bundle;
 * spawning `node <bundle> run …` reuses the same inlined plugin graph.  Tests
 * override this to point at a stub.
 */
export function selfCliPath(): string {
  return process.argv[1] ?? ''
}

/**
 * Spawn one child `apigen run` for a host and wire its lifecycle.
 *
 * The child is started detached-free (same process group) so the front's
 * teardown can signal it directly.  `alive` flips to `false` on exit; if a
 * child dies, its `/<ns>/*` routes start returning 503 (partial availability).
 *
 * @param host       - The host to start (mutated: `child`, `alive`).
 * @param cliPath    - Path to the apigen CLI entry to spawn (see {@link selfCliPath}).
 * @param onExit     - Callback invoked when the child exits (for logging).
 * @param extraArgs  - Extra args appended to the child `run` invocation (tests).
 */
export function spawnHost(
  host: Host,
  cliPath: string,
  onExit?: (host: Host, code: number | null, signal: NodeJS.Signals | null) => void,
  extraArgs: string[] = [],
): ChildProcess {
  const args = [
    cliPath,
    'run',
    '--type', host.plugin,
    '--source', host.source,
    '--namespace', host.namespace,
    '--opt', `port=${host.port}`,
    '--opt', 'host=127.0.0.1',
  ]
  // The TS fastify/express host mounts `_meta/health` only when `--use health`
  // is active; the Python host serves it natively, so only add it for TS.
  if (host.language === 'ts') {
    args.push('--use', 'health')
  }
  args.push(...extraArgs)

  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  })
  host.child = child
  host.alive = true
  child.on('exit', (code, signal) => {
    host.alive = false
    host.ready = false
    onExit?.(host, code, signal)
  })
  return child
}

/**
 * Kill every child process and resolve once all have exited (or the deadline
 * passes, after which a hard `SIGKILL` is sent).  Idempotent.
 *
 * @param hosts      - The hosts whose children to terminate.
 * @param graceMs    - Grace period before escalating SIGTERM → SIGKILL.
 */
export async function killAll(hosts: Host[], graceMs = 3000): Promise<void> {
  const live = hosts.filter((h) => h.child && h.alive)
  if (live.length === 0) return

  const exits = live.map(
    (h) =>
      new Promise<void>((resolve) => {
        if (!h.child || h.child.exitCode !== null || !h.alive) return resolve()
        h.child.once('exit', () => resolve())
      }),
  )

  for (const h of live) h.child?.kill('SIGTERM')

  const escalation = setTimeout(() => {
    for (const h of live) {
      if (h.alive) h.child?.kill('SIGKILL')
    }
  }, graceMs)
  escalation.unref?.()

  await Promise.all(exits)
  clearTimeout(escalation)
}

// ---------------------------------------------------------------------------
// Reverse proxy front
// ---------------------------------------------------------------------------

/** Headers that must not be forwarded verbatim (hop-by-hop, RFC 7230 §6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
])

/** JSON 503 body for a down/unknown host (§13.1 `unavailable`). */
function unavailableBody(host: string, reason: string): string {
  return JSON.stringify({
    code: 'internal',
    message: `host '${host}' unavailable: ${reason}`,
    details: { gatewayCode: 'unavailable', host, httpStatus: 503 },
  })
}

/**
 * Build the aggregate `_meta/health` payload (§13.1).
 *
 * ```json
 * { "status": "ok"|"degraded", "hosts": { "<ns>": "ready"|"down", … } }
 * ```
 *
 * `status` is `ok` only when every host is ready; any down host → `degraded`
 * (the front itself is still up — partial availability, never whole-surface
 * down).
 */
export function aggregateHealth(hosts: Host[]): {
  status: 'ok' | 'degraded'
  hosts: Record<string, HostHealthStatus>
} {
  const out: Record<string, HostHealthStatus> = {}
  let allReady = true
  for (const h of hosts) {
    const status: HostHealthStatus = h.alive && h.ready ? 'ready' : 'down'
    out[h.namespace] = status
    if (status !== 'ready') allReady = false
  }
  return { status: allReady ? 'ok' : 'degraded', hosts: out }
}

/**
 * Create the front HTTP server: a prefix reverse-proxy plus the aggregate
 * `_meta/health` endpoint.  The returned server is NOT yet listening.
 *
 * @param hosts - The resolved, spawned hosts (with live ports).
 */
export function createFrontServer(hosts: Host[]): http.Server {
  const byNamespace = new Map<string, Host>()
  for (const h of hosts) byNamespace.set(h.namespace, h)

  return http.createServer((req, res) => {
    const url = req.url ?? '/'
    const ns = namespaceFromUrl(url)

    // Front-owned aggregate health.
    if (ns === '_meta') {
      const pathOnly = url.split('?')[0]
      if (pathOnly === '/_meta/health') {
        const body = JSON.stringify(aggregateHealth(hosts))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(body)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'not_found', message: `unknown meta route ${pathOnly}` }))
      return
    }

    const host = byNamespace.get(ns)
    if (!host) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'not_found', message: `no host mounted at /${ns}` }))
      return
    }

    // Partial availability (§13.1): a down host fails ONLY its own ops with 503.
    if (!host.alive) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(unavailableBody(ns, 'child process is not running'))
      return
    }

    // Forward verbatim to the owning child (method, headers, body) and stream
    // the response back.  Strip hop-by-hop headers per RFC 7230.
    const headers: http.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v
    }

    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port: host.port,
        method: req.method,
        path: url,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
        proxyRes.pipe(res)
      },
    )

    proxyReq.on('error', () => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      // The child died mid-flight (or refused the connection): 503 for this
      // host only — the rest of the front stays up.
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(unavailableBody(ns, 'child connection failed'))
    })

    req.pipe(proxyReq)
  })
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/**
 * Start the full serve stack: spawn every host, await readiness, then start the
 * front.  Resolves to a teardown function and the listening front server.
 *
 * Exported (not just inlined in the action) so the behavioural test can drive
 * the real stack in-process with bounded waits.
 *
 * @param opts.sources - The `--source` files.
 * @param opts.port    - The front port.
 * @param opts.mounts  - `{ ns → plugin }` overrides.
 * @param opts.cliPath - The CLI entry to spawn children with (defaults to self).
 * @param opts.log     - Optional logger sink (defaults to console.error).
 */
export async function startServe(opts: {
  sources: string[]
  port: number
  mounts?: Record<string, string>
  cliPath?: string
  log?: (msg: string) => void
}): Promise<{
  hosts: Host[]
  front: http.Server
  shutdown: () => Promise<void>
}> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`))
  const cliPath = opts.cliPath ?? selfCliPath()
  const hosts = resolveHosts(opts.sources, opts.mounts ?? {})

  // Assign a free port to each host, then spawn.
  for (const h of hosts) {
    h.port = await findFreePort()
    spawnHost(h, cliPath, (host, code, signal) => {
      log(
        `[serve] host "${host.namespace}" (${host.plugin}) exited ` +
        `code=${code} signal=${signal} — /${host.namespace}/* now 503`,
      )
    })
    log(`[serve] spawned "${h.namespace}" (${h.plugin}) → :${h.port}  [${h.source}]`)
  }

  // Await readiness for every host in parallel (bounded poll of _meta/health).
  await Promise.all(
    hosts.map((h) =>
      waitForReady(h).then(() =>
        log(`[serve] host "${h.namespace}" ready on :${h.port}`),
      ),
    ),
  )

  const front = createFrontServer(hosts)
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(opts.port, '127.0.0.1', resolve)
  })
  log(`[serve] front listening on http://127.0.0.1:${opts.port}`)
  for (const h of hosts) log(`[serve]   /${h.namespace}/* → :${h.port} (${h.plugin})`)

  let torn = false
  const shutdown = async (): Promise<void> => {
    if (torn) return
    torn = true
    log('[serve] shutting down — killing children…')
    await new Promise<void>((resolve) => front.close(() => resolve()))
    await killAll(hosts)
    log('[serve] all children terminated')
  }

  return { hosts, front, shutdown }
}

/** Register the `serve` command on the program. */
export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Mount many sources/languages behind one HTTP front')
    .requiredOption(
      '--source <path>',
      'Source file to mount (repeatable; .ts → api-fastify, .py → py-flask)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .requiredOption('--port <port>', 'Front HTTP port', (v) => Number.parseInt(v, 10))
    .option(
      '--mount <ns=plugin>',
      'Pin a namespace to an explicit plugin (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .action(async (opts: { source: string[]; port: number; mount: string[] }) => {
      const mounts = parseMounts(opts.mount)
      const { shutdown } = await startServe({
        sources: opts.source,
        port: opts.port,
        mounts,
      })

      let shuttingDown = false
      const onSignal = (sig: NodeJS.Signals) => {
        if (shuttingDown) return
        shuttingDown = true
        process.stderr.write(`\n[serve] received ${sig}\n`)
        void shutdown().then(() => process.exit(0))
      }
      process.on('SIGINT', () => onSignal('SIGINT'))
      process.on('SIGTERM', () => onSignal('SIGTERM'))
      // Keep the process alive; the front server's open handle does this.
    })
}
