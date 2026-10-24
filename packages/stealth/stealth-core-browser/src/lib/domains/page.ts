import type { PageMetrics } from '../types.js'
import { cdpPageCall, cdpPageSession } from './transport.js'

/** Page-domain commands. Each attaches a page session to the target; none sends a targetId as a parameter. Failures throw a typed StealthCoreBrowserError. */
export class PageService {
  constructor(private readonly host: string) {}

  async getNavigationHistory(targetId: string): Promise<{ currentIndex: number; entries: Array<{ id: number; url: string; title: string }> }> {
    return cdpPageCall(this.host, targetId, 'Page.getNavigationHistory')
  }

  async getFrameTree(targetId: string): Promise<unknown> {
    return (await cdpPageCall<{ frameTree: unknown }>(this.host, targetId, 'Page.getFrameTree')).frameTree
  }

  async getResourceTree(targetId: string): Promise<unknown> {
    return (await cdpPageCall<{ frameTree: unknown }>(this.host, targetId, 'Page.getResourceTree')).frameTree
  }

  async getLayoutMetrics(targetId: string): Promise<unknown> {
    return cdpPageCall(this.host, targetId, 'Page.getLayoutMetrics')
  }

  async captureScreenshot(targetId: string, format: 'png' | 'jpeg' | 'webp' = 'png'): Promise<string> {
    return (await cdpPageCall<{ data: string }>(this.host, targetId, 'Page.captureScreenshot', { format })).data
  }

  /** Reads the Performance domain (Chrome serves no Page.getMetrics): enable, read, disable on one session. */
  async getPageMetrics(targetId: string): Promise<PageMetrics> {
    const result = await cdpPageSession(this.host, targetId, async (send) => {
      await send('Performance.enable')
      try {
        return await send<{ metrics: Array<{ name: string; value: number }> }>('Performance.getMetrics')
      } finally {
        await send('Performance.disable').catch(() => undefined)
      }
    })
    const m = Object.fromEntries((result.metrics ?? []).map((e) => [e.name, e.value])) as Record<string, number>
    return {
      timestamp: m['Timestamp'] ?? 0,
      documents: m['Documents'] ?? 0,
      nodes: m['Nodes'] ?? 0,
      jsHeapUsedSize: m['JSHeapUsedSize'] ?? 0,
      jsHeapTotalSize: m['JSHeapTotalSize'] ?? 0,
      navigationStart: m['NavigationStart'] ?? 0,
      domContentLoaded: m['DomContentLoaded'] ?? 0,
      firstMeaningfulPaint: m['FirstMeaningfulPaint'] ?? 0,
      layoutCount: m['LayoutCount'] ?? 0,
      scriptDuration: m['ScriptDuration'] ?? 0,
      taskDuration: m['TaskDuration'] ?? 0,
    }
  }
}
