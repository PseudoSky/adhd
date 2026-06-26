/**
 * `apigen serve` — one front mounting many sources across many languages.
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
 *      When `--mount <ns>=py-grpc` is used, the host's `transport` is `'grpc'`.
 *
 *   2. **Spawn + supervise, in-memory.** Every source is started as a child
 *      `apigen run --type <plugin> --source <file> --namespace <ns> --opt
 *      port=<free>` subprocess on a free loopback port.  The TS host is given
 *      `--use health` so it also mounts `GET /_meta/health`; the Python HTTP
 *      host serves that route natively; the gRPC host signals readiness via
 *      `{"ready":true}` on stdout (and is probed by a TCP connect instead of
 *      HTTP health).  Every child PID is tracked for teardown.
 *
 *   3. **Front = a single-port multi-protocol proxy.** HTTP/1.1 traffic
 *      (from TS and Python HTTP hosts) is proxied via `node:http`.  gRPC
 *      traffic (HTTP/2 with `content-type: application/grpc`) is identified
 *      at the TCP level by the HTTP/2 client-magic preface and proxied via
 *      `node:http2` h2c client connections to the gRPC child.  Both protocols
 *      are muxed on the single `--port` using a raw `net.Server` that peeks
 *      the first bytes of each connection.
 *
 *   4. **Merged health + partial availability.** `GET /_meta/health` (served
 *      over HTTP/1.1 on the same port) aggregates every child's `ready`/`down`
 *      status.  If a child dies, **only its `/<ns>/*` routes return errors** —
 *      HTTP hosts return 503 `unavailable`, gRPC hosts return gRPC status 14
 *      (UNAVAILABLE) — every other host keeps serving.
 *
 *   5. **Orphan-free teardown.** On `SIGINT`/`SIGTERM` (or front shutdown)
 *      all children are killed and the process exits clean.
 *
 * @module commands/serve
 */

import { Command } from 'commander'
import * as http from 'node:http'
import * as http2 from 'node:http2'
import * as net from 'node:net'
import * as path from 'node:path'
import * as readline from 'node:readline'
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

/** Plugin ids that use gRPC transport rather than HTTP. */
const GRPC_PLUGINS = new Set(['py-grpc'])

// ---------------------------------------------------------------------------
// Host model
// ---------------------------------------------------------------------------

