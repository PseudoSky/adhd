/**
 * api.ts — the apigen-visible surface of @adhd/stealth-core-browser.
 *
 * Exactly six plain, TSDoc'd async functions: the chrome-runner verbs. This
 * package mounts no host: the verbs are projected by consumers (such as
 * @adhd/stealth-search) one-to-one onto their CLI and MCP hosts (tool name =
 * function name, tool description = the TSDoc description). Everything else the package offers
 * is a library namespace re-exported from `index.ts` and is NOT projected.
 *
 * Rules every verb here follows:
 *  - input is ONE plain, JSON-serializable object of typed options; there are
 *    no environment-variable toggles and no host-side secrets;
 *  - the CDP endpoint is chosen by the `host`/`port` input, defaulting to
 *    `DEFAULT_HOST`/`DEFAULT_PORT` only when the caller gives none;
 *  - `launchChrome` exposes only `port` and `userDataDir`. The library-level
 *    `chromePath` and `extraArgs` launch options are deliberately NOT part of any
 *    verb input: reachable over MCP they would be arbitrary command execution;
 *  - no input or output property is an optional boolean (see `ChromeStatus`);
 *  - every output is a plain JSON shape (no `Date`, no class instance).
 */

import { StealthCoreBrowserError } from './errors.js'
import { resolveEndpoint as resolveChromeEndpoint } from './lib/endpoint.js'
import { lifecycleError } from './lib/lifecycle/errors.js'
import { getChromeInfo, isChromeReachable, listPageTargetsOnly } from './lib/cdp/targets.js'
import { isManagedAt, managerFor, noteManagerActivity, shutdownIdleAt } from './lib/managers.js'
import { checkChromeActivity as readChromeActivity } from './lib/queries/activity.js'
import { getPageContext as readPageContext } from './lib/queries/context.js'
import type { PageContext } from './lib/queries/context.js'
import type { ChromeVisit } from './lib/types.js'

/** Which Chrome DevTools endpoint a verb talks to. */
export interface ChromeEndpointInput {
  /** CDP host name or address (default 127.0.0.1). Loopback only unless the hosting process allowed more (see `endpoint.configureEndpointPolicy`). */
  host?: string
  /** CDP remote-debugging port (default 9222) */
  port?: number
}

/** Input of launchChrome: the port and, optionally, a dedicated profile directory. */
export interface LaunchChromeInput {
  /** CDP remote-debugging port to start Chrome on (default 9222) */
  port?: number
  /** Chrome user data directory (default: the dedicated CDP profile) */
  userDataDir?: string
}

/** Input of checkChromeActivity. */
export interface CheckChromeActivityInput extends ChromeEndpointInput {
  /** A visit newer than this many minutes counts as recent use (default 2) */
  withinMinutes?: number
  /** Chrome user data directory whose history is read (default: the dedicated CDP profile) */
  userDataDir?: string
}

/** Input of getPageContext. */
export interface GetPageContextInput extends ChromeEndpointInput {
  /** Target id of the page, as returned by listPageTargets */
  targetId: string
  /** Chrome user data directory whose cookies and history are read (default: the dedicated CDP profile) */
  userDataDir?: string
}

// `managed` is REQUIRED (`managed: boolean`), never an optional property. apigen's
// extractor renders an optional boolean property as
// `oneOf:[{type:'null'},{type:'boolean'},{type:'boolean'}]` — a DUPLICATED
// boolean branch (optional strings/numbers instead extract correctly as
// `[null, X]`). JSON-Schema `oneOf` requires EXACTLY ONE match, so any boolean
// value matches two branches and the MCP client rejects the tool's
// structuredContent with `-32602 ... data/managed must match exactly one schema
// in oneOf`. `version`/`protocol` stay optional — only boolean is affected.
// Do not make `managed` optional.
/** Result of chromeStatus. */
export interface ChromeStatus {
  running: boolean
  version?: string
  protocol?: string
  managed: boolean
}

/** Result of launchChrome. */
export interface LaunchChromeResult {
  ok: boolean
  port: number
}

/** Result of shutdownChrome: whether the soft shutdown ran, and whether Chrome is still answering afterwards. */
export interface ShutdownChromeResult {
  /** True when the soft shutdown completed; false when it failed (the call still resolves, and `running` says what is left). */
  ok: boolean
  /** Whether Chrome still answers on the endpoint after the soft shutdown. A deliberate deferral to an active session leaves it true with `ok` true. */
  running: boolean
}

