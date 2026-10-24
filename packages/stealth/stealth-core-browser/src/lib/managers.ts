/**
 * @adhd/stealth-core-browser — src/lib/managers.ts
 *
 * The one host-neutral manager seam. A host (the stealth-search entrypoint, any
 * other consumer) configures idle shutdown, keep-alive and the reaper entry
 * ONCE with `configureManagers`, reads managers through `managerFor`, and wires
 * its process exit hooks to every live manager with `chromeExitTarget`, without
 * ever constructing a ChromeManager itself. This module holds the single
 * module-level manager map and the only `new ChromeManager(` in the package.
 *
 * Host-neutral and environment-free: every setting is a typed option; nothing
 * here reads the environment or names a host, transport or CLI package. Defaults
 * reproduce the manager's own (no setting = the current idle timeout and the
 * history check on).
 *
 * One module instance: a host loads the BUILT package root and takes the verbs
 * and this seam (`lifecycle.configureManagers`, `lifecycle.managerFor`,
 * `lifecycle.chromeExitTarget`) from that one object, so the verbs and the host
 * share one map.
 *
 * Ticket 8468f7b1 · plan state core-seam ([core-seam.1] [core-seam.3] [core-seam.4]).
 */

import { ChromeManager, type ChromeManagerOptions } from './chrome-manager.js'
import type { ExitHookTarget } from './lifecycle/exit-hooks.js'

/** Host-supplied settings applied to every manager created AFTER the call. */
export interface ManagerSettings {
  /** Idle timeout in ms. Default: the manager's own (120_000). */
  idleTimeoutMs?: number
  /** true never arms the idle timer. Default: false. */
  keepAlive?: boolean
  /** The built package entry the detached reaper loads `runChromeReaper` through. Default: this bundle. */
  entryPath?: string
  /** Let a recent Chrome history visit keep Chrome alive. Default: true. */
  checkHistory?: boolean
  /** Diagnostics sink of every manager. Default: the manager's own console logger. */
  logger?: (msg: string) => void
}

let settings: ManagerSettings = {}
const managers = new Map<string, ChromeManager>()

/**
 * Store the host's settings. A second call REPLACES them for managers created
 * afterwards; managers that already exist keep the settings they were built with.
 */
export function configureManagers(next: ManagerSettings = {}): void {
  settings = { ...next }
}

function managerOptions(): Partial<ChromeManagerOptions> {
  const o: Partial<ChromeManagerOptions> = {}
  if (settings.idleTimeoutMs !== undefined) o.idleTimeoutMs = settings.idleTimeoutMs
  if (settings.keepAlive !== undefined) o.keepAlive = settings.keepAlive
  if (settings.entryPath !== undefined) o.entryPath = settings.entryPath
  if (settings.checkHistory !== undefined) o.checkHistory = settings.checkHistory
  if (settings.logger !== undefined) o.logger = settings.logger
  return o
}

/**
 * The cached manager of one Chrome (host, port, profile): the first call
 * constructs it from the current settings, later calls return the same one.
 * `userDataDir` is the profile that manager launches and may kill.
 */
export function managerFor(host: string, port: number, userDataDir?: string): ChromeManager {
  const key = `${host}:${port}#${userDataDir ?? ''}`
  let manager = managers.get(key)
  if (!manager) {
    manager = new ChromeManager({
      cdpHost: `${host}:${port}`,
      ...(userDataDir === undefined ? {} : { userDataDir }),
      ...managerOptions(),
    })
    managers.set(key, manager)
  }
  return manager
}

/** The live managers of the Chrome at `host:port` (one per profile it was asked for). */
function managersAt(host: string, port: number): ChromeManager[] {
  const prefix = `${host}:${port}#`
  return [...managers].filter(([key]) => key.startsWith(prefix)).map(([, m]) => m)
}

/** Genuine use of the Chrome at `host:port`: re-arms the idle timer of every live manager of it. */
export function noteManagerActivity(host: string, port: number): void {
  for (const m of managersAt(host, port)) m.bump()
}

/** True when this process holds a ready manager of the Chrome at `host:port`. */
export function isManagedAt(host: string, port: number): boolean {
  return managersAt(host, port).some((m) => m.isReady)
}

/** The soft shutdown of every live manager of the Chrome at `host:port` (a no-op when there is none). */
export async function shutdownIdleAt(host: string, port: number): Promise<void> {
  await Promise.all(managersAt(host, port).map((m) => m.shutdownIfIdle()))
}

/** Run `fn` on every live manager; every one runs, and the first failure is rethrown afterwards. */
async function onEvery(fn: (manager: ChromeManager) => Promise<void> | void): Promise<void> {
  const results = await Promise.allSettled([...managers.values()].map(async (m) => fn(m)))
  const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failed) throw failed.reason
}

/**
 * The `{ release(), shutdownIfIdle() }` object that reaches EVERY live manager,
 * the shape `installProcessExitHooks` expects: `release()` leaves each reaper
 * registry, `shutdownIfIdle()` is the soft, tier-respecting shutdown.
 */
export const chromeExitTarget: ExitHookTarget = {
  release: () => onEvery((m) => m.release()),
  shutdownIfIdle: () => onEvery((m) => m.shutdownIfIdle()),
}
