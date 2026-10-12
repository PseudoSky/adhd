import type { SystemInfo, ProcessInfo, ChromeMemoryCounters } from '../types.js'
import { cdpCall } from './transport.js'

export class SystemService {
  constructor(private readonly host: string) {}

  async getSystemInfo(): Promise<SystemInfo | null> {
    const result = await cdpCall<{
      gpu: { vendorString: string; deviceString: string; driverVersion: string }
      modelName: string
      modelVersion: string
      commandLine: string
    }>(this.host, 'SystemInfo.getInfo')
    if (!result) return null
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
    return result?.processInfo ?? []
  }

  async getMemoryCounters(): Promise<ChromeMemoryCounters | null> {
    const result = await cdpCall<{
      documents: number
      nodes: number
      jsEventListeners: number
      layouts: number
      recalcStyleCount: number
    }>(this.host, 'Memory.getDOMCounters')
    if (!result) return null
    return {
      documents: result.documents ?? 0,
      nodes: result.nodes ?? 0,
      jsEventListeners: result.jsEventListeners ?? 0,
      layouts: result.layouts ?? 0,
      recalcStyleCount: result.recalcStyleCount ?? 0,
    }
  }
}
