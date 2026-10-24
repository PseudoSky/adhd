import type { ChromeVersion, BrowserWindowBounds } from '../types.js'
import { getRawVersion } from '../cdp/targets.js'
import { cdpBrowserSession, cdpCall } from './transport.js'

/** Browser-domain commands. Failures throw a typed StealthCoreBrowserError (see docs/ERRORS.md). */
export class BrowserService {
  constructor(private readonly host: string) {}

  async getVersion(): Promise<ChromeVersion> {
    const v = await getRawVersion(this.host)
    return {
      browserVersion: v['Browser'] ?? '',
      protocolVersion: v['Protocol-Version'] ?? '',
      userAgent: v['User-Agent'] ?? '',
      jsVersion: v['Js-Version'] ?? v['V8-Version'] ?? '',
      v8Version: v['V8-Version'] ?? v['Js-Version'] ?? '',
    }
  }

  async getHistograms(query?: string): Promise<unknown[]> {
    return (await cdpCall<{ histograms: unknown[] }>(this.host, 'Browser.getHistograms', query ? { query } : {})).histograms ?? []
  }

  async getHistogram(name: string): Promise<unknown> {
    return (await cdpCall<{ histogram: unknown }>(this.host, 'Browser.getHistogram', { name })).histogram
  }

  /** Browser.getWindowBounds takes a windowId, so the target's window is resolved first (Browser.getWindowForTarget) on the same connection. */
  async getWindowBounds(targetId: string): Promise<BrowserWindowBounds> {
    return cdpBrowserSession(this.host, async (send) => {
      const { windowId } = await send<{ windowId: number }>('Browser.getWindowForTarget', { targetId })
      return (await send<{ bounds: BrowserWindowBounds }>('Browser.getWindowBounds', { windowId })).bounds
    })
  }

  async getWindowForTarget(targetId: string): Promise<{ windowId: number; bounds: BrowserWindowBounds }> {
    return cdpCall(this.host, 'Browser.getWindowForTarget', { targetId })
  }

  async getBrowserCommandLine(): Promise<string[]> {
    return (await cdpCall<{ arguments: string[] }>(this.host, 'Browser.getBrowserCommandLine')).arguments ?? []
  }
}
