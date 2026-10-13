import type { CookieInfo } from '../types.js'
import { cdpCall } from './transport.js'

export class NetworkService {
  constructor(private readonly host: string) {}

  async getCookies(urls?: string[]): Promise<CookieInfo[]> {
    const result = await cdpCall<{ cookies: CookieInfo[] }>(this.host, 'Network.getCookies', urls ? { urls } : {})
    return result?.cookies ?? []
  }

  async getAllCookies(): Promise<CookieInfo[]> {
    const result = await cdpCall<{ cookies: CookieInfo[] }>(this.host, 'Network.getAllCookies')
    return result?.cookies ?? []
  }
}
