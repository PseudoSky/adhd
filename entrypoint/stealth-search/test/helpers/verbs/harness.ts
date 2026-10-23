/**
 * Shared harness of the verbs unit lane: a fake core (Chrome, pages and the clock are all in
 * memory), scripted engines, the tripwire package's in-memory fs and the REAL guard, tripwire and
 * orchestration over them. Nothing here opens a socket, spawns a process or touches a real Chrome;
 * port 9222 is never contacted.
 * Fixtures are labelled synthetic-protocol-conformant. Ticket 8468f7b1 · [search-verbs.4]
 */
import { createMemoryFs } from '@adhd/resilience-core-tripwire'
import type { MemoryFs } from '@adhd/resilience-core-tripwire'
import type { SearchInput } from '../../../src/api.js'
import type { InteractionPort, SearchHostConfig } from '../../../src/lib/config.js'
import { createSearchService } from '../../../src/lib/search.js'
import type { SearchCore, SearchDeps, SearchPage, SearchService } from '../../../src/lib/search.js'
import type { FetchDeps } from '../../../src/lib/fetch/fetch.js'
import type { EngineDeps } from '../../../src/lib/network.js'
import type { HitlInfo, SearchResponse } from '../../../src/lib/types.js'

export const T0 = Date.parse('2026-10-21T10:00:00.000Z')

// ─── The fake core ───────────────────────────────────────────────────────────

export interface FakePage extends SearchPage {
  revealed: number
  disposed: number
}

export interface FakeCore {
  core: SearchCore
  /** Calls to `ensureChrome` (the managed Chrome was asked to be ready). */
  ensured: number
  /** Calls to `noteActivity`. */
  noted: number
  /** Every page opened, in order, with the options it was opened with. */
  opened: Array<{ cdpHost: string; foreground: boolean; sharedProfile: boolean }>
  pages: FakePage[]
  navigations: Array<{ pageWsUrl: string; url: string }>
  /** Pages open right now, and the most that were ever open together. */
  live: number
  maxLive: number
  /** The chronological event log shared with the interaction port, for call-order assertions. */
  order: string[]
  /** Make the next `openPage` calls fail with this error. */
  failOpen?: Error
}

export function makeFakeCore(order: string[] = []): FakeCore {
  const fake: FakeCore = { core: undefined as unknown as SearchCore, ensured: 0, noted: 0, opened: [], pages: [], navigations: [], live: 0, maxLive: 0, order }
  fake.core = {
    ensureChrome: async () => {
      fake.ensured++
    },
    noteActivity: () => {
      fake.noted++
    },
    openPage: async (cdpHost, options) => {
      if (fake.failOpen) throw fake.failOpen
      fake.opened.push({ cdpHost, ...options })
      const n = fake.pages.length + 1
      const page: FakePage = {
        targetId: `tab-${n}`,
        pageWsUrl: `ws://fake/page/${n}`,
        revealed: 0,
        disposed: 0,
        reveal: async () => {
          page.revealed++
          fake.order.push('reveal')
        },
        dispose: async () => {
          page.disposed++
          if (page.disposed === 1) fake.live--
          fake.order.push('dispose')
        },
      }
      fake.pages.push(page)
      fake.live++
      fake.maxLive = Math.max(fake.maxLive, fake.live)
      return page
    },
    navigate: async (pageWsUrl, url) => {
      fake.navigations.push({ pageWsUrl, url })
      fake.order.push(`navigate:${url}`)
    },
  }
  return fake
}

// ─── Scripted engine responses ───────────────────────────────────────────────

/** An engine response; every field has a sensible default for provider github / outcome success. */
export function response(partial: Partial<SearchResponse> = {}): SearchResponse {
  const outcome = partial.outcome ?? 'success'
  const results = partial.results ?? (outcome === 'success' ? [{ title: 'vitejs/vite', url: 'https://github.com/vitejs/vite', snippet: 'Next generation frontend tooling' }] : [])
  return {
    provider: 'github',
    query: 'vite',
    count: results.length,
    results,
    outcome,
    tookMs: 5,
    attempts: 1,
    strategy: 'network',
    ...partial,
  }
}

export function hitlResponse(reason: HitlInfo['reason'], pageUrl = 'https://github.com/login?return_to=x', partial: Partial<SearchResponse> = {}): SearchResponse {
  return response({
    outcome: 'hitl',
    error: `Challenge detected: ${reason}`,
    hitl: { pageUrl, reason, provider: 'github', query: 'vite', trippedAt: new Date(T0).toISOString(), strategy: 'network' },
    ...partial,
  })
}