/** One open page of the controlled Chrome. */
export interface PageTarget {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

/** Result of listPageTargets. */
export interface PageTargetList {
  targets: PageTarget[]
}

/** The most recent visit in Chrome history, with the visit time as an ISO string. */
export type ChromeVisitRecord = Omit<ChromeVisit, 'visitTime'> & { visitTime: string }

/** Result of checkChromeActivity. */
export interface ChromeActivityReport {
  activePages: number
  pageTargets: string[]
  lastVisit: ChromeVisitRecord | null
  recentlyUsed: boolean
  meta: {
    checkedAt: string
    cdpHost: string
    profileDir: string
  }
}

/** Result of getPageContext: `found` is false when the target no longer exists. */
export interface PageContextResult {
  found: boolean
  context: PageContext | null
}

// ─── Configuration helpers ────────────────────────────────────────────────────

/** Resolve and validate the CDP endpoint from typed input (loopback unless the hosting process allowed more, see `endpoint`). */
function resolveEndpoint(input: ChromeEndpointInput = {}): { host: string; port: number; cdpHost: string } {
  return resolveChromeEndpoint(input)
}

/** The CDP `host:port` of typed input. */
function resolveCdpHost(input: ChromeEndpointInput = {}): string {
  return resolveEndpoint(input).cdpHost
}

/** Record genuine activity on a managed Chrome so its idle timer re-arms. */
function noteActivity(input: ChromeEndpointInput): void {
  const { host, port } = resolveEndpoint(input)
  noteManagerActivity(host, port)
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toVisitRecord(visit: ChromeVisit): ChromeVisitRecord {
  return { ...visit, visitTime: visit.visitTime.toISOString() }
}

// ─── Verbs ────────────────────────────────────────────────────────────────────

/**
 * Report whether Chrome answers on the CDP endpoint: its version, protocol
 * version, and whether this process launched and manages it.
 */
export async function chromeStatus(input?: ChromeEndpointInput): Promise<ChromeStatus> {
  const { host, port, cdpHost } = resolveEndpoint(input)
  try {
    if (!(await isChromeReachable(cdpHost))) return { running: false, managed: false }
    const info = await getChromeInfo(cdpHost)
    return {
      running: true,
      version: info.browserVersion,
      protocol: info.protocolVersion,
      managed: isManagedAt(host, port),
    }
  } catch (err) {
    if (err instanceof StealthCoreBrowserError) throw err
    throw StealthCoreBrowserError.of('CDP_UNREACHABLE', `Failed to check Chrome status: ${describeError(err)}`, { cause: err, detail: { host, port } })
  }
}

/**
 * Start a stealth Chrome (no automation flag) on the CDP port if none is
 * running, hide its windows and begin idle-shutdown management. Safe to call
 * repeatedly: an already running Chrome is reused.
 */
export async function launchChrome(input?: LaunchChromeInput): Promise<LaunchChromeResult> {
  const { host, port } = resolveEndpoint({ port: input?.port })
  try {
    await managerFor(host, port, input?.userDataDir).ready()
  } catch (err) {
    if (err instanceof StealthCoreBrowserError) throw err
    throw lifecycleError('LAUNCH_FAILED', `Failed to launch Chrome: ${describeError(err)}`, { cause: err, detail: { port } })
  }
  return { ok: true, port }
}

/**
 * Soft-shutdown the managed Chrome: close it only when it is genuinely idle,
 * deferring to other sessions and to any open web page. A failed shutdown does
 * not throw: `ok` is false and `running` reports whether Chrome is still
 * running afterwards. The one exception is an input endpoint that is not
 * allowed (a non-loopback host the process did not allow, a bad port), which
 * rejects with `CDP_UNREACHABLE` (`detail.reason: 'invalid-endpoint'`) before
 * anything is attempted.
 */
export async function shutdownChrome(input?: ChromeEndpointInput): Promise<ShutdownChromeResult> {
  const { host, port, cdpHost } = resolveEndpoint(input)
  let ok = true
  try {
    await shutdownIdleAt(host, port)
  } catch {
    // A soft shutdown never throws; `ok: false` records that it failed and `running` tells what is left.
    ok = false
  }
  return { ok, running: await isChromeReachable(cdpHost) }
}

/**
 * List the open page targets (tabs) of the controlled Chrome with their
 * target ids and URLs, excluding service workers and background pages.
 */
export async function listPageTargets(input?: ChromeEndpointInput): Promise<PageTargetList> {
  const cdpHost = resolveCdpHost(input)
  const pages = await listPageTargetsOnly(cdpHost)
  noteActivity(input ?? {})
  return { targets: pages.map((p) => ({ id: p.id, type: p.type, url: p.url, webSocketDebuggerUrl: p.webSocketDebuggerUrl })) }
}

/**
 * Check whether Chrome is in use right now: the open web pages and the most
 * recent history visit, so a caller can avoid disturbing a human's session.
 */
export async function checkChromeActivity(input?: CheckChromeActivityInput): Promise<ChromeActivityReport> {
  const cdpHost = resolveCdpHost(input)
  const activity = await readChromeActivity(cdpHost, input?.withinMinutes, input?.userDataDir)
  noteActivity(input ?? {})
  return {
    ...activity,
    lastVisit: activity.lastVisit ? toVisitRecord(activity.lastVisit) : null,
  }
}

/**
 * Describe one open page: its URL and title, how many cookies the profile
 * holds for its host (names and values are never returned), and how often it
 * appears in Chrome history.
 */
export async function getPageContext(input: GetPageContextInput): Promise<PageContextResult> {
  const cdpHost = resolveCdpHost(input)
  const context = await readPageContext(input.targetId, cdpHost, input.userDataDir)
  noteActivity(input)
  return { found: context !== null, context }
}
