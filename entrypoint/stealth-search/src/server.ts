/**
 * @adhd/stealth-search: src/server.ts
 *
 * The MCP host, and the one place the apigen package of the eleven verbs is built (the CLI host
 * mounts the same package). `buildStealthSearchPackage` extracts the operations from the BUILT
 * `dist/api.d.ts` (a shipped package carries declarations, not TypeScript source), inlines `$ref`
 * (run-mode dispatch cannot resolve them), composes the schemas and binds the live functions of
 * `./api.js`: the verbs, the guard and the tripwire the hosts configure are one module instance.
 *
 * Naming (decision recorded in evidence/naming-decision.md): the namespace is `stealth`, the file
 * segment is dropped and each operation keeps its verb as ONE word, so the MCP tool is
 * `stealth_<verb>` (`stealth_listProviders`) and the CLI operation is the bare verb
 * (`listProviders`), the same spelling as the function in `src/api.ts`.
 *
 * `startMcpHost` serves the package over `stdio` (default), `sse` or `streaming-http` through
 * `mcpPlugin.run` with the single `adhd` tracing plugin mounted. Boot behaviour ported from the
 * source `server.mjs` (inventory I-33, I-34) and driven by flags: a boot trace file, a pid registry
 * with a sibling warning, the core exit hooks (uncaughtException and unhandledRejection do a soft
 * Chrome shutdown and exit 1; SIGINT and SIGTERM likewise; every teardown is bounded by a 5000 ms
 * forced exit), and stdin-EOF orphan detection with a 1000 ms grace for the stdio transport only.
 * Logs go to stderr; stdout carries only JSON-RPC.
 *
 * Inventory rows: I-33, I-34, I-35, I-16 (launch allowlist re-proved on the composed schema).
 * Ticket 8468f7b1 · plan state search-hosts · [search-hosts.7] [search-hosts.12] [search-hosts.13]
 * [search-hosts.14] [search-hosts.15]
 */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { composeSchemas, extract } from '@adhd/apigen-core-client'
import type { Operation, RunInput } from '@adhd/apigen-core-client'
import { project } from '@adhd/apigen-engine-naming'
import { createLogger } from '@adhd/apigen-engine-runtime'
import { mcpPlugin } from '@adhd/apigen-plugin-mcp'
import { lifecycle, shutdownChrome } from '@adhd/stealth-core-browser'
import * as api from './api.js'
import { HostBootFailedError, asHostError, bootFailed, flagInvalid, hostExitCode, transportUnsupported } from './host-errors.js'
import { MCP_TRANSPORTS, renderMcpHelp, toSearchHostConfig } from './host-flags.js'
import type { HostSettings, McpTransport, ParsedHostArgs } from './host-flags.js'
import { parseHostFlags } from './host-flags.js'
import { configureSearch } from './lib/search.js'
import type { ConfigureSearchOptions } from './lib/search.js'
import { tracingPlugin } from './tracing.js'

// ─── The package ──────────────────────────────────────────────────────────────

/** The apigen namespace of every operation (first segment of every MCP tool name). */
export const STEALTH_NAMESPACE = 'stealth'

/** The eleven operations, in `--help` order. */
export const OPERATION_NAMES = [
  'search',
  'listProviders',
  'describeProvider',
  'tripwireStatus',
  'clearTripwire',
  'getPageContext',
  'chromeStatus',
  'launchChrome',
  'shutdownChrome',
  'listPageTargets',
  'checkChromeActivity',
] as const
export type OperationName = (typeof OPERATION_NAMES)[number]

/**
 * What each operation does, for `tools/list` and the CLI `--help`. The extractor carries no
 * TSDoc, so the host owns the one-line descriptions; a spec holds them to the verbs of `api.ts`.
 */
