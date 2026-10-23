/**
 * Shared harness of the guard specs: the tripwire package's in-memory fs, a controllable clock
 * and the real guard and tripwire wiring over them (no mocks of the code under test).
 * Ticket 8468f7b1 · [search-port-guards.3]
 */
import { createMemoryFs } from '@adhd/resilience-core-tripwire'
import type { MemoryFs } from '@adhd/resilience-core-tripwire'
import { createSearchHostConfig } from '../../../src/lib/config.js'
import type { SearchHostConfig } from '../../../src/lib/config.js'
import { createSearchGuard } from '../../../src/lib/guard.js'
import type { SearchGuard } from '../../../src/lib/guard.js'
import { createSearchTripwire } from '../../../src/lib/tripwire.js'
import type { FireInput, SearchTripwire } from '../../../src/lib/tripwire.js'

export interface Env {
  fs: MemoryFs
  clock: { now: number }
  config: SearchHostConfig
  guard: SearchGuard
  tripwire: SearchTripwire
}

export const T0 = Date.parse('2026-10-21T10:00:00.000Z')

/** A guard and tripwire pair over a fresh memory fs rooted at `dataDir` (default `/data`). */
export function makeEnv(overrides: Partial<SearchHostConfig> = {}): Env {
  const clock = { now: T0 }
  const fs = createMemoryFs({ clock: () => clock.now })
  const config = createSearchHostConfig({ dataDir: '/data', sessionId: 'sess-1', fs, clock: () => clock.now, ...overrides })
  return { fs, clock, config, guard: createSearchGuard(config), tripwire: createSearchTripwire(config) }
}

export function fireInput(provider: string, reason: string, extra: Partial<FireInput> = {}): FireInput {
  return {
    provider,
    query: 'q',
    reason,
    pageUrl: `https://${provider}.example/search?q=secret`,
    strategy: 'dom',
    browserSessionId: 'tab-1',
    lastOperation: `https://${provider}.example/search`,
    ...extra,
  }
}

/** The audit lines of an env, parsed. */
export function auditLines(env: Env): Array<Record<string, unknown>> {
  const text = env.fs.readText(env.config.auditPath)
  if (text === undefined) return []
  return text.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>)
}