export interface EngineCall {
  pageWsUrl: string
  provider: string
  query: string
  options: Parameters<SearchDeps['strategies']>[3]
}

/** A scripted engine: the nth call answers with the nth script entry (the last repeats). Records every call. */
export function scriptedEngine(...script: Array<SearchResponse | ((call: EngineCall, n: number) => Promise<SearchResponse> | SearchResponse)>): {
  strategies: SearchDeps['strategies']
  calls: EngineCall[]
} {
  const calls: EngineCall[] = []
  return {
    calls,
    strategies: async (page, provider, query, options) => {
      const call: EngineCall = { pageWsUrl: page.pageWsUrl, provider: provider.id, query, options: options ?? {} }
      calls.push(call)
      const entry = script[Math.min(calls.length - 1, script.length - 1)]
      if (entry === undefined) return response({ provider: provider.id, query })
      const out = typeof entry === 'function' ? await entry(call, calls.length - 1) : entry
      return { ...out, results: [...out.results] }
    },
  }
}

// ─── The world ───────────────────────────────────────────────────────────────

export interface WorldParts {
  strategies?: SearchDeps['strategies']
  engine?: Partial<EngineDeps>
  fetch?: Partial<FetchDeps>
  interaction?: InteractionPort
  config?: Partial<SearchHostConfig>
  core?: FakeCore
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** A wrapper over the memory fs, to count state I/O. */
  wrapFs?: (fs: MemoryFs) => MemoryFs
}

export interface World {
  svc: SearchService
  core: FakeCore
  fs: MemoryFs
  clock: { now: number }
  sleeps: number[]
  logs: string[]
  order: string[]
}

/** The search service over the fake core and a memory fs; sleeps are recorded, not waited. */
export function makeWorld(parts: WorldParts = {}): World {
  const order = parts.core?.order ?? []
  const core = parts.core ?? makeFakeCore(order)
  const clock = { now: T0 }
  const fs = createMemoryFs({ clock: () => clock.now })
  const sleeps: number[] = []
  const logs: string[] = []
  const deps: Partial<SearchDeps> = {
    core: core.core,
    sleep: parts.sleep ?? (async (ms) => {
      sleeps.push(ms)
    }),
    now: parts.now ?? (() => Date.now()),
    log: (m) => {
      logs.push(m)
    },
    ...(parts.strategies ? { strategies: parts.strategies } : {}),
    ...(parts.engine ? { engine: parts.engine } : {}),
    ...(parts.fetch ? { fetch: parts.fetch } : {}),
  }
  const svc = createSearchService({
    ...(parts.interaction ? { interaction: parts.interaction } : {}),
    config: { dataDir: '/data', sessionId: 'sess-1', fs: parts.wrapFs ? parts.wrapFs(fs) : fs, clock: () => clock.now, ...parts.config },
    deps,
  })
  return { svc, core, fs, clock, sleeps, logs, order }
}

/** A recording interaction port; `solved` answers confirmSolved, `gate` answers the tripwire prompt. */
export function recordingInteraction(order: string[], answers: { solved?: 'solved' | 'abort' | Error; gate?: 'retry' | 'clear' | 'abort' | Error } = {}): InteractionPort & { solvedCalls: unknown[]; gateCalls: unknown[] } {
  const solvedCalls: unknown[] = []
  const gateCalls: unknown[] = []
  return {
    solvedCalls,
    gateCalls,
    confirmSolved: async (info) => {
      order.push('confirmSolved')
      solvedCalls.push(info)
      const a = answers.solved ?? 'solved'
      if (a instanceof Error) throw a
      return a
    },
    promptTripwireGate: async (info) => {
      order.push('promptTripwireGate')
      gateCalls.push(info)
      const a = answers.gate ?? 'clear'
      if (a instanceof Error) throw a
      return a
    },
  }
}

export const input = (partial: Partial<SearchInput> = {}): SearchInput => ({ provider: 'github', query: 'vite', ...partial })

/** An fs whose every call is counted (state I/O), over the same memory fs. */
export function countingFs(fs: MemoryFs): { fs: MemoryFs; count: () => number } {
  let n = 0
  const handler: ProxyHandler<MemoryFs> = {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      return (...args: unknown[]) => {
        n++
        return (v as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  }
  return { fs: new Proxy(fs, handler), count: () => n }
}
