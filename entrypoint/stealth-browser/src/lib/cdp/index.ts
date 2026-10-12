/**
 * @adhd/stealth-browser — src/lib/cdp public API
 *
 * A single, reusable package for managing Chrome via the Chrome DevTools
 * Protocol. Used by cdp-capture, scratch-agent-search, auth-middlewares,
 * and any other ADHD tool that needs browser automation.
 *
 * Usage:
 *   import { CdpSession, ensureChromeRunning, createPageTarget } from '@adhd/cdp-connection'
 *
 *   // 1. Ensure Chrome is running
 *   await ensureChromeRunning()
 *
 *   // 2. Create a page target
 *   const { pageWsUrl } = await createPageTarget('127.0.0.1:9222')
 *
 *   // 3. Connect and send CDP commands
 *   const session = new CdpSession()
 *   await session.connect(pageWsUrl)
 *   await session.send('Page.navigate', { url: 'https://example.com' })
 *   session.on('Network.requestWillBeSent', (params) => { ... })
 *   session.close()
 */

// ─── Session (WebSocket CDP connection) ─────────────────────────────────────────

export { CdpSession, rand, humanPause, shortPause } from './session.js'

// ─── Targets (pages: create, list, close) ───────────────────────────────────────

export {
  getChromeInfo,
  isChromeReachable,
  listPageTargets,
  listPageTargetsOnly,
  createPageTarget,
  createIsolatedPageTarget,
  closePageTarget,
  closeAllPageTargets,
  hideAllWindows,
} from './targets.js'
export type { PageTargetInfo, ChromeVersionInfo } from './targets.js'

// ─── Browser (Chrome process lifecycle) ─────────────────────────────────────────

export {
  launchChrome,
  ensureChromeRunning,
  killChrome,
  isChromeRunning,
} from './browser.js'
export type { LaunchChromeOptions } from './browser.js'

// ─── Settle (wait until a page stops changing) ──────────────────────────────────

export { awaitPageSettled } from './settle.js'
export type { SettleSignal, SettleResult, AwaitPageSettledOptions } from './settle.js'

// ─── Monitor (resource usage, watermarks, GC) ───────────────────────────────────

export {
  collectResourceUsage,
  checkWatermark,
  clearBrowserCache,
  formatResourceUsage,
} from './monitor.js'
export type { ResourceUsage, WatermarkThresholds, WatermarkResult } from './monitor.js'

// ─── Shutdown (idle-based auto-shutdown) ────────────────────────────────────────

export { IdleShutdown, createPageTargetIdleShutdown } from './shutdown.js'
export type { IdleShutdownOptions } from './shutdown.js'
