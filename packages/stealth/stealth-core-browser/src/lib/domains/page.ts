import type { PageMetrics } from '../types.js'
import { cdpCall } from './transport.js'

export class PageService {
  constructor(private readonly host: string) {}

  async getNavigationHistory(targetId: string): Promise<{ currentIndex: number; entries: Array<{ id: number; url: string; title: string }> } | null> {
    const result = await cdpCall<{ currentIndex: number; entries: Array<{ id: number; url: string; title: string }> }>(
      this.host, 'Page.getNavigationHistory', { targetId },
    )
    return result ?? null
  }

  async getFrameTree(targetId: string): Promise<unknown | null> {
    const result = await cdpCall<{ frameTree: unknown }>(this.host, 'Page.getFrameTree', { targetId })
    return result?.frameTree ?? null
  }

  async getResourceTree(targetId: string): Promise<unknown | null> {
    const result = await cdpCall<{ frameTree: unknown }>(this.host, 'Page.getResourceTree', { targetId })
    return result?.frameTree ?? null
  }

  async getLayoutMetrics(targetId: string): Promise<unknown | null> {
    const result = await cdpCall(this.host, 'Page.getLayoutMetrics', { targetId })
    return result ?? null
  }

  async captureScreenshot(targetId: string, format: 'png' | 'jpeg' | 'webp' = 'png'): Promise<string | null> {
    const result = await cdpCall<{ data: string }>(this.host, 'Page.captureScreenshot', { targetId, format })
    return result?.data ?? null
  }

  async getPageMetrics(targetId: string): Promise<PageMetrics | null> {
    const result = await cdpCall<{ metrics: Array<{ name: string; value: number }> }>(this.host, 'Page.getMetrics', { targetId })
    if (!result?.metrics) return null
    const m = Object.fromEntries(result.metrics.map((e) => [e.name, e.value])) as Record<string, number>
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
