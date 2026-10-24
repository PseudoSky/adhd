import type { CdpTargetInfo } from '../types.js'
import { cdpJson } from '../cdp/targets.js'
import { StealthCoreBrowserError } from '../../errors.js'
import { cdpCall } from './transport.js'

/** Target-domain reads and activation. Failures throw a typed StealthCoreBrowserError (see docs/ERRORS.md). */
export class TargetService {
  constructor(private readonly host: string) {}

  async listPageTargets(): Promise<CdpTargetInfo[]> {
    const raw = await cdpJson(this.host, '/json/list')
    if (!Array.isArray(raw)) {
      throw StealthCoreBrowserError.of('CDP_BAD_RESPONSE', `CDP on ${this.host} returned a /json/list response that is not an array`, { detail: { cdpHost: this.host, reason: 'not-an-array' } })
    }
    return (raw as Record<string, unknown>[])
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

  /** Throws TARGET_NOT_FOUND when Chrome knows no such target. */
  async getTargetInfo(targetId: string): Promise<CdpTargetInfo> {
    return (await cdpCall<{ targetInfo: CdpTargetInfo }>(this.host, 'Target.getTargetInfo', { targetId })).targetInfo
  }

  /** Throws TARGET_NOT_FOUND when Chrome knows no such target. */
  async activateTarget(targetId: string): Promise<void> {
    await cdpCall(this.host, 'Target.activateTarget', { targetId })
  }
}