export const OPERATION_DESCRIPTIONS: Readonly<Record<OperationName, string>> = {
  search:
    'Search a provider (duckduckgo, google, github, npm, arxiv and more) or read a URL as markdown with the fetch provider. Returns titles, urls and snippets; a locked provider answers outcome hitl without opening a window.',
  listProviders: 'List every registered search provider with its description and strategies, so a caller can choose one before calling search.',
  describeProvider: 'Describe one search provider: its example URL, strategies, ban rules, qualifier syntax (site:, repo:) and how to call search for it.',
  tripwireStatus: 'Report the providers locked after a hostile response (captcha, ban, rate limit), each with the reason, when it tripped and when it expires.',
  clearTripwire: 'Release a locked provider after the challenge was solved or the lock is no longer wanted; reports cleared false when it was not locked.',
  getPageContext: 'Describe one open Chrome page: URL, title, cookie names and counts (never cookie values) and how often it appears in history.',
  chromeStatus: 'Report whether Chrome answers on the CDP endpoint: its version, protocol version and whether this process launched and manages it.',
  launchChrome: 'Start a stealth Chrome (no automation flag) on the CDP port if none is running, hide its windows and manage its idle shutdown.',
  shutdownChrome: 'Soft-shutdown the managed Chrome: close it only when it is genuinely idle, deferring to other sessions and open web pages.',
  listPageTargets: 'List the open page targets (tabs) of the controlled Chrome with their target ids and URLs.',
  checkChromeActivity: 'Check whether Chrome is in use right now: open web pages and the most recent history visit, to avoid disturbing a human session.',
}

/** Operations whose input the composed schema REQUIRES, so a call that omits it is rejected before the function runs. */
const EXPLICIT_INPUT_OPERATIONS: readonly OperationName[] = ['launchChrome']

type PackageInput = RunInput['packages'][number]
type Json = Record<string, unknown>
type VerbFn = (...args: never[]) => unknown

/** The live functions bound to the package: by default the verbs of `src/api.ts`. */
export type Verbs = Readonly<Record<string, VerbFn>>

/** One operation as the hosts present it. */
export interface SurfaceEntry {
  /** The verb, as written in `src/api.ts` and typed on the CLI. */
  operation: OperationName
  id: string
  /** The apigen CLI path the invoker routes. */
  cliPath: string[]
  /** The MCP tool name. */
  mcpTool: string
  description: string
}

/** What `buildStealthSearchPackage` returns. */
export interface StealthSearchPackage {
  pkg: PackageInput
  operations: Operation[]
  surface: SurfaceEntry[]
  toolDescriptions: Record<string, string>
}

export interface BuildPackageOptions {
  /** Where the extracted operations are cached between runs; absent means every build extracts. */
  cacheFile?: string
  /** File access (specs). Default: the real file system. */
  fs?: HostFs
  /** The file the operations are extracted from. Default: the built `dist/api.d.ts` next to this module. */
  apiSource?: string
  /** The live functions. Default: `./api.js`. */
  verbs?: Verbs
  /** MCP handshake version. Default: the package version. */
  version?: string
}

/** The directory of the package root (`dist/` once built, the package directory under test). */
export function packageRoot(): string {
  return join(__dirname, '..')
}

/** The package version, read from the `package.json` next to the built output. */
export function readPackageVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8'))
    const v = (parsed as { version?: unknown }).version
    return typeof v === 'string' ? v : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Run-mode dispatch cannot resolve JSON-Schema `$ref`, so every definition is inlined and the
 * `definitions` blocks dropped (ported from the source `apigen-client-common.mjs`; a recursive
 * reference resolves to `{}`).
 */
export function dereferenceSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema
  const definitions: Record<string, unknown> = {}
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) collect(item)
      return
    }
    if (!node || typeof node !== 'object') return
    const obj = node as Json
    for (const key of ['definitions', '$defs']) {
      const defs = obj[key]
      if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
        for (const [name, def] of Object.entries(defs as Json)) if (!(name in definitions)) definitions[name] = def
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue
      collect(value)
    }
  }
  collect(schema)
  collect(definitions)
  if (Object.keys(definitions).length === 0) return schema
  const inline = (node: unknown, seen: Set<string>): unknown => {
    if (Array.isArray(node)) return node.map((item) => inline(item, seen))
    if (!node || typeof node !== 'object') return node
    const obj = node as Json
    const ref = obj['$ref']
    if (typeof ref === 'string') {
      const name = ref.replace(/^#\/(?:definitions|\$defs)\//, '')
      if (seen.has(name) || !(name in definitions)) return {}
      return inline(definitions[name], new Set([...seen, name]))
    }
    const out: Json = {}
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'definitions' || key === '$defs') continue
      out[key] = inline(value, seen)
    }
    return out
  }
  return inline(schema, new Set())
}

