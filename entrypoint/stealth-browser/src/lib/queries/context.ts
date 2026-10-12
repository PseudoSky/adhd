import { CdpClient } from '../domains/index.js'
import { CookieClient } from '../storage/cookies.js'
import { HistoryClient } from '../storage/history.js'

export interface PageContext {
  targetId: string
  url: string
  title: string
  cookieCount: number
  hasHistory: boolean
  historyVisits: number
}

export async function getPageContext(targetId: string, cdpHost = '127.0.0.1:9222'): Promise<PageContext | null> {
  const cdp = new CdpClient(cdpHost)
  const targetInfo = await cdp.getTargetInfo(targetId)
  if (!targetInfo?.url) return null

  let cookieCount = 0
  let hasHistory = false
  let historyVisits = 0

  try {
    const cookies = new CookieClient().getCookies()
    const hostname = new URL(targetInfo.url).hostname
    cookieCount = cookies.filter((c) => c.host.includes(hostname)).length
  } catch { /* best effort */ }

  try {
    const info = new HistoryClient().getUrlInfo(targetInfo.url)
    if (info) {
      hasHistory = true
      historyVisits = info.visitCount
    }
  } catch { /* best effort */ }

  return {
    targetId,
    url: targetInfo.url,
    title: targetInfo.title,
    cookieCount,
    hasHistory,
    historyVisits,
  }
}
