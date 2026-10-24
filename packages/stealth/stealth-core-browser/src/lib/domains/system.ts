import type { SystemInfo, ProcessInfo, ChromeMemoryCounters } from '../types.js'
import { cdpCall, cdpPageCall, resolvePageTarget } from './transport.js'

/** SystemInfo and Memory reads. Memory.getDOMCounters is a page-session command (first open page unless a target is given). Failures throw a typed StealthCoreBrowserError. */
export class SystemService {
  constructor(private readonly host: string) {}

  async getSystemInfo(): Promise<SystemInfo> {
    const result = await cdpCall<{
      gpu: { vendorString: string; deviceString: string; driverVersion: string }
      modelName: string
      modelVersion: string
      commandLine: string
    }>(this.host, 'SystemInfo.getInfo')
    return {
      modelName: result.modelName ?? '',
      modelVersion: result.modelVersion ?? '',
      commandLine: result.commandLine ?? '',
      gpu: {
        vendor: result.gpu?.vendorString ?? '',
        device: result.gpu?.deviceString ?? '',
        driverVersion: result.gpu?.driverVersion ?? '',
      },
    }
  }

  async getProcessInfo(): Promise<ProcessInfo[]> {
    const result = await cdpCall<{ processInfo: ProcessInfo[] }>(this.host, 'SystemInfo.getProcessInfo')
    return result.processInfo ?? []
  }

  async getMemoryCounters(targetId?: string): Promise<ChromeMemoryCounters> {
    const result = await cdpPageCall<{
      documents: number
      nodes: number
      jsEventListeners: number
      layouts: number
      recalcStyleCount: number
    }>(this.host, await resolvePageTarget(this.host, targetId), 'Memory.getDOMCounters')
    return {
      documents: result.documents ?? 0,
      nodes: result.nodes ?? 0,
      jsEventListeners: result.jsEventListeners ?? 0,
      layouts: result.layouts ?? 0,
      recalcStyleCount: result.recalcStyleCount ?? 0,
    }
  }
}
