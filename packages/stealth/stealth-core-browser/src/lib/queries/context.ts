import { CdpClient } from '../domains/index.js'
import type { CdpTargetInfo } from '../types.js'
import { StealthCoreBrowserError } from '../../errors.js'
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

export async function getPageContext(targetId: string, cdpHost = '127.0.0.1:9222', profileDir?: string): Promise<PageContext | null> {
  const cdp = new CdpClient(cdpHost)
  let targetInfo: CdpTargetInfo
  try {
    targetInfo = await cdp.getTargetInfo(targetId)
  } catch (err) {
    // A target Chrome no longer knows has no context; every other failure (Chrome down, bad answer) propagates typed.
    if (err instanceof StealthCoreBrowserError && err.code === 'TARGET_NOT_FOUND') return null
    throw err
  }
  if (!targetInfo.url) return null

  let cookieCount = 0
  let hasHistory = false
  let historyVisits = 0

  try {
    const hostname = new URL(targetInfo.url).hostname
    cookieCount = new CookieClient(profileDir).getCookiesForHostname(hostname).length
  } catch { /* best effort */ }

  try {
    const info = new HistoryClient(profileDir).getUrlInfo(targetInfo.url)
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
