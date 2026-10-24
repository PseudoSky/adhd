/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/reaper-link.ts
 *
 * `ReaperLink` is the ONE seam between a ChromeManager (the client) and the
 * reaper host for its port. The manager depends only on this port; the real
 * adapter (`createProxyReaperLink`, over the service-proxy transport through
 * `sp.ts`) and the unit-test fake (`test/helpers/lifecycle/fake-reaper-link.ts`)
 * both implement it.
 *
 * Link rules (SPEC-single-pass-lifecycle.md 3.4): one held connection per
 * client; `hello{pid, checkHistory}` on connect (registration, not activity);
 * `activity()` is fire-and-forget and the ONLY activity sender is the
 * manager's `bump()`; re-ensure happens only on `ready()`, on a `bump()` /
 * `withBrowser` settle while the link is down and Chrome is reachable, and on
 * one retry of a previously failed ensure at idle fire — never on disconnect.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (CL15 CL22).
 */

import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'

import { errorMessage, lifecycleError, lifecycleErrors, type LifecycleError } from './errors.js'
import type { ReaperScope } from './reap-policy.js'
import type { ChromeReaperConfig } from './reaper-entry.js'
import type { ReapOutcome, ReaperStatus, RpcResponse } from './reaper-host.js'
import { backendSocketPath, dialBackend, ensureBackend, ERR_BACKEND_UNAVAILABLE, type BackendConnection } from './sp.js'

/** The typed cause of a reaper that cannot be reached. */
function reaperCause(message: string): LifecycleError {
  return lifecycleError('REAPER_UNAVAILABLE', message)
}

/**
 * The failure the reaper backend reported. It is a record of the backend's own answer (its
 * `code` is a backend code such as E_UDS_DIR_UNSAFE, not a registry code), so it is not an Error;
 * `toString` yields the message for the REAPER_UNAVAILABLE text built around it.
 */
function backendFailure(message: string, code: string | undefined): { readonly message: string; readonly code?: string; toString(): string } {
  return { message, ...(code === undefined ? {} : { code }), toString: () => message }
}

export interface ReaperLink {
  /**
   * Ensure the reaper host for this port is running and hold one connection
   * that has sent `hello`. Resolves false (never rejects) when the reaper is
   * unavailable: the manager then runs in degraded mode.
   */
  ensureAndHello(): Promise<boolean>
  /** Fire-and-forget `activity` notification. Never throws. */
  activity(): void
  /** Soft reap through the host (graceMs 0, caller excluded); null when the link is down. */
  reapIfIdle(): Promise<ReapOutcome | null>
  /** Leave the host registry and close the connection. Best effort, never rejects. */
  release(): Promise<void>
  /** The host `status` answer; null when the link is down. */
  status(): Promise<ReaperStatus | null>
  /** True while a connection that sent `hello` is held. */
  isUp(): boolean
  /** Why the last `ensureAndHello` failed (REAPER_UNAVAILABLE), or null. */
  lastError(): LifecycleError | null
}

// ─── The real adapter over the service-proxy transport ───────────────────────

/** The spawn form pinned by sp-reaper-load-proof (smoke/reaper-load-proof.md, VERDICT entry-path-ok). */
export const REAPER_ENTRY_SCRIPT = 'require(process.argv[1]).lifecycle.runChromeReaper(JSON.parse(process.argv[2]))'

/** Ms a held connection may take to connect before `hello` gives up (-32001). */
export const LINK_GIVE_UP_MS = 2_000

export interface ProxyReaperLinkConfig {
  port: number
  cdpHost?: string
  /** The verified private state directory (holds the socket, the lock and the reaper log). */
  stateDir: string
  pid: number
  checkHistory: boolean
  idleTimeoutMs: number
  shutdownGraceMs: number
  orphanWindowMs: number
  scope: ReaperScope
  /** The manager's RESOLVED profile dir, handed to the reaper so its port-occupant kill matches only that Chrome. */
  profileDir?: string
  /** The built CommonJS package entry the reaper process requires. Default: this bundle's own file. */
  entryPath?: string
  /** Default `process.execPath`. */
  nodePath?: string
  logger?: (msg: string) => void
}

