import type { CookieInfo } from '../types.js'
import { cdpPageCall, resolvePageTarget } from './transport.js'

/**
 * Network-domain cookie reads. Network.* is served on a page session, not on the browser connection, so each
 * call attaches to a page (the given `targetId`, or the first open page) and reads the browser context that
 * page belongs to. With no open page the call fails with TARGET_NOT_FOUND; an empty array always means "no cookies".
 */
export class NetworkService {
  constructor(private readonly host: string) {}

  async getCookies(urls?: string[], targetId?: string): Promise<CookieInfo[]> {
    const result = await cdpPageCall<{ cookies: CookieInfo[] }>(this.host, await resolvePageTarget(this.host, targetId), 'Network.getCookies', urls ? { urls } : {})
    return result.cookies ?? []
  }

  async getAllCookies(targetId?: string): Promise<CookieInfo[]> {
    const result = await cdpPageCall<{ cookies: CookieInfo[] }>(this.host, await resolvePageTarget(this.host, targetId), 'Network.getAllCookies')
    return result.cookies ?? []
  }
}
