import { TargetService } from './target.js'
import { BrowserService } from './browser.js'
import { PageService } from './page.js'
import { NetworkService } from './network.js'
import { SystemService } from './system.js'
import type { CdpTargetInfo, ChromeVersion, BrowserWindowBounds, PageMetrics, SystemInfo, ProcessInfo, ChromeMemoryCounters } from '../types.js'

/** Facade over the domain services. Every method throws a typed StealthCoreBrowserError on failure (docs/ERRORS.md); none returns null to mean "failed". */
export class CdpClient {
  readonly target: TargetService
  readonly browser: BrowserService
  readonly page: PageService
  readonly network: NetworkService
  readonly system: SystemService

  constructor(host = '127.0.0.1:9222') {
    this.target = new TargetService(host)
    this.browser = new BrowserService(host)
    this.page = new PageService(host)
    this.network = new NetworkService(host)
    this.system = new SystemService(host)
  }

  async getVersion(): Promise<ChromeVersion> { return this.browser.getVersion() }
  async listPageTargets(): Promise<CdpTargetInfo[]> { return this.target.listPageTargets() }
  async countActivePages(): Promise<number> { return this.target.countActivePages() }
  async getTargetInfo(targetId: string): Promise<CdpTargetInfo> { return this.target.getTargetInfo(targetId) }
  async activateTarget(targetId: string): Promise<void> { return this.target.activateTarget(targetId) }

  async getHistograms(query?: string): Promise<unknown[]> { return this.browser.getHistograms(query) }
  async getHistogram(name: string): Promise<unknown> { return this.browser.getHistogram(name) }
  async getWindowBounds(targetId: string): Promise<BrowserWindowBounds> { return this.browser.getWindowBounds(targetId) }
  async getWindowForTarget(targetId: string): Promise<{ windowId: number; bounds: BrowserWindowBounds }> { return this.browser.getWindowForTarget(targetId) }
  async getBrowserCommandLine(): Promise<string[]> { return this.browser.getBrowserCommandLine() }

  async getNavigationHistory(targetId: string): Promise<unknown> { return this.page.getNavigationHistory(targetId) }
  async getFrameTree(targetId: string): Promise<unknown> { return this.page.getFrameTree(targetId) }
  async getResourceTree(targetId: string): Promise<unknown> { return this.page.getResourceTree(targetId) }
  async getLayoutMetrics(targetId: string): Promise<unknown> { return this.page.getLayoutMetrics(targetId) }
  async captureScreenshot(targetId: string, format?: 'png' | 'jpeg' | 'webp'): Promise<string> { return this.page.captureScreenshot(targetId, format) }
  async getPageMetrics(targetId: string): Promise<PageMetrics> { return this.page.getPageMetrics(targetId) }

  async getCookies(urls?: string[], targetId?: string): Promise<unknown[]> { return this.network.getCookies(urls, targetId) }
  async getAllCookies(targetId?: string): Promise<unknown[]> { return this.network.getAllCookies(targetId) }

  async getSystemInfo(): Promise<SystemInfo> { return this.system.getSystemInfo() }
  async getProcessInfo(): Promise<ProcessInfo[]> { return this.system.getProcessInfo() }
  async getMemoryCounters(targetId?: string): Promise<ChromeMemoryCounters> { return this.system.getMemoryCounters(targetId) }
}
