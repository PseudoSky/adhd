import type { ChromeVersion, BrowserWindowBounds } from '../types.js'
import { cdpCall } from './transport.js'

export class BrowserService {
  constructor(private readonly host: string) {}

  async getVersion(): Promise<ChromeVersion | null> {
    try {
      const res = await fetch(`http://${this.host}/json/version`)
      const v = (await res.json()) as Record<string, string>
      return {
        browserVersion: v['Browser'] ?? '',
        protocolVersion: v['Protocol-Version'] ?? '',
        userAgent: v['User-Agent'] ?? '',
        jsVersion: v['Js-Version'] ?? v['V8-Version'] ?? '',
        v8Version: v['V8-Version'] ?? v['Js-Version'] ?? '',
      }
    } catch {
      return null
    }
  }

  async getHistograms(query?: string): Promise<unknown[]> {
    const result = await cdpCall<{ histograms: unknown[] }>(this.host, 'Browser.getHistograms', query ? { query } : {})
    return result?.histograms ?? []
  }

  async getHistogram(name: string): Promise<unknown | null> {
    const result = await cdpCall<{ histogram: unknown }>(this.host, 'Browser.getHistogram', { name })
    return result?.histogram ?? null
  }

  async getWindowBounds(targetId: string): Promise<BrowserWindowBounds | null> {
    const result = await cdpCall<{ bounds: BrowserWindowBounds }>(this.host, 'Browser.getWindowBounds', { targetId })
    return result?.bounds ?? null
  }

  async getWindowForTarget(targetId: string): Promise<{ windowId: number; bounds: BrowserWindowBounds } | null> {
    const result = await cdpCall<{ windowId: number; bounds: BrowserWindowBounds }>(
      this.host, 'Browser.getWindowForTarget', { targetId },
    )
    return result ?? null
  }

  async getBrowserCommandLine(): Promise<string[]> {
    const result = await cdpCall<{ arguments: string[] }>(this.host, 'Browser.getBrowserCommandLine')
    return result?.arguments ?? []
  }
}