/** A single mounted source: its namespace, language, plugin, file, and runtime. */
export interface Host {
  /** Namespace prefix this host serves under (`/<ns>/*`). */
  namespace: string
  /** The host language (`ts` | `py` | …). */
  language: PluginLanguage
  /** The plugin id driving the child (`api-fastify`, `py-flask`, `py-grpc`, …). */
  plugin: string
  /** Absolute path to the source file. */
  source: string
  /** Internal loopback port the child listens on. */
  port: number
  /**
   * Transport protocol for this host.
   * - `'http'` — child is an HTTP/1.1 server (api-fastify, py-flask).
   * - `'grpc'` — child is a gRPC (HTTP/2) server (py-grpc).
   */
  transport: 'http' | 'grpc'
  /** The child process (set once spawned). */
  child?: ChildProcess
  /** Liveness flag flipped to `false` when the child exits. */
  alive: boolean
  /** Readiness flag flipped to `true` once the child is accepting connections. */
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
 *   4. `transport = GRPC_PLUGINS.has(plugin) ? 'grpc' : 'http'`.
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
    const transport: 'http' | 'grpc' = GRPC_PLUGINS.has(plugin) ? 'grpc' : 'http'
    hosts.push({
      namespace,
      language,
      plugin,
      source,
      port: 0,
      transport,
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
// Readiness probes
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
 * Probe a gRPC host's port by attempting a TCP connect.
 *
 * A successful TCP connect means the gRPC server is accepting connections —
 * the Python gRPC server binds before emitting `{"ready":true}`, so by the
 * time this is called (after stdout readiness), the port is always open.
 * We probe anyway as an extra guard against the TOCTOU window.
 */
function probeGrpcTcpOnce(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const sock = new net.Socket()
    sock.setTimeout(1000)
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
    sock.once('timeout', () => {
      sock.destroy()
      resolve(false)
    })
    sock.connect(port, '127.0.0.1')
  })
}

/**
 * Poll an HTTP host's `_meta/health` until it answers 2xx or the deadline passes.
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
  if (host.transport === 'grpc') {
    return waitForGrpcReady(host, timeoutMs, intervalMs)
  }
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

/**
 * Wait for a gRPC host's readiness by polling the TCP port until it accepts
 * a connection.
 *
 * Unlike HTTP hosts (which are probed via HTTP GET `/_meta/health`), gRPC
 * hosts speak HTTP/2 on the port — not HTTP/1.1 — so a plain TCP connect is
 * the lightest reliable readiness signal.  The Python gRPC server emits
 * `{"ready":true}` on its stdout as well, but that line is consumed by the
 * inner `apigen run` (py-grpc plugin) process and is not re-emitted to the
 * outer CLI's stdout — so we cannot rely on it here.  Instead we poll TCP.
 *
 * The `host.ready` flag is also flipped to `true` from the stdout listener in
 * `spawnGrpcHost` if the signal somehow reaches us; if not, the TCP probe
 * alone is sufficient.
 *
 * @param host       - The gRPC host (must have `transport === 'grpc'`).
 * @param timeoutMs  - Overall budget.
 * @param intervalMs - Interval between TCP probe attempts.
 */
async function waitForGrpcReady(
  host: Host,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!host.alive) {
      throw new Error(
        `gRPC host "${host.namespace}" (${host.plugin}) exited before becoming ready`,
      )
    }
    // TCP connect to the gRPC port — if it accepts, the server is ready.
    if (await probeGrpcTcpOnce(host.port)) {
      host.ready = true
      return
    }
    await new Promise<void>((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `gRPC host "${host.namespace}" (${host.plugin}) did not become ready within ` +
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
 * Spawn one child `apigen run` for a HTTP host and wire its lifecycle.
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
  if (host.transport === 'grpc') {
    return spawnGrpcHost(host, cliPath, onExit, extraArgs)
  }

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
 * Spawn one child `apigen run` for a gRPC host.
 *
 * Unlike HTTP hosts, gRPC hosts signal readiness via `{"ready":true}` on
 * stdout.  We capture stdout with a readline interface and flip `host.ready`
 * when the signal arrives.
 *
 * @param host       - The gRPC host to start.
 * @param cliPath    - Path to the apigen CLI entry.
 * @param onExit     - Callback on child exit.
 * @param extraArgs  - Extra args appended to the child `run` invocation.
 */
function spawnGrpcHost(
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
    ...extraArgs,
  ]

  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: process.env,
  })
  host.child = child
  host.alive = true

  // Listen for {"ready":true} on stdout to flip host.ready.
  // The py-grpc plugin emits this line once the gRPC server is accepting connections.
  const rl = readline.createInterface({ input: child.stdout! })
  rl.on('line', (line: string) => {
    try {
      const msg = JSON.parse(line.trim()) as Record<string, unknown>
      if (msg['ready'] === true && !host.ready) {
        host.ready = true
        rl.close()
      }
    } catch {
      // Non-JSON lines from the child — ignore.
    }
  })