/** Each operation keeps its verb as one word: `listProviders` stays `listProviders` in the MCP name and the CLI path. */
export function keepVerbWhole(ops: readonly Operation[]): Operation[] {
  return ops.map((op) => ({
    ...op,
    path: op.path.map((seg, i) => (i === op.path.length - 1 ? { raw: seg.raw, words: [seg.raw] } : seg)),
  }))
}

/** Bumped when the cached shape changes. */
const OPERATIONS_CACHE_VERSION = 1

function packageVersionOf(name: string): string {
  try {
    const req = createRequire(join(__dirname, 'server.js'))
    const parsed: unknown = JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8'))
    const v = (parsed as { version?: unknown }).version
    return typeof v === 'string' ? v : ''
  } catch {
    return ''
  }
}

/** What an extraction depends on: the declarations, the extractor and the core the types are re-exported from. */
function operationsCacheKey(apiSource: string): string {
  const parts = [String(OPERATIONS_CACHE_VERSION), readFileSync(apiSource, 'utf8'), packageVersionOf('@adhd/apigen-core-client'), packageVersionOf('@adhd/stealth-core-browser')]
  try {
    // The declarations of the core carry the types api.d.ts re-exports: key on their content, never on a timestamp
    // (a rebuild or a cache restore changes mtimes without changing a type).
    const entry = resolveCoreEntry()
    const declarations = entry.replace(/\.[cm]?js$/, '.d.ts')
    parts.push(createHash('sha256').update(readFileSync(declarations)).digest('hex'))
  } catch {
    // an unresolvable core only weakens the key; the version parts remain
  }
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

/**
 * Extract the operations of `apiSource`. With a `cacheFile` the result is kept on disk under a key
 * of everything the extraction depends on (a TypeScript program costs seconds; a CLI run must not
 * pay it every time). A missing, unreadable or stale cache is a miss; a write failure is ignored.
 */
async function extractOperations(apiSource: string, cacheFile: string | undefined, fs: HostFs): Promise<Operation[]> {
  const key = cacheFile ? operationsCacheKey(apiSource) : ''
  if (cacheFile) {
    try {
      const hit = JSON.parse(fs.readFile(cacheFile)) as { key?: unknown; operations?: unknown }
      if (hit.key === key && Array.isArray(hit.operations) && hit.operations.length > 0) return hit.operations as Operation[]
    } catch {
      // miss
    }
  }
  const operations = await extract({ sourceFile: apiSource, namespace: STEALTH_NAMESPACE, dropFileSegment: true })
  if (cacheFile) {
    try {
      fs.mkdirp(dirname(cacheFile))
      const tmp = `${cacheFile}.${process.pid}.tmp`
      fs.writeFile(tmp, JSON.stringify({ key, operations }))
      renameSync(tmp, cacheFile)
    } catch {
      // best effort
    }
  }
  return operations
}

/** Make `data.input` required in the composed schema of an operation (a flat or empty call is then rejected). */
function requireExplicitInput(schema: { input?: unknown }): void {
  const input = schema.input as Json | undefined
  const data = ((input?.['properties'] as Json | undefined)?.['data'] ?? undefined) as Json | undefined
  if (!input || !data) return
  data['required'] = Array.from(new Set([...((data['required'] as string[] | undefined) ?? []), 'input']))
  input['required'] = Array.from(new Set([...((input['required'] as string[] | undefined) ?? []), 'data']))
}

function operationName(op: Operation): string {
  return op.path[op.path.length - 1]?.raw ?? ''
}

/**
 * Build the apigen package of the eleven verbs: extract, keep
 * each verb whole, inline `$ref`, compose, bind the live functions. Performs no I/O besides the
 * extraction.
 */
export async function buildStealthSearchPackage(options: BuildPackageOptions = {}): Promise<StealthSearchPackage> {
  const apiSource = options.apiSource ?? join(packageRoot(), 'api.d.ts')
  let extracted: Operation[]
  try {
    extracted = await extractOperations(apiSource, options.cacheFile, options.fs ?? nodeHostFs)
  } catch (e) {
    throw bootFailed(`could not extract the operations from ${apiSource} (build the package first)`, e, { apiSource })
  }
  const operations = keepVerbWhole(extracted)
  const actions = operations.filter((op) => op.kind === 'action')
  const generated = {
    metadata: { namespace: STEALTH_NAMESPACE, phase: '' },
    schemas: Object.fromEntries(
      actions.map((op) => [operationName(op), { input: dereferenceSchema(op.input) as Json, output: dereferenceSchema(op.output) as Json, hasCtx: op.hasCtx, safe: op.safe }])
    ),
  }
  const schemas = composeSchemas(generated, [])
  for (const name of EXPLICIT_INPUT_OPERATIONS) {
    const s = schemas[name]
    if (s) requireExplicitInput(s)
  }
  const surface: SurfaceEntry[] = actions.map((op) => {
    const name = operationName(op) as OperationName
    const projected = project(op)
    return { operation: name, id: op.id, cliPath: projected.cli.path, mcpTool: projected.mcp.name, description: OPERATION_DESCRIPTIONS[name] ?? name }
  })
  const toolDescriptions: Record<string, string> = Object.fromEntries(surface.map((s) => [s.operation, s.description]))
  const verbs = options.verbs ?? (api as unknown as Verbs)
  return {
    pkg: {
      id: STEALTH_NAMESPACE,
      version: options.version ?? readPackageVersion(),
      schemas,
      importPath: apiSource,
      fns: verbs as unknown as Record<string, (...args: unknown[]) => unknown>,
      createClient: async () => ({}),
    },
    operations,
    surface,
    toolDescriptions,
  }
}

// ─── Boot behaviour shared by both hosts ──────────────────────────────────────

/** The forced-exit bound of every teardown, in milliseconds. */
export const FORCE_EXIT_MS = 5000
/** How long a closed stdin must stay closed before the stdio host treats the client as gone. */
export const STDIN_GRACE_MS = 1000

/** The file operations the boot helpers use (injectable so a spec touches no disk). */
export interface HostFs {
  appendFile(path: string, data: string): void
  readFile(path: string): string
  writeFile(path: string, data: string): void
  mkdirp(path: string): void
}

export const nodeHostFs: HostFs = {
  appendFile: (p, d) => appendFileSync(p, d),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, d) => writeFileSync(p, d, { mode: 0o600 }),
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true, mode: 0o700 })
  },
}