/** The singleton key of the reaper host for `port` (one host per port per user). */
export function reaperSingletonKey(port: number): string {
  return `stealth-browser-reaper:${port}`
}

/** The package whose built CommonJS entry the reaper process requires. */
const PACKAGE_NAME = '@adhd/stealth-core-browser'

/** Where this module runs from: the CJS `__filename` and/or the ESM module URL. Either may be absent. */
export interface ReaperEntrySource {
  /** CommonJS `__filename`; absent when the module is loaded as ESM. */
  filename?: string
  /** ESM `import.meta.url` (a file URL); the anchor package resolution starts from. */
  moduleUrl?: string
}

/**
 * Resolve the built CommonJS entry the reaper process `require`s (sp-reaper-load-proof). Always an
 * absolute path; a package that cannot be resolved is a REAPER_UNAVAILABLE `LifecycleError`, never null.
 * - CJS: the published build inlines every module into `dist/index.js`, so a JavaScript `filename`
 *   is that bundle and is the entry.
 * - ESM, or CJS loaded from TypeScript source (a `.ts` file cannot be `require`d by a bare node
 *   process): resolve the package entry from the module URL, the way a consumer would.
 */
export function resolveReaperEntry(source: ReaperEntrySource): string {
  const { filename, moduleUrl } = source
  if (typeof filename === 'string' && isAbsolute(filename) && /\.[cm]?js$/.test(filename)) return filename
  if (typeof moduleUrl !== 'string' || moduleUrl === '') {
    throw lifecycleError('REAPER_UNAVAILABLE', `The reaper entry is unknown: neither a CommonJS __filename nor an ESM module URL is available to resolve ${PACKAGE_NAME} from.`)
  }
  try {
    return createRequire(moduleUrl).resolve(PACKAGE_NAME)
  } catch (e) {
    throw lifecycleError('REAPER_UNAVAILABLE', `The reaper entry cannot be resolved: ${PACKAGE_NAME} is not resolvable from ${moduleUrl} (${errorMessage(e)}); build the package or pass entryPath.`, { cause: e })
  }
}

/**
 * The entry the reaper requires for THIS module, under ESM and CJS (backlog 86a2318f). `source`
 * defaults to the real module location; it is injectable so specs can simulate either loader.
 */
export function defaultReaperEntry(source?: ReaperEntrySource): string {
  return resolveReaperEntry(source ?? realSource())
}

function realSource(): ReaperEntrySource {
  return {
    ...(typeof __filename === 'string' ? { filename: __filename } : {}),
    // The CJS build rewrites `import.meta.url` to `pathToFileURL(__filename).href` (tools/vite-plugins/import-meta-url-cjs.mjs);
    // tsconfig.lib.json type-checks as esnext/bundler (the bundler, not tsc, emits this module) so the property is typed without a suppression.
    moduleUrl: import.meta.url,
  }
}

function isOk(r: RpcResponse | undefined): boolean {
  return r !== undefined && r.error === undefined
}

/**
 * `ReaperLink` over the service proxy. Link rules (spec 3.4):
 * - each connection is one `dialBackend({ socketPath, backoff: { giveUpAfterMs: 2000 }, onDisconnect })`;
 *   the dial's own re-dial is never relied on: an established connection that drops is closed and
 *   forgotten (`onDisconnect`), and a reconnect is a NEW dial after a fresh `ensure`;
 * - at most one live dial; a `hello` that resolves -32001 (never connected) closes the dial at once,
 *   so a late connect can never register the same pid twice;
 * - `ensure` happens only when the manager calls `ensureAndHello` — never on disconnect.
 */
