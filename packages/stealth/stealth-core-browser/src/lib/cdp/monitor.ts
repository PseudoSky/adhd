/**
 * @adhd/stealth-core-browser — src/lib/cdp/monitor.ts
 *
 * Runtime resource monitoring via CDP.
 *
 * Collects memory (RSS from SystemInfo.getProcessInfo, JS heap from
 * Performance.getMetrics), CPU info (model from CDP, cores from os.cpus()),
 * and storage usage from the Chrome instance.
 *
 * Platform note: Chromium CDP on macOS may not expose privateMemory in
 * getProcessInfo. RSS_Mb will be 0 in that case — this is a CDP platform
 * limitation, not a bug. Page-level Performance.getMetrics requires a
 * page session (not browser session) for heap data.
 */

import type { CdpSession } from './session.js'
import { cpus } from 'node:os'

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ResourceUsage {
  /** Resident set size in MB. May be 0 on macOS (CDP platform limitation). */
  rssMb: number
  /** JS heap used in MB (from Performance.getMetrics on a page session). */
  heapUsedMb: number
  /** JS heap total in MB. */
  heapTotalMb: number
  cpuInfo: {
    modelName: string
    /** Core count from os.cpus() — always reliable. */
    cores: number
  }
  storage: { cacheBytes: number; localStorageBytes: number; sessionStorageBytes: number }
  performance: { domNodes: number; eventListeners: number; jsHeapSize: number }
}

export interface WatermarkThresholds {
  maxRssMb?: number      // Default 500
  maxHeapMb?: number     // Default 300
  maxCacheMb?: number    // Default 100
}

export interface WatermarkResult {
  overMemory: boolean
  overCache: boolean
  shouldRestart: boolean
  usage: ResourceUsage
}

// ─── Collection ───────────────────────────────────────────────────────────────

/**
 * Collect resource usage from Chrome.
 *
 * @param browserSession — browser-level CDP session (for SystemInfo).
 * @param pageSession — optional page-level CDP session (for Performance metrics).
 *   If omitted, heap values will be 0.
 */
export async function collectResourceUsage(
  browserSession: CdpSession,
  pageSession?: CdpSession,
): Promise<ResourceUsage> {
  let rssMb = 0
  let heapUsedMb = 0
  let heapTotalMb = 0
  let modelName = ''
  let domNodes = 0
  let eventListeners = 0
  const jsHeapSize = 0

  // SystemInfo.getProcessInfo — per-process memory (privateMemory may be 0 on macOS)
  try {
    const pi = await browserSession.send<{ processInfo: Array<Record<string, unknown>> }>('SystemInfo.getProcessInfo')
    for (const p of pi.processInfo ?? []) {
      rssMb += ((p as { privateMemory?: number }).privateMemory ?? 0) / (1024 * 1024)
    }
  } catch { /* non-fatal */ }

  // SystemInfo.getInfo — model name
  try {
    const si = await browserSession.send<{ modelName: string }>('SystemInfo.getInfo')
    modelName = si.modelName ?? ''
  } catch { /* non-fatal */ }

  // Core count from Node.js (always reliable, CDP doesn't expose it)
  const cores = cpus().length

  // Page-level metrics for heap + DOM stats
  if (pageSession) {
    try {
      const m = await pageSession.send<{ metrics: Array<{ name: string; value: number }> }>('Performance.getMetrics')
      for (const metric of m.metrics ?? []) {
        switch (metric.name) {
          case 'JSHeapUsedSize': heapUsedMb = metric.value / (1024 * 1024); break
          case 'JSHeapTotalSize': heapTotalMb = metric.value / (1024 * 1024); break
          case 'DomNodes': domNodes = metric.value; break
          case 'EventListeners': eventListeners = metric.value; break
        }
      }
    } catch { /* non-fatal */ }
  }

  return {
    rssMb: Math.round(rssMb * 100) / 100,
    heapUsedMb: Math.round(heapUsedMb * 100) / 100,
    heapTotalMb: Math.round(heapTotalMb * 100) / 100,
    cpuInfo: { modelName, cores },
    storage: { cacheBytes: 0, localStorageBytes: 0, sessionStorageBytes: 0 },
    performance: { domNodes, eventListeners, jsHeapSize },
  }
}

// ─── Watermarks ───────────────────────────────────────────────────────────────

export function checkWatermark(
  usage: ResourceUsage,
  thresholds: WatermarkThresholds = {},
): WatermarkResult {
  const maxRss = thresholds.maxRssMb ?? 500
  const maxHeap = thresholds.maxHeapMb ?? 300
  const maxCache = thresholds.maxCacheMb ?? 100

  const overMemory = usage.rssMb > maxRss || usage.heapUsedMb > maxHeap
  const overCache = usage.storage.cacheBytes > maxCache * 1024 * 1024
  const shouldRestart = overMemory

  return { overMemory, overCache, shouldRestart, usage }
}

// ─── GC ───────────────────────────────────────────────────────────────────────

/**
 * Clear browser cache storage to free memory.
 * Requires a page-level session (Storage.* and Network.* are page-scoped).
 */
export async function clearBrowserCache(pageSession: CdpSession): Promise<void> {
  await Promise.allSettled([
    pageSession.send('Storage.clearDataForOrigin', { origin: '*', storageTypes: 'cache_storage' }),
    pageSession.send('Network.clearBrowserCache'),
  ])
}

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatResourceUsage(usage: ResourceUsage): string {
  return [
    `RSS: ${usage.rssMb.toFixed(0)}MB`,
    `heap: ${usage.heapUsedMb.toFixed(0)}/${usage.heapTotalMb.toFixed(0)}MB`,
    `DOM: ${usage.performance.domNodes} nodes`,
    `CPU: ${usage.cpuInfo.modelName} (${usage.cpuInfo.cores} cores)`,
  ].join(' | ')
}