/** Write one line to stderr (never stdout). */
export function stderrLine(msg: string): void {
  process.stderr.write(`${msg}\n`)
}

/** The manager/hook diagnostics sink of the hosts: stderr, with a prefix. */
export function stderrLogger(prefix = '[stealth-search]'): (msg: string) => void {
  return (msg) => stderrLine(`${prefix} ${msg}`)
}

export type BootTrace = (stage: string, extra?: Record<string, unknown>) => void

/**
 * The boot trace: one JSON line per boot stage appended to `traceFile`, independent of the logger,
 * so a failing boot leaves evidence of where it stopped. A no-op when no file is given; a write
 * failure never fails the boot.
 */
export function createBootTrace(traceFile: string | undefined, deps: { fs?: HostFs; pid?: number; now?: () => Date } = {}): BootTrace {
  if (traceFile === undefined) return () => undefined
  const fs = deps.fs ?? nodeHostFs
  const pid = deps.pid ?? process.pid
  const now = deps.now ?? (() => new Date())
  return (stage, extra = {}) => {
    try {
      fs.appendFile(traceFile, `${JSON.stringify({ t: now().toISOString(), pid, stage, ...extra })}\n`)
    } catch {
      // best effort: a trace failure never fails the host
    }
  }
}

export interface PidRegistryOptions {
  pidFile: string | undefined
  maxSiblings: number
  fs?: HostFs
  pid?: number
  isAlive?: (pid: number) => boolean
  warn?: (msg: string) => void
  /** Where the unregister-on-exit listener goes. Default `process`. */
  proc?: { on(event: 'exit', listener: () => void): unknown }
}

