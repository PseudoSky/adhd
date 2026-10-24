/**
 * @adhd/stealth-core-browser — src/lib/cdp/targets.ts
 *
 * Page target lifecycle: create, list, inspect, close.
 *
 * Uses Chrome's HTTP API (/json/version, /json/list) and CDP methods
 * (Target.createTarget, Target.closeTarget) to manage page targets.
 */

import { CdpSession } from './session.js'
import { StealthCoreBrowserError } from '../../errors.js'
import { assertSameEndpoint } from '../endpoint.js'

/** Longest a single CDP HTTP request (version, list) may take before it fails with CDP_TIMEOUT, in milliseconds. */
export const CDP_HTTP_TIMEOUT_MS = 5000

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface PageTargetInfo {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl?: string
}

export interface ChromeVersionInfo {
  browserWsUrl: string
  browserVersion: string
  protocolVersion: string
  userAgent: string
  webSocketDebuggerUrl: string
}

export type PageOptions = {
  foreground?: boolean,
  /** Create the page in the DEFAULT browser context, so it carries the Chrome profile's
   *  cookies/session (where the user signed in). Only for providers that require a signed-in
   *  account; everything else stays in an isolated context. dispose() closes just this target. */
  sharedProfile?: boolean,
}

// ─── Chrome info ──────────────────────────────────────────────────────────────

/**
 * Fetch a CDP HTTP endpoint with a guard that turns undici's opaque
 * `TypeError: fetch failed` into an actionable message. These calls leak
 * straight through the MCP surface (chrome_status, search), so the failure
 * must say WHAT is wrong (Chrome down / remote debugging off), not just
 * "fetch failed". undici nests the real reason (e.g. ECONNREFUSED) in
 * `err.cause` — surface that instead of the opaque wrapper text.
 */
async function cdpFetch(cdpHost: string, path: string): Promise<Response> {
  let res: Response
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, CDP_HTTP_TIMEOUT_MS)
  try {
    res = await fetch(`http://${cdpHost}${path}`, { signal: controller.signal })
  } catch (err) {
    if (timedOut) {
      throw StealthCoreBrowserError.of('CDP_TIMEOUT', `CDP on ${cdpHost} did not answer ${path} within ${CDP_HTTP_TIMEOUT_MS} ms`, { cause: err, detail: { cdpHost, path, timeoutMs: CDP_HTTP_TIMEOUT_MS } })
    }
    let cause = err instanceof Error ? err.message : String(err)
    // undici: TypeError "fetch failed" with the real error in .cause
    const nested = err instanceof Error ? (err as { cause?: unknown }).cause : undefined
    if (nested instanceof Error && nested.message && nested.message !== cause) {
      cause = nested.message
    }
    throw StealthCoreBrowserError.of(
      'CDP_UNREACHABLE',
      `CDP unreachable on ${cdpHost} — Chrome is not running or remote debugging is not enabled on that port (${cause})`,
      { cause: err, detail: { cdpHost } },
    )
  } finally {
    clearTimeout(timer)
  }
  if (!res.ok) {
    throw StealthCoreBrowserError.of(
      'CDP_BAD_RESPONSE',
      `CDP on ${cdpHost} returned HTTP ${res.status} for ${path} — Chrome may be starting or shutting down`,
      { detail: { cdpHost, path, status: res.status } },
    )
  }
  return res
}

/** Get browser version + WebSocket URL from Chrome's /json/version endpoint. */
export async function getChromeInfo(cdpHost: string): Promise<ChromeVersionInfo> {
  const res = await cdpFetch(cdpHost, '/json/version')
  let v: {
    webSocketDebuggerUrl: string
    Browser: string
    'Protocol-Version': string
    'User-Agent': string
  }
  try {
    v = (await res.json()) as typeof v
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${cdpHost} returned a non-JSON /json/version response (${cause})`, { cause: err, detail: { cdpHost } })
  }
  if (typeof v !== 'object' || v === null || typeof v.webSocketDebuggerUrl !== 'string') {
    throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${cdpHost} answered /json/version without a debugger WebSocket URL`, { detail: { cdpHost, reason: 'missing-ws-url' } })
  }
  assertSameEndpoint(cdpHost, v.webSocketDebuggerUrl)
  return {
    browserWsUrl: v.webSocketDebuggerUrl,
    browserVersion: v.Browser,
    protocolVersion: v['Protocol-Version'],
    userAgent: v['User-Agent'],
    webSocketDebuggerUrl: v.webSocketDebuggerUrl,
  }
}

/** Check if Chrome's CDP endpoint is reachable. */
export async function isChromeReachable(cdpHost: string): Promise<boolean> {
  try {
    await getChromeInfo(cdpHost)
    return true
  } catch {
    return false
  }
}

// ─── Target listing ──────────────────────────────────────────────────────────

