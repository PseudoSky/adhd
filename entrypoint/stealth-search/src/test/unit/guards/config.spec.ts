/**
 * SearchHostConfig: typed defaults, derivation from the data dir and rejection of bad values;
 * two different configs coexist in one process because nothing is read from the environment.
 * Ticket 8468f7b1 · [search-port-guards.1] [search-port-guards.4]
 */
import { describe, expect, it } from 'vitest'
import { adhdDataDir } from '@adhd/resilience-core-tripwire'
import { DEFAULT_DATA_DIR, DEFAULT_SEARCH_HOST_CONFIG, createSearchHostConfig } from '../../../lib/config.js'
import type { InteractionPort } from '../../../lib/config.js'
import { createSearchGuard } from '../../../lib/guard.js'
import { createSearchTripwire } from '../../../lib/tripwire.js'
import { isSearchError } from '../../../errors.js'
import { fireInput, makeEnv } from './guards-harness.js'

describe('DEFAULT_SEARCH_HOST_CONFIG [search-port-guards.1]', () => {
  it('carries the spec defaults 7200000, 30000, 20000, 60000, 2 and 4', () => {
    const d = DEFAULT_SEARCH_HOST_CONFIG
    expect([d.tripwireTtlMs, d.cooldownCaptchaMs, d.cooldownRateMs, d.cooldownBannedMs, d.maxConcurrent, d.maxSiblings]).toEqual([7200000, 30000, 20000, 60000, 2, 4])
    expect(d.auditMaxBytes).toBe(5 * 1024 * 1024)
  })

  it('derives the data dir from adhdDataDir under ~/.adhd/reverse/data so the shared audit.log survives', () => {
    expect(DEFAULT_DATA_DIR).toBe(adhdDataDir(['reverse', 'data']))
    expect(DEFAULT_DATA_DIR.endsWith('/.adhd/reverse/data')).toBe(true)
    expect(DEFAULT_SEARCH_HOST_CONFIG.auditPath).toBe(`${DEFAULT_DATA_DIR}/audit.log`)
  })

  it('is frozen so no caller mutates the defaults', () => {
    expect(Object.isFrozen(DEFAULT_SEARCH_HOST_CONFIG)).toBe(true)
  })
})

describe('createSearchHostConfig [search-port-guards.1]', () => {
  it('moves the audit log with a dataDir override and keeps an explicit auditPath', () => {
    expect(createSearchHostConfig({ dataDir: '/x' }).auditPath).toBe('/x/audit.log')
    expect(createSearchHostConfig({ dataDir: '/x', auditPath: '/y/a.log' }).auditPath).toBe('/y/a.log')
    expect(createSearchHostConfig().auditPath).toBe(DEFAULT_SEARCH_HOST_CONFIG.auditPath)
  })

  it('ignores undefined overrides and lets maxConcurrent be zero or negative (cap disabled)', () => {
    expect(createSearchHostConfig({ maxConcurrent: undefined }).maxConcurrent).toBe(2)
    expect(createSearchHostConfig({ maxConcurrent: 0 }).maxConcurrent).toBe(0)
    expect(createSearchHostConfig({ maxConcurrent: -1 }).maxConcurrent).toBe(-1)
  })

  it.each([
    ['tripwireTtlMs', 0],
    ['cooldownRateMs', -5],
    ['maxSiblings', 1.5],
    ['auditMaxBytes', Number.NaN],
  ] as const)('rejects %s = %s with HOST_FLAG_INVALID naming the field', (field, value) => {
    try {
      createSearchHostConfig({ [field]: value })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isSearchError(e, 'HOST_FLAG_INVALID')).toBe(true)
      expect((e as { detail?: { field?: string } }).detail?.field).toBe(field)
    }
  })

  it('rejects an empty dataDir', () => {
    expect(() => createSearchHostConfig({ dataDir: ' ' })).toThrow(/dataDir/)
  })
})

describe('no environment is read: two SearchHostConfig values in one process [search-port-guards.4]', () => {
  it('keep independent cooldown durations, caps, data dirs and tripwire locks', async () => {
    const a = makeEnv({ dataDir: '/a', cooldownCaptchaMs: 1000, maxConcurrent: 1 })
    const b = makeEnv({ dataDir: '/b', cooldownCaptchaMs: 9000, maxConcurrent: 0 })
    await a.guard.recordSearchOutcome('github', 'captcha')
    await b.guard.recordSearchOutcome('github', 'captcha')
    expect((await a.guard.readProviderCooldown('github'))?.until).toBe(a.clock.now + 1000)
    expect((await b.guard.readProviderCooldown('github'))?.until).toBe(b.clock.now + 9000)
    expect(a.guard.searchConcurrencyInfo().max).toBe(1)
    expect(b.guard.searchConcurrencyInfo().max).toBe(0)
    await a.tripwire.fire(fireInput('github', 'captcha'))
    expect(await a.tripwire.isTripped('github')).toBe(true)
    expect(await b.tripwire.isTripped('github')).toBe(false)
  })

  it('shares nothing between two guards built over the same process-wide defaults', () => {
    const g1 = createSearchGuard(createSearchHostConfig({ dataDir: '/one', maxConcurrent: 3 }))
    const g2 = createSearchGuard(createSearchHostConfig({ dataDir: '/two', maxConcurrent: 5 }))
    expect([g1.searchConcurrencyInfo().max, g2.searchConcurrencyInfo().max]).toEqual([3, 5])
    expect(createSearchTripwire(createSearchHostConfig({ dataDir: '/one' }))).toBeDefined()
  })
})

describe('InteractionPort [search-port-guards.1]', () => {
  it('is implementable with a gate prompt and a solved confirmation', async () => {
    const port: InteractionPort = {
      promptTripwireGate: async () => 'retry',
      confirmSolved: async () => 'solved',
    }
    expect(await port.promptTripwireGate({ provider: 'g', reason: 'captcha', trippedAt: '', blockedCount: 0, pageUrl: '' })).toBe('retry')
    expect(await port.confirmSolved({ provider: 'g', reason: 'captcha', query: 'q', strategy: 'dom', pageUrl: '' })).toBe('solved')
  })
})