export function createProxyReaperLink(cfg: ProxyReaperLinkConfig): ReaperLink {
  const log = cfg.logger ?? (() => undefined)
  const socketPath = backendSocketPath(cfg.stateDir, reaperSingletonKey(cfg.port))
  let current: BackendConnection | null = null
  let ensuring: Promise<boolean> | null = null
  let lastError: LifecycleError | null = null
  let seq = 0

  const reaperConfig = (): ChromeReaperConfig => ({
    port: cfg.port,
    ...(cfg.cdpHost ? { cdpHost: cfg.cdpHost } : {}),
    stateDir: cfg.stateDir,
    socketPath,
    idleTimeoutMs: cfg.idleTimeoutMs,
    shutdownGraceMs: cfg.shutdownGraceMs,
    orphanWindowMs: cfg.orphanWindowMs,
    scope: cfg.scope,
    ...(cfg.profileDir === undefined ? {} : { profileDir: cfg.profileDir }),
    checkHistoryDefault: true,
  })

  const drop = (conn: BackendConnection): void => {
    try {
      conn.close()
    } catch {
      /* already closed */
    }
    if (current === conn) current = null
  }

  const request = async (method: string, params?: unknown): Promise<RpcResponse | undefined> => {
    const conn = current
    if (!conn) return undefined
    return conn.send({ jsonrpc: '2.0', id: `${method}-${++seq}`, method, ...(params === undefined ? {} : { params }) })
  }

  const ensureOnce = async (): Promise<boolean> => {
    if (current) return true
    let entry: string
    try {
      entry = cfg.entryPath ?? defaultReaperEntry()
    } catch (e) {
      lastError = lifecycleErrors.reaperUnavailable(cfg.port, e, cfg.stateDir)
      return false
    }
    let res
    try {
      res = await ensureBackend({
        socketPath,
        singletonKey: reaperSingletonKey(cfg.port),
        command: cfg.nodePath ?? process.execPath,
        args: ['-e', REAPER_ENTRY_SCRIPT, entry, JSON.stringify(reaperConfig())],
        lockDir: cfg.stateDir,
        stderrLogPath: `${cfg.stateDir}/reaper-${cfg.port}.log`,
        onDiagnostic: log,
      })
    } catch (e) {
      lastError = lifecycleErrors.reaperUnavailable(cfg.port, e, cfg.stateDir)
      return false
    }
    if (res.disposition === 'failed') {
      const cause = backendFailure(res.detail, res.errorCode)
      lastError = lifecycleErrors.reaperUnavailable(cfg.port, cause, cfg.stateDir)
      return false
    }
    // spawned | already-live | adopted-after-wait: a host serves the socket. Hold ONE connection.
    const conn: BackendConnection = dialBackend({
      socketPath,
      backoff: { giveUpAfterMs: LINK_GIVE_UP_MS },
      onDiagnostic: log,
      onDisconnect: () => drop(conn),
    })
    current = conn
    // Queued by the dial and delivered as the first frame once the connection is up.
    const hello = await conn.send({ jsonrpc: '2.0', id: `hello-${++seq}`, method: 'hello', params: { pid: cfg.pid, checkHistory: cfg.checkHistory } })
    if (hello.error) {
      drop(conn)
      lastError = lifecycleErrors.reaperUnavailable(
        cfg.port,
        reaperCause(hello.error.code === ERR_BACKEND_UNAVAILABLE ? `the reaper did not accept a connection within ${LINK_GIVE_UP_MS} ms` : hello.error.message),
        cfg.stateDir,
      )
      return false
    }
    lastError = null
    return true
  }

  return {
    ensureAndHello(): Promise<boolean> {
      if (!ensuring) {
        ensuring = ensureOnce()
          .catch((e: unknown) => {
            lastError = lifecycleErrors.reaperUnavailable(cfg.port, e, cfg.stateDir)
            return false
          })
          .finally(() => {
            ensuring = null
          })
      }
      return ensuring
    },
    activity(): void {
      try {
        current?.notify({ jsonrpc: '2.0', method: 'activity' })
      } catch (e) {
        log(`activity not sent: ${(e as Error).message}`)
      }
    },
    async reapIfIdle(): Promise<ReapOutcome | null> {
      const r = await request('reapIfIdle')
      return isOk(r) ? (r!.result as ReapOutcome) : null
    },
    async release(): Promise<void> {
      const conn = current
      if (!conn) return
      try {
        await request('release')
      } catch (e) {
        log(`release not delivered: ${(e as Error).message}`)
      } finally {
        drop(conn)
      }
    },
    async status(): Promise<ReaperStatus | null> {
      const r = await request('status')
      return isOk(r) ? (r!.result as ReaperStatus) : null
    },
    isUp: () => current !== null,
    lastError: () => lastError,
  }
}