/** List all page targets with their WebSocket URLs. */
export async function listPageTargets(cdpHost: string): Promise<PageTargetInfo[]> {
  const res = await cdpFetch(cdpHost, '/json/list')
  let list: unknown
  try {
    list = await res.json()
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${cdpHost} returned a non-JSON /json/list response (${cause})`, { cause: err, detail: { cdpHost } })
  }
  if (!Array.isArray(list)) {
    throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${cdpHost} returned a /json/list response that is not an array`, { detail: { cdpHost, reason: 'not-an-array' } })
  }
  const targets = (list as unknown[]).filter((t): t is PageTargetInfo => typeof t === 'object' && t !== null && typeof (t as { id?: unknown }).id === 'string')
  for (const t of targets) {
    if (typeof t.webSocketDebuggerUrl === 'string') assertSameEndpoint(cdpHost, t.webSocketDebuggerUrl)
  }
  return targets
}

/** List only page-type targets (excludes service workers, background pages, etc.). */
export async function listPageTargetsOnly(cdpHost: string): Promise<PageTargetInfo[]> {
  const all = await listPageTargets(cdpHost)
  return all.filter((t) => t.type === 'page')
}

// ─── Target creation ─────────────────────────────────────────────────────────

/**
 * Create a new page target and return its direct WebSocket URL.
 *
 * Uses a browser-level WS connection to call Target.createTarget,
 * then polls /json/list until the target's webSocketDebuggerUrl is
 * registered (usually <200ms).
 */
