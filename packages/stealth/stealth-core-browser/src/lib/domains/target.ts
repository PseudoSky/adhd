import type { CdpTargetInfo } from '../types.js'
import { cdpCall } from './transport.js'

export class TargetService {
  constructor(private readonly host: string) {}

  async listPageTargets(): Promise<CdpTargetInfo[]> {
    const res = await fetch(`http://${this.host}/json/list`)
    const raw = (await res.json()) as Record<string, unknown>[]
    return raw
      .filter((t) => t['type'] === 'page')
      .map((t) => ({
        targetId: t['id'] as string,
        type: 'page' as const,
        title: t['title'] as string,
        url: t['url'] as string,
        attached: (t['webSocketDebuggerUrl'] as string | undefined) != null,
      }))
  }

  async countActivePages(): Promise<number> {
    const pages = await this.listPageTargets()
    return pages.filter((p) => p.url && p.url !== 'about:blank').length
  }

  async getTargetInfo(targetId: string): Promise<CdpTargetInfo | null> {
    const result = await cdpCall<{ targetInfo: CdpTargetInfo }>(this.host, 'Target.getTargetInfo', { targetId })
    return result?.targetInfo ?? null
  }

  async activateTarget(targetId: string): Promise<boolean> {
    const result = await cdpCall(this.host, 'Target.activateTarget', { targetId })
    return result !== null
  }
}
