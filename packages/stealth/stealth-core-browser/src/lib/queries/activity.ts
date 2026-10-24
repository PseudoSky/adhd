import { CdpClient } from '../domains/index.js'
import { HistoryClient } from '../storage/history.js'
import { isActiveWebTarget } from '../lifecycle/page-tier.js'
import type { CdpTargetInfo, ChromeVisit, ChromeActivity } from '../types.js'

export async function checkChromeActivity(
  cdpHost = '127.0.0.1:9222',
  withinMinutes = 2,
  profileDir?: string,
): Promise<ChromeActivity> {
  const cdp = new CdpClient(cdpHost)
  const history = new HistoryClient(profileDir)

  let pages: CdpTargetInfo[] = []
  try { pages = await cdp.listPageTargets() } catch (e) { console.warn('[activity] CDP unreachable:', (e as Error).message) }

  let lastVisit: ChromeVisit | null = null
  try { lastVisit = history.getLastVisit() } catch (e) { console.warn('[activity] history unavailable:', (e as Error).message) }

  // The same rule the idle reaper applies: only a real web document counts as use. chrome://newtab/ (the default
  // window), about:blank, devtools:// and extension pages do not.
  const active = pages.filter((p) => isActiveWebTarget(p.url))
  const recentlyUsed = lastVisit
    ? (Date.now() - lastVisit.visitTime.getTime()) < withinMinutes * 60 * 1000
    : false

  return {
    activePages: active.length,
    pageTargets: active.map((p) => p.targetId),
    lastVisit,
    recentlyUsed,
    meta: {
      checkedAt: new Date().toISOString(),
      cdpHost,
      profileDir: history.path.replace('/Default/History', ''),
    },
  }
}