export interface PidRegistration {
  /** Live sibling pids found at boot, ascending. */
  siblings: number[]
  unregister(): void
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Register this process in the pid registry and warn on stderr when `maxSiblings` or more live
 * siblings already share it (accumulated stale instances all fight over one Chrome). Diagnostic
 * only: it never kills. The pid leaves the registry on exit. Best effort throughout.
 */
export function registerPid(opts: PidRegistryOptions): PidRegistration {
  const file = opts.pidFile
  if (file === undefined) return { siblings: [], unregister: () => undefined }
  const fs = opts.fs ?? nodeHostFs
  const pid = opts.pid ?? process.pid
  const isAlive = opts.isAlive ?? processAlive
  const warn = opts.warn ?? stderrLogger('[stealth-search]')
  const alive = new Set<number>()
  try {
    fs.mkdirp(dirname(file))
  } catch {
    // best effort
  }
  try {
    for (const line of fs.readFile(file).trim().split('\n')) {
      const other = parseInt(line, 10)
      if (!Number.isNaN(other) && other !== pid && isAlive(other)) alive.add(other)
    }
  } catch {
    // no registry yet
  }
  const siblings = [...alive].sort((a, b) => a - b)
  if (siblings.length >= opts.maxSiblings) {
    warn(
      `WARNING: ${siblings.length} sibling instances already running (${siblings.join(', ')}). ` +
        `This looks like accumulated stale instances; each holds its own Chrome manager over one shared Chrome. ` +
        `If they are not live sessions, kill them: kill ${siblings.join(' ')}`
    )
  }
  alive.add(pid)
  try {
    fs.writeFile(file, `${[...alive].join('\n')}\n`)
  } catch {
    // best effort
  }
  let done = false
  const unregister = (): void => {
    if (done) return
    done = true
    try {
      const rest = fs
        .readFile(file)
        .trim()
        .split('\n')
        .filter((l) => parseInt(l, 10) !== pid)
      fs.writeFile(file, rest.length > 0 ? `${rest.join('\n')}\n` : '')
    } catch {
      // best effort
    }
  }
  ;(opts.proc ?? process).on('exit', unregister)
  return { siblings, unregister }
}

/** The part of a readable the grace adapter listens on. */
export interface GraceSource {
  on(event: 'end' | 'close', listener: () => void): unknown
  removeListener(event: 'end' | 'close', listener: () => void): unknown
}

/**
 * Wrap stdin for the core exit hooks: the hook sees `end` only after stdin has stayed ended for
 * `graceMs`, so a request still in flight when the client closes its end can finish. The timer is
 * deliberately NOT unref'd: it keeps the process alive until the teardown it triggers has run.
 */
export function graceStdin(
  stdin: GraceSource,
  graceMs: number = STDIN_GRACE_MS,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (h: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  }
): { on(event: 'end', listener: () => void): unknown; removeListener(event: 'end', listener: () => void): unknown } {
  const entries = new Map<() => void, { handler: () => void; timer: unknown }>()
  return {
    on(_event, listener) {
      const entry: { handler: () => void; timer: unknown } = {
        timer: undefined,
        handler: () => {
          if (entry.timer !== undefined) return
          entry.timer = timers.set(listener, graceMs)
        },
      }
      entries.set(listener, entry)
      stdin.on('end', entry.handler)
      stdin.on('close', entry.handler)
      return undefined
    },
    removeListener(_event, listener) {
      const entry = entries.get(listener)
      if (!entry) return undefined
      entries.delete(listener)
      stdin.removeListener('end', entry.handler)
      stdin.removeListener('close', entry.handler)
      if (entry.timer !== undefined) timers.clear(entry.timer)
      return undefined
    },
  }
}

/** The built entry of the core, the file the detached reaper loads `runChromeReaper` through. */
export function resolveCoreEntry(): string {
  return createRequire(join(__dirname, 'server.js')).resolve('@adhd/stealth-core-browser')
}

// ─── The MCP host ─────────────────────────────────────────────────────────────

/** Everything `startMcpHost` touches outside this module, injectable for specs. */
export interface McpHostDeps {
  build?: (options: BuildPackageOptions) => Promise<StealthSearchPackage>
  runMcp?: (input: RunInput) => Promise<void>
  configure?: (options: ConfigureSearchOptions) => void
  configureManagers?: typeof lifecycle.configureManagers
  installHooks?: typeof lifecycle.installProcessExitHooks
  restartBrowser?: (input: { host: string; port: number }) => Promise<unknown>
  /** Process surface for the exit hooks (`on`, `removeListener`). Default `process`. */
  proc?: lifecycle.ExitHookProcess & { on(event: string, listener: (...args: unknown[]) => void): unknown }
  stdin?: GraceSource & { isTTY?: boolean }
  fs?: HostFs
  pid?: number
  isAlive?: (pid: number) => boolean
  stderr?: (line: string) => void
  exit?: (code: number) => void
  entryPath?: string
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => Date
}

/** A started MCP host. */
export interface McpHostHandle {
  transport: McpTransport
  /** Remove the exit hooks this host installed. */
  uninstall(): void
  /** Stop the HTTP transports (a no-op for stdio). */
  abort(): void
  /** Settles when the transport has finished (stdin EOF, abort); rejects with HOST_BOOT_FAILED if it fails. */
  done: Promise<void>
  /** The pids that shared the registry at boot. */
  siblings: number[]
  /** What `mcpPlugin.run` was given. */
  input: RunInput
}

/** The default pid registry of the MCP host: next to the other host state under the data directory. */
export function defaultPidFile(dataDir: string): string {
  return join(dataDir, 'mcp-server.pids')
}

/**
 * Validate `transport`. An unknown one raises HOST_TRANSPORT_UNSUPPORTED before anything else is
 * started, so a mistyped flag never leaves a half-booted process.
 */
export function selectTransport(transport: string): McpTransport {
  const hit = MCP_TRANSPORTS.find((t) => t === transport)
  if (hit === undefined) throw transportUnsupported(transport, MCP_TRANSPORTS)
  return hit
}

/**
 * Boot the MCP host from typed settings: transport check, boot trace, pid registry, manager and
 * search configuration, exit hooks, package, then `mcpPlugin.run` with the tracing plugin mounted.
 * Returns once the transport is started; `done` settles when it ends.
 */
export async function startMcpHost(settings: HostSettings, deps: McpHostDeps = {}): Promise<McpHostHandle> {
  const transport = selectTransport(settings.transport)
  const warn = deps.stderr ?? stderrLine
  const logLine = (m: string): void => warn(`[stealth-search-mcp] ${m}`)
  const trace = createBootTrace(settings.traceFile, { ...(deps.fs ? { fs: deps.fs } : {}), ...(deps.pid === undefined ? {} : { pid: deps.pid }), ...(deps.now ? { now: deps.now } : {}) })
  trace('boot', { transport })

  const registration = registerPid({
    pidFile: settings.pidFile ?? defaultPidFile(settings.dataDir),
    maxSiblings: settings.maxSiblings,
    warn: logLine,
    ...(deps.fs ? { fs: deps.fs } : {}),
    ...(deps.pid === undefined ? {} : { pid: deps.pid }),
    ...(deps.isAlive ? { isAlive: deps.isAlive } : {}),
    ...(deps.proc ? { proc: deps.proc } : {}),
  })
  trace('pid-registered', { siblings: registration.siblings })

  const proc = deps.proc ?? (process as unknown as NonNullable<McpHostDeps['proc']>)
  // The core hooks own the crash path (soft Chrome shutdown, then exit 1); the trace records where it happened.
  proc.on('uncaughtException', (e) => trace('uncaughtException', { message: e instanceof Error ? e.message : String(e) }))
  proc.on('unhandledRejection', (e) => trace('unhandledRejection', { message: e instanceof Error ? e.message : String(e) }))

  const configureManagers = deps.configureManagers ?? lifecycle.configureManagers
  configureManagers({
    idleTimeoutMs: settings.idleShutdownMs,
    keepAlive: settings.keepAlive,
    checkHistory: settings.checkHistory,
    entryPath: deps.entryPath ?? resolveCoreEntry(),
    logger: logLine,
  })
  // The MCP host provides no InteractionPort: a tripped provider answers `hitl` and an agent clears it with clearTripwire.
  const configure = deps.configure ?? configureSearch
  configure({ config: toSearchHostConfig(settings) })
  trace('configured')

  if (settings.restartBrowser) {
    const restart = deps.restartBrowser ?? ((input) => shutdownChrome(input))
    await restart({ host: settings.cdpHost, port: settings.cdpPort })
    trace('browser-restarted')
  }

  const stdin = deps.stdin ?? (process.stdin as unknown as NonNullable<McpHostDeps['stdin']>)
  const orphanWatch = transport === 'stdio' && stdin.isTTY !== true
  const installHooks = deps.installHooks ?? lifecycle.installProcessExitHooks
  const timers = {
    set: deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms)),
    clear: deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)),
  }
  const uninstall = installHooks(lifecycle.chromeExitTarget, {
    forceExitMs: FORCE_EXIT_MS,
    logger: logLine,
    proc,
    ...(deps.exit ? { exit: deps.exit } : {}),
    ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer ? { clearTimer: deps.clearTimer } : {}),
    ...(orphanWatch ? { stdinEof: true, stdin: graceStdin(stdin, STDIN_GRACE_MS, timers) } : {}),
  })
  trace('hooks-installed', { orphanWatch })

  const build = deps.build ?? buildStealthSearchPackage
  const built = await build({ cacheFile: join(settings.dataDir, 'cache', 'operations.json') })
  trace('package-built', { tools: built.surface.length })

  const level = settings.logLevel ?? 'info'
  const logger = createLogger({
    level,
    ...(settings.logFormat ? { format: settings.logFormat } : {}),
    ...(settings.logFile ? { destination: settings.logFile } : {}),
  })
  const controller = new AbortController()
  const input: RunInput = {
    packages: [built.pkg],
    outputDir: '',
    options: {
      transport,
      port: settings.listenPort,
      host: settings.listenHost,
      toolDescriptions: built.toolDescriptions,
      usePlugins: [tracingPlugin],
    },
    signal: controller.signal,
    operations: built.operations,
    logger,
  }
  const runMcp = deps.runMcp ?? mcpPlugin.run?.bind(mcpPlugin)
  if (!runMcp) throw bootFailed('the apigen MCP plugin declares no run()')
  trace('run-invoked', { transport })
  const done = Promise.resolve()
    .then(() => runMcp(input))
    .catch((e: unknown) => {
      throw e instanceof HostBootFailedError ? e : bootFailed(`the ${transport} transport failed: ${e instanceof Error ? e.message : String(e)}`, e, { transport })
    })
  return { transport, uninstall, abort: () => controller.abort(), done, siblings: registration.siblings, input }
}