  child.on('exit', (code, signal) => {
    host.alive = false
    host.ready = false
    rl.close()
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
// gRPC proxy — HTTP/2 h2c client sessions to backend gRPC children
// ---------------------------------------------------------------------------

/**
 * HTTP/2 client sessions keyed by `host:port`.  Sessions are lazily created
 * and reused across requests; a dead session is evicted so the next request
 * creates a fresh one.
 */
const _grpcSessions = new Map<string, http2.ClientHttp2Session>()

/**
 * Return a reusable h2c ClientHttp2Session for `127.0.0.1:port`.
 *
 * Sessions are cached so we don't open a new TCP connection for every gRPC
 * frame.  A closed/destroyed session is evicted and a new one is created.
 */
function getGrpcSession(port: number): http2.ClientHttp2Session {
  const key = `127.0.0.1:${port}`
  let session = _grpcSessions.get(key)
  if (!session || session.closed || session.destroyed) {
    session = http2.connect(`http://127.0.0.1:${port}`)
    session.once('close', () => _grpcSessions.delete(key))
    session.once('error', () => {
      _grpcSessions.delete(key)
      session?.destroy()
    })
    _grpcSessions.set(key, session)
  }
  return session
}

/** Close all cached h2c sessions (used during teardown). */
function destroyAllGrpcSessions(): void {
  for (const session of _grpcSessions.values()) {
    try { session.destroy() } catch { /* ignore */ }
  }
  _grpcSessions.clear()
}

// ---------------------------------------------------------------------------
// HTTP/2 client magic preface (prior-knowledge h2c)
// ---------------------------------------------------------------------------

/**
 * The HTTP/2 client connection preface: every gRPC (h2c) connection begins
 * with exactly these 24 bytes before any frames are sent.
 *
 * RFC 7540 §3.5: `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`
 */
const H2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n')

// ---------------------------------------------------------------------------
// Reverse proxy front — combined HTTP/1.1 + HTTP/2 (gRPC)
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

/** JSON 503 body for a down/unknown HTTP host (§13.1 `unavailable`). */
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
 * Build a gRPC UNAVAILABLE (status 14) response for a dead gRPC host.
 *
 * A minimal gRPC response for a unary call that failed before reaching the
 * upstream:
 *   - HTTP/2 status 200 (gRPC always uses HTTP 200)
 *   - `content-type: application/grpc`
 *   - Empty DATA frame
 *   - Trailing HEADERS with `grpc-status: 14` + `grpc-message`
 *
 * Node.js http2 requires `waitForTrailers: true` in `stream.respond()` so that
 * `stream.sendTrailers()` may be called after the `'wantTrailers'` event fires.
 *
 * @param stream - The server-side http2.ServerHttp2Stream to respond on.
 * @param ns     - The namespace (for the error message).
 * @param reason - Human-readable reason string.
 */
function sendGrpcUnavailable(
  stream: http2.ServerHttp2Stream,
  ns: string,
  reason: string,
): void {
  if (stream.destroyed || stream.closed) return
  try {
    stream.respond(
      { ':status': 200, 'content-type': 'application/grpc' },
      { waitForTrailers: true },
    )
    stream.once('wantTrailers', () => {
      try {
        stream.sendTrailers({
          'grpc-status': '14',
          'grpc-message': `host '${ns}' unavailable: ${reason}`,
        })
      } catch { /* ignore */ }
    })
    stream.end()
  } catch {
    stream.destroy()
  }
}

/**
 * Grpc-relevant trailer header names that may appear in a response HEADERS frame.
 * When a gRPC backend sends trailers in the initial HEADERS frame (with END_STREAM
 * flag set, meaning empty body), these keys must be forwarded as HTTP/2 trailers
 * (not initial headers) to the downstream gRPC client.
 */
const GRPC_TRAILER_KEYS = new Set(['grpc-status', 'grpc-message', 'grpc-encoding'])

/**
 * Proxy a single HTTP/2 stream (a gRPC call) to the backend gRPC child.
 *
 * Protocol notes:
 * - gRPC always uses HTTP/2 status 200; the actual call status is in trailing
 *   headers (`grpc-status`, `grpc-message`).
 * - Node.js requires `waitForTrailers: true` in `stream.respond()` so that
 *   `stream.sendTrailers()` may be called after the `'wantTrailers'` event fires.
 * - When a backend sends trailing metadata in the initial HEADERS frame (i.e. the
 *   response flags include END_STREAM, meaning no body — this happens for error
 *   responses like UNIMPLEMENTED), we extract grpc-* trailer keys and forward them
 *   via `sendTrailers`, not via the initial response headers.
 *
 * @param stream    - The incoming server-side HTTP/2 stream from the client.
 * @param headers   - The request headers from the client.
 * @param backPort  - The loopback port of the gRPC child.
 * @param ns        - Namespace (for error messages).
 */
function proxyGrpcStream(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  backPort: number,
  ns: string,
): void {
  let session: http2.ClientHttp2Session
  try {
    session = getGrpcSession(backPort)
  } catch (err) {
    sendGrpcUnavailable(stream, ns, `session error: ${err}`)
    return
  }

  // Forward only meaningful headers; drop pseudo-headers (handled by http2)
  // and hop-by-hop.
  //
  // gRPC-specific: `te: trailers` is a gRPC protocol requirement (see gRPC over
  // HTTP/2 spec §6).  Python grpcio strictly enforces it — it sends RST_STREAM
  // INTERNAL_ERROR (code 2) if the header is absent.  `te` is normally a
  // hop-by-hop header (RFC 7230) and is in HOP_BY_HOP, but for gRPC we MUST
  // forward it (or explicitly set it) so that the backend accepts our request.
  const fwdHeaders: http2.OutgoingHttpHeaders = { ':method': headers[':method'] ?? 'POST' }
  const pathVal = headers[':path']
  if (pathVal !== undefined) fwdHeaders[':path'] = pathVal
  fwdHeaders[':scheme'] = 'http'
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue
    if (HOP_BY_HOP.has(k.toLowerCase())) continue
    if (v !== undefined) fwdHeaders[k] = v
  }
  // Always include `te: trailers` for gRPC (required by protocol).
  fwdHeaders['te'] = 'trailers'

  let outStream: http2.ClientHttp2Stream
  try {
    // endStream: false — the client will send request body (gRPC frames).
    outStream = session.request(fwdHeaders, { endStream: false })
  } catch (err) {
    sendGrpcUnavailable(stream, ns, `upstream request failed: ${err}`)
    return
  }

  // Pipe request body (gRPC frames) from client → backend.
  // Use data/end rather than pipe so we can guard against destroyed streams.
  stream.on('data', (chunk: Buffer) => { if (!outStream.destroyed) outStream.write(chunk) })
  stream.on('end', () => { if (!outStream.destroyed) outStream.end() })

  // Pending trailers accumulated from the backend, sent once wantTrailers fires.
  let pendingTrailers: http2.OutgoingHttpHeaders | null = null
  // Guard: tracks whether we've already closed the front stream (via the
  // endStreamInHeaders fast-path), so the outStream 'end' handler doesn't
  // call stream.end() a second time.
  let frontStreamEnded = false

  // Pipe response back: headers + body + trailers → client.
  outStream.once('response', (respHeaders: http2.IncomingHttpHeaders, flags: number) => {
    if (stream.destroyed || stream.closed) return

    // flags & 0x1 = END_STREAM in the HEADERS frame.
    // For zero-body responses (e.g. gRPC UNIMPLEMENTED = status 12), the backend
    // sends grpc-status in the initial HEADERS with END_STREAM set.
    // We must forward those grpc-* fields as HTTP/2 trailers (not initial headers)
    // because gRPC clients (grpcurl) check the trailer block for grpc-status.
    const endStreamInHeaders = (flags & 0x1) !== 0

    const clientHeaders: http2.OutgoingHttpHeaders = {}
    const trailersFromHeaders: http2.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(respHeaders)) {
      if (k === ':status') { clientHeaders[':status'] = v; continue }
      if (k.startsWith(':')) continue
      if (endStreamInHeaders && GRPC_TRAILER_KEYS.has(k)) {
        trailersFromHeaders[k] = v
      } else {
        clientHeaders[k] = v
      }
    }
    if (clientHeaders[':status'] === undefined) clientHeaders[':status'] = 200

    if (endStreamInHeaders) {
      // No body: immediately close with trailers.
      // Set the guard BEFORE calling end() so the outStream 'end' handler
      // (which fires on the same or next tick) does not call stream.end() again.
      frontStreamEnded = true
      pendingTrailers = Object.keys(trailersFromHeaders).length > 0
        ? trailersFromHeaders
        : { 'grpc-status': '0' }
      try {
        stream.respond(clientHeaders, { waitForTrailers: true })
        stream.once('wantTrailers', () => {
          try { stream.sendTrailers(pendingTrailers ?? {}) } catch { /* ignore */ }
        })
        stream.end()
      } catch {
        stream.destroy()
        outStream.destroy()
      }
      return
    }

    // Normal response: initial headers, then data, then trailers via wantTrailers.
    try {
      stream.respond(clientHeaders, { waitForTrailers: true })
    } catch {
      stream.destroy()
      outStream.destroy()
      return
    }

    // Pipe response DATA frames (backend → client), but don't end the stream yet
    // (we wait for wantTrailers).
    outStream.on('data', (chunk: Buffer) => {
      if (!stream.destroyed) stream.write(chunk)
    })
  })

  // Accumulate backend trailing headers; they will be forwarded in wantTrailers.
  outStream.once('trailers', (trailerHeaders: http2.IncomingHttpHeaders) => {
    const fwdTrailers: http2.OutgoingHttpHeaders = {}
    for (const [k, v] of Object.entries(trailerHeaders)) {
      if (!k.startsWith(':') && v !== undefined) fwdTrailers[k] = v
    }
    pendingTrailers = fwdTrailers
  })

  // Backend done sending data → end the front stream (triggers wantTrailers).
  // Guard against double-close: skip if the endStreamInHeaders fast-path already
  // closed the stream (the 'response' handler set frontStreamEnded = true).
  outStream.once('end', () => {
    if (frontStreamEnded) return
    if (!stream.destroyed && !stream.closed) {
      stream.once('wantTrailers', () => {
        try { stream.sendTrailers(pendingTrailers ?? {}) } catch { /* ignore */ }
      })
      try { stream.end() } catch { /* ignore */ }
    }
  })

  outStream.once('error', (err: Error) => {
    if (!stream.destroyed) sendGrpcUnavailable(stream, ns, `upstream error: ${err}`)
  })

  stream.once('error', () => {
    if (!outStream.destroyed) outStream.destroy()
  })

  stream.once('close', () => {
    if (!outStream.destroyed) outStream.destroy()
  })
}

/**
 * Handle a complete HTTP/1.1 request object on the front, routing by namespace.
 *
 * This is extracted so it can be shared between the plain `http.Server` path
 * and the net.Server fallback path after determining the connection is HTTP/1.1.
 */
function handleHttp1Request(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  byNamespace: Map<string, Host>,
  allHosts: Host[],
): void {
  const url = req.url ?? '/'
  const ns = namespaceFromUrl(url)

  // Front-owned aggregate health.
  if (ns === '_meta') {
    const pathOnly = url.split('?')[0]
    if (pathOnly === '/_meta/health') {
      const body = JSON.stringify(aggregateHealth(allHosts))
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

  // gRPC host reached over HTTP/1.1 — indicate it's a gRPC-only endpoint.
  if (host.transport === 'grpc') {
    res.writeHead(426, {
      'content-type': 'application/json',
      'upgrade': 'h2c',
    })
    res.end(JSON.stringify({
      code: 'invalid_argument',
      message: `host '${ns}' is a gRPC endpoint; use gRPC/HTTP-2 (content-type: application/grpc)`,
    }))
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
}

/**
 * Handle a gRPC (HTTP/2) stream on the front, routing by namespace derived
 * from the `:path` pseudo-header (e.g. `/<ns>.<Ns>Service/<method>`).
 *
 * Special case: gRPC reflection requests (`/grpc.reflection.*`) are routed to
 * the first alive gRPC host.  grpcurl (and other tools) use reflection to look up
 * service descriptors before making calls; since our gRPC backends all run the
 * reflection service, routing reflection to the first alive gRPC host is correct.
 */
function handleH2Stream(
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
  byNamespace: Map<string, Host>,
  allHosts: Host[],
): void {
  // Derive the namespace from the gRPC method path: /<ns>.<NsService>/<method>
  // The gRPC path is: /<package>.<ServiceName>/<MethodName>
  // Our namespace = the part before the first dot in the package name.
  const grpcPath = (headers[':path'] as string | undefined) ?? ''
  // e.g. "/b.BService/add_decimal" → ns = "b"
  // e.g. "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo" → ns = "grpc"
  const dotIdx = grpcPath.indexOf('.')
  let ns = ''
  if (dotIdx > 1) {
    // strip leading /
    ns = grpcPath.slice(1, dotIdx)
  } else {
    // Fallback: use first path segment (without the leading /).
    ns = namespaceFromUrl(grpcPath)
  }

  // gRPC reflection service: route to the first alive gRPC host.
  // grpcurl uses reflection to discover service descriptors before calling methods.
  if (ns === 'grpc') {
    const reflHost = allHosts.find((h) => h.transport === 'grpc' && h.alive)
    if (!reflHost) {
      sendGrpcUnavailable(stream, 'grpc', 'no gRPC host available for reflection')
      return
    }
    proxyGrpcStream(stream, headers, reflHost.port, 'grpc')
    return
  }

  const host = byNamespace.get(ns)
  if (!host) {
    sendGrpcUnavailable(stream, ns, `no host mounted at namespace "${ns}"`)
    return
  }

  if (!host.alive) {
    sendGrpcUnavailable(stream, ns, 'child process is not running')
    return
  }

  if (host.transport !== 'grpc') {
    // HTTP host received a gRPC request — shouldn't happen with correct routing.
    sendGrpcUnavailable(stream, ns, `host '${ns}' is not a gRPC host`)
    return
  }

  proxyGrpcStream(stream, headers, host.port, ns)
}

/**
 * Create the combined front server: HTTP/1.1 proxy + gRPC (HTTP/2) proxy,
 * both on the same TCP port, disambiguated by inspecting the first bytes of
 * each connection.
 *
 * @param hosts    - The resolved, spawned hosts (with live ports).
 * @param frontPort - The TCP port the front should listen on.
 */
export function createFrontServer(hosts: Host[]): http.Server {
  const byNamespace = new Map<string, Host>()
  for (const h of hosts) byNamespace.set(h.namespace, h)

  const hasGrpcHosts = hosts.some((h) => h.transport === 'grpc')

  if (!hasGrpcHosts) {
    // No gRPC hosts — use a plain HTTP/1.1 server (simpler, no peeking needed).
    return http.createServer((req, res) => {
      handleHttp1Request(req, res, byNamespace, hosts)
    })
  }

  // Mixed HTTP/1.1 + gRPC setup: we need to peek the first bytes of each
  // connection to route it to the correct protocol handler.
  //
  // HTTP/2 prior-knowledge (h2c) connections always start with the 24-byte
  // client magic preface.  HTTP/1.1 connections start with a text method.
  // We use a raw net.Server, peek the first bytes, then either:
  //   (a) Hand off to the http2 server's socket (via server.emit('connection'))
  //   (b) Hand off to the http server's socket

  const httpServer = http.createServer((req, res) => {
    handleHttp1Request(req, res, byNamespace, hosts)
  })

  const h2Server = http2.createServer()
  h2Server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    handleH2Stream(stream, headers, byNamespace, hosts)
  })
  h2Server.on('error', () => { /* suppress internal http2 errors */ })

  // The "public" server is actually a raw TCP server that peeks and routes.
  // We return httpServer as the nominal handle (for .listen/.close/address()),
  // but we wire the actual TCP accept logic through the raw net.Server.
  // Strategy: override httpServer to use a custom net.Server that does the peek.
  const rawServer = net.createServer()

  rawServer.on('connection', (socket: net.Socket) => {
    socket.once('error', () => socket.destroy())

    // Peek the first 3 bytes to determine the protocol without consuming them.
    //
    // We use socket.once('readable') + socket.read(3) (paused-mode) rather than
    // socket.once('data') (flowing-mode).  In paused mode, socket.read(3) removes
    // 3 bytes from the JS Readable state buffer (populated by the socket's
    // libuv I/O handle) and socket.unshift(peeked) puts them back.  Both the
    // http2 native parser and the http1 parser re-read from that same JS buffer,
    // so the unshifted bytes are correctly replayed to whichever server takes the
    // socket.
    socket.once('readable', () => {
      const peeked = socket.read(3) as Buffer | null
      if (!peeked) {
        // EOF or empty read before any data arrived.
        socket.destroy()
        return
      }

      // HTTP/2 prior-knowledge (h2c) preface starts with `PRI`.
      // HTTP/1.1 method tokens (GET, POST, PUT, DELETE, …) never start with `PRI`.
      const isH2 = peeked.length >= 3 && peeked.slice(0, 3).equals(H2_PREFACE.slice(0, 3))

      // Put the peeked bytes back so the server that takes the socket sees a
      // complete, unmodified byte stream starting from byte 0.
      socket.unshift(peeked)

      if (isH2) {
        // HTTP/2 (gRPC) connection — tag the socket so h2Server accepts it as h2
        // (non-TLS sockets have alpnProtocol === undefined, not 'h2') and hand off.
        const s = socket as net.Socket & { alpnProtocol?: string }
        s.alpnProtocol = 'h2'
        h2Server.emit('connection', socket)
      } else {
        // HTTP/1.1 connection — hand off to the http server.
        httpServer.emit('connection', socket)
      }
    })
  })

  rawServer.on('error', (err) => httpServer.emit('error', err))

  // Monkey-patch the httpServer's listen/close/address to delegate to rawServer.
  // This preserves the existing caller interface (server.listen(port, host, cb)).
  const origListen = httpServer.listen.bind(httpServer)
  const origClose = httpServer.close.bind(httpServer)
  const origAddress = httpServer.address.bind(httpServer)

  ;(httpServer as http.Server & { _rawServer?: net.Server })._rawServer = rawServer

  httpServer.listen = ((...args: Parameters<typeof rawServer.listen>) => {
    return rawServer.listen(...args)
  }) as typeof httpServer.listen

  httpServer.close = ((cb?: (err?: Error) => void) => {
    h2Server.close()
    return rawServer.close(cb)
  }) as typeof httpServer.close

  httpServer.address = () => rawServer.address()

  // Suppress unused reference warnings.
  void origListen
  void origClose
  void origAddress

  return httpServer
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
        `code=${code} signal=${signal} — /${host.namespace}/* now unavailable`,
      )
    })
    log(`[serve] spawned "${h.namespace}" (${h.plugin}/${h.transport}) → :${h.port}  [${h.source}]`)
  }

  // Await readiness for every host in parallel.
  await Promise.all(
    hosts.map((h) =>
      waitForReady(h).then(() =>
        log(`[serve] host "${h.namespace}" ready on :${h.port} (${h.transport})`),
      ),
    ),
  )

  const front = createFrontServer(hosts)
  await new Promise<void>((resolve, reject) => {
    front.once('error', reject)
    front.listen(opts.port, '127.0.0.1', resolve)
  })
  log(`[serve] front listening on :${opts.port}`)
  for (const h of hosts) {
    log(`[serve]   /${h.namespace}/* → :${h.port} (${h.plugin}/${h.transport})`)
  }

  let torn = false
  const shutdown = async (): Promise<void> => {
    if (torn) return
    torn = true
    log('[serve] shutting down — killing children…')
    destroyAllGrpcSessions()
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
    .description('Mount many sources/languages behind one HTTP/gRPC front')
    .requiredOption(
      '--source <path>',
      'Source file to mount (repeatable; .ts → api-fastify, .py → py-flask)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .requiredOption('--port <port>', 'Front HTTP/gRPC port', (v) => Number.parseInt(v, 10))
    .option(
      '--mount <ns=plugin>',
      'Pin a namespace to an explicit plugin (repeatable; use py-grpc for gRPC)',
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