export async function createPageTarget(cdpHost: string, options: PageOptions = {}): Promise<{
  targetId: string
  pageWsUrl: string
}> {
  const info = await getChromeInfo(cdpHost)
  const browser = new CdpSession()
  let targetId: string
  try {
    await browser.connect(info.browserWsUrl)
    const result = await browser.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
      background: !options.foreground,
      focus: !!options.foreground,
    })
    targetId = result.targetId
  } finally {
    browser.close()
  }

  // Poll /json/list for the new target's WebSocket URL (up to 3s)
  for (let i = 0; i < 30; i++) {
    const targets = await listPageTargets(cdpHost)
    const found = targets.find((t) => t.id === targetId && t.webSocketDebuggerUrl)
    if (found?.webSocketDebuggerUrl) {
      return { targetId, pageWsUrl: found.webSocketDebuggerUrl }
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // The page was created but never became addressable: close it instead of leaving it open.
  await closePageTarget(cdpHost, targetId).catch(() => undefined)
  console.error(`[@adhd/stealth-core-browser] Target ${targetId} not found in /json/list after 3s`)
  throw StealthCoreBrowserError.of('TARGET_NOT_FOUND', `Target ${targetId} not found in /json/list after 3s`, { detail: { targetId, cdpHost } })
}

/** The handle of a created isolated page; `browserContextId` is undefined for a `sharedProfile` page. */
export interface IsolatedPageTargetHandle<Ctx extends string | undefined = string | undefined> {
  targetId: string
  pageWsUrl: string
  /** Undefined when `sharedProfile` placed the page in the default context. */
  browserContextId: Ctx
  /** Bring the (off-screen) window ON-SCREEN and foreground it — for interactive
   *  CAPTCHA solving that a managed challenge's auto-clear can't handle.
   *  No-op when created with `foreground: true` (already on-screen). */
  reveal: () => Promise<void>
  dispose: () => Promise<void>
}

/**
 * Create a page target inside a FRESH, ISOLATED browser context.
 *
 * Unlike `createPageTarget` (which lands in the default context and therefore
 * inherits the user's profile cookies/session), this creates a
 * `Target.createBrowserContext` — an incognito-like partition with NO cookies,
 * NO localStorage, NO session. Navigating here renders the page LOGGED OUT.
 *
 * This is the "cdp-anon" primitive: it lets a fetch/render see a page as an
 * anonymous visitor without ever attaching the user's credentials. The returned
 * `dispose()` tears down the whole context (and every target in it).
 *
 * @returns `{ targetId, pageWsUrl, browserContextId, dispose }`
 */
export async function createIsolatedPageTarget(
  cdpHost: string,
  options: PageOptions & { sharedProfile: true },
): Promise<IsolatedPageTargetHandle<undefined>>
export async function createIsolatedPageTarget(
  cdpHost: string,
  options?: PageOptions & { sharedProfile?: false },
): Promise<IsolatedPageTargetHandle<string>>
export async function createIsolatedPageTarget(
  cdpHost: string,
  options: PageOptions = {},
): Promise<IsolatedPageTargetHandle> {
  const info = await getChromeInfo(cdpHost)
  const browser = new CdpSession()
  let browserContextId: string | undefined
  let targetId: string
  let windowId: number | undefined
  try {
    await browser.connect(info.browserWsUrl)

    // NOT disposeOnDetach: we close this browser connection immediately after
    // creating the target, and disposeOnDetach:true would tear the context down on
    // that detach — the target would vanish before we could poll for it. We own
    // teardown explicitly via the returned dispose().
    browserContextId = options.sharedProfile
      ? undefined
      : (await browser.send<{ browserContextId: string }>('Target.createBrowserContext', {})).browserContextId
    // Default: background:true — do NOT foreground the new window / steal focus.
    // foreground: create it in the foreground so the user can watch/interact.
    try {
      targetId = (await browser.send<{ targetId: string }>('Target.createTarget', {
        url: 'about:blank',
        ...(browserContextId ? { browserContextId } : {}),
        background: !options.foreground,
        focus: !!options.foreground,
      })).targetId
    } catch (err) {
      // The context exists but no page will ever use it: dispose it on the
      // still-open browser session before the error propagates (gap G1).
      if (browserContextId) {
        await browser.send('Target.disposeBrowserContext', { browserContextId }).catch(() => { /* best-effort */ })
      }
      throw err
    }

    // Default: minimize the window. Chrome launched with
    // --disable-backgrounding-occluded-windows so JS timers are NOT throttled.
    // Skipped entirely when foreground is requested.
    try {
      windowId = (await browser.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })).windowId
      if (!options.foreground) {
        await browser.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'minimized' },
        })
      }
    } catch (e) { console.warn("[@adhd/stealth-core-browser] Failed to run createIsolatedPageTarget > Browser.getWindowForTarget", e) }
  } finally {
    // The creator browser session never outlives this call, success or throw (gap G1).
    browser.close()
  }

  // Un-hide the window for interactive solving. Best-effort; reconnects its own
  // short-lived browser session so it works after the creator connection closed.
  const reveal = async (): Promise<void> => {
    if (windowId === undefined) return
    try {
      const i = await getChromeInfo(cdpHost)
      const b = new CdpSession()
      await b.connect(i.browserWsUrl)
      await b.send('Browser.setWindowBounds', {
        windowId,
        bounds: { left: 80, top: 80, width: 1100, height: 850, windowState: 'normal' },
      }).catch(() => { /* best-effort */ })
      b.close()
    } catch (e) { console.warn("[@adhd/stealth-core-browser] Failed to run reveal", e) }
  }

  const dispose = async (): Promise<void> => {
    try {
      const i = await getChromeInfo(cdpHost)
      const b = new CdpSession()
      await b.connect(i.browserWsUrl)
      if (browserContextId) {
        // Disposing the context closes every target within it.
        await b.send('Target.disposeBrowserContext', { browserContextId }).catch(() => { /* best-effort */ })
      } else {
        // Shared profile: never dispose the user's default context, just this target.
        await b.send('Target.closeTarget', { targetId }).catch(() => { /* best-effort */ })
      }
      b.close()
    } catch (e) { console.warn("[@adhd/stealth-core-browser] Failed to run dispose", e) }
  }

  for (let i = 0; i < 30; i++) {
    const targets = await listPageTargets(cdpHost)
    const found = targets.find((t) => t.id === targetId && t.webSocketDebuggerUrl)
    if (found?.webSocketDebuggerUrl) {
      return { targetId, pageWsUrl: found.webSocketDebuggerUrl, browserContextId, reveal, dispose }
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  await dispose()
  console.error(`[@adhd/stealth-core-browser] Isolated target ${targetId} not found in /json/list after 3s`)
  throw StealthCoreBrowserError.of('TARGET_NOT_FOUND', `Isolated target ${targetId} not found in /json/list after 3s`, { detail: { targetId, cdpHost } })
}

// ─── Target closing ─────────────────────────────────────────────────────────

/**
 * Close a page target by ID.
 * Uses CdpSession for reliable close-with-confirmation (not raw WebSocket).
 */
export async function closePageTarget(cdpHost: string, targetId: string): Promise<void> {
  try {
    const info = await getChromeInfo(cdpHost)
    const session = new CdpSession()
    await session.connect(info.browserWsUrl)
    await session.send('Target.closeTarget', { targetId })
    session.close()
  } catch (e) { console.warn("[@adhd/stealth-core-browser] Failed to run cdp closePageTarget:", e); }
}

/** Close ALL page targets (but not the browser itself). */
export async function closeAllPageTargets(cdpHost: string): Promise<void> {
  const targets = await listPageTargetsOnly(cdpHost)
  await Promise.allSettled(targets.map((t) => closePageTarget(cdpHost, t.id)))
}

/**
 * Minimize ALL Chrome windows. With --disable-backgrounding-occluded-windows,
 * JS timers are not throttled in minimized windows, so this is safe for
 * rendering pages and clearing Cloudflare managed challenges.
 */
export async function hideAllWindows(cdpHost: string): Promise<void> {
  try {
    const info = await getChromeInfo(cdpHost)
    const session = new CdpSession()
    await session.connect(info.browserWsUrl)
    const targets = await listPageTargetsOnly(cdpHost)
    for (const t of targets) {
      try {
        const { windowId } = await session.send<{ windowId: number }>('Browser.getWindowForTarget', { targetId: t.id })
        await session.send('Browser.setWindowBounds', {
          windowId,
          bounds: { windowState: 'minimized' },
        })
      } catch (e) { console.warn("[@adhd/stealth-core-browser] Failed to run hideAllWindows", e) }
    }
    session.close()
  } catch (e) { console.warn("[@adhd/stealth-core-browser] Failed to run hideAllWindows", e) }
}