/** What the MCP bin hands to `mcpMain`. */
export interface McpMainDeps extends McpHostDeps {
  /** Called once with the parsed settings before the first dispatch (the bin passes its telemetry initializer). */
  initTelemetry?: (opts: { role: 'live-service'; logDir?: string }) => void
  stdout?: (text: string) => void
  /** Wait for a started host; default awaits `done`. */
  parse?: (argv: readonly string[]) => ParsedHostArgs
}

/**
 * The MCP bin's body: parse the flags, print `--help`, or start the host and wait for it. Returns
 * the exit status the bin applies (0 on a clean end, the code's exit status on a host failure);
 * failures are written as one `<CODE>: <message>` line on stderr.
 */
export async function mcpMain(argv: readonly string[], deps: McpMainDeps = {}): Promise<number> {
  const warn = deps.stderr ?? stderrLine
  const out = deps.stdout ?? ((t: string) => void process.stdout.write(`${t}\n`))
  try {
    const parsed = (deps.parse ?? ((a) => parseHostFlags(a, 'mcp')))(argv)
    if (parsed.help) {
      out(renderMcpHelp())
      return 0
    }
    const stray = parsed.operation ?? parsed.rest[0]
    if (stray !== undefined) throw flagInvalid(stray, 'unknown argument; stealth-search-mcp takes only host flags (see --help)')
    deps.initTelemetry?.({ role: 'live-service', ...(parsed.settings.logDir ? { logDir: parsed.settings.logDir } : {}) })
    const handle = await startMcpHost(parsed.settings, deps)
    await handle.done
    return 0
  } catch (e) {
    const err = asHostError(e)
    warn(`${err.code}: ${err.message.replace(/\s*\r?\n\s*/g, ' ')}`)
    return hostExitCode(err)
  }
}
