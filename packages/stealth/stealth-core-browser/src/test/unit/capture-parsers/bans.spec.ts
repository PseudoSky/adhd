/**
 * Unit spec for src/lib/capture/bans.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-extract.1] [tests-unit-extract.2] [tests-unit-extract.4].
 * Pure logic: no process, network or profile access.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkBans, decideRetry } from '../../../lib/capture/bans.js'
import type { BanRule, RetryConfig } from '../../../lib/types.js'

const base: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 100,
  onCaptcha: 'retry',
  onRateLimit: 'retry',
  onTimeout: 'retry',
  onBan: 'abort',
}

describe('8468f7b1 AC2 [tests-unit-extract.1] decideRetry', () => {
  beforeEach(() => {
    // jitter = random * 0.3 * delay; pin to 0 for exact delays
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('[fs-114] never retries a success', () => {
    const d = decideRetry({ outcome: 'success' }, 0, base)
    expect(d).toEqual({ shouldRetry: false, delayMs: 0, reason: 'already succeeded' })
    // even with attempts to spare and every policy set to retry
    expect(decideRetry({ outcome: 'success' }, 1, { ...base, onCaptcha: 'hitl' }).shouldRetry).toBe(false)
  })

  it('[fs-115] stops at the maximum attempts', () => {
    const d = decideRetry({ outcome: 'error' }, 3, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('max attempts (3) reached')
    expect(decideRetry({ outcome: 'error' }, 2, base).shouldRetry).toBe(true)
    // the cap applies before any per-outcome policy, including hitl
    expect(decideRetry({ outcome: 'captcha' }, 3, { ...base, onCaptcha: 'hitl' }).shouldRetry).toBe(false)
  })

  it('[fs-116] retries a hitl outcome immediately', () => {
    const d = decideRetry({ outcome: 'hitl' }, 1, base)
    expect(d).toMatchObject({ shouldRetry: true, delayMs: 0 })
    expect(d.reason).toContain('user solving')
  })

  it('[fs-117] applies the captcha policy', () => {
    const hitl = decideRetry({ outcome: 'captcha' }, 0, { ...base, onCaptcha: 'hitl' })
    expect(hitl).toMatchObject({ shouldRetry: true, delayMs: 0 })
    expect(hitl.reason).toContain('CAPTCHA')
    const abort = decideRetry({ outcome: 'captcha' }, 0, { ...base, onCaptcha: 'abort' })
    expect(abort.shouldRetry).toBe(false)
    expect(abort.reason).toBe('captcha: abort configured')
    expect(decideRetry({ outcome: 'captcha' }, 0, base).delayMs).toBe(100)
    expect(decideRetry({ outcome: 'captcha' }, 2, base).delayMs).toBe(400)
  })

  it('[fs-118] backs off harder when rate limited', () => {
    const d = decideRetry({ outcome: 'rate_limited' }, 2, base)
    expect(d.shouldRetry).toBe(true)
    expect(d.delayMs).toBe(Math.round(100 * 2.5 ** 2))
    const abort = decideRetry({ outcome: 'rate_limited' }, 0, { ...base, onRateLimit: 'abort' })
    expect(abort.shouldRetry).toBe(false)
    expect(abort.reason).toBe('rate_limited: abort configured')
  })

  it('[fs-119] does not retry a ban unless hitl is configured', () => {
    expect(decideRetry({ outcome: 'banned' }, 0, { ...base, onBan: 'hitl' })).toMatchObject({ shouldRetry: true, delayMs: 0 })
    const d = decideRetry({ outcome: 'banned' }, 0, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('banned: no retry')
  })

  it('[fs-120] retries timeouts empties and errors and refuses unknown outcomes', () => {
    expect(decideRetry({ outcome: 'timeout' }, 0, { ...base, onTimeout: 'abort' }).shouldRetry).toBe(false)
    expect(decideRetry({ outcome: 'timeout' }, 1, base)).toMatchObject({ shouldRetry: true, delayMs: 200 })
    expect(decideRetry({ outcome: 'empty' }, 0, base).reason).toMatch(/legitimate zero results/)
    expect(decideRetry({ outcome: 'error', error: 'boom' }, 1, base).reason).toBe('error: retry attempt 2')
    const d = decideRetry({ outcome: 'weird' }, 0, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('unknown outcome: weird')
  })

  it('[fs-121] backoff is exponential with jitter capped at 30 seconds', () => {
    expect(decideRetry({ outcome: 'error' }, 0, base).delayMs).toBe(100)
    expect(decideRetry({ outcome: 'error' }, 2, base).delayMs).toBe(400)
    const huge = decideRetry({ outcome: 'error' }, 2, { ...base, maxAttempts: 10, baseDelayMs: 60_000 })
    expect(huge.delayMs).toBe(30_000)
    vi.spyOn(Math, 'random').mockReturnValue(1)
    expect(decideRetry({ outcome: 'error' }, 0, base).delayMs).toBe(130)
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    expect(decideRetry({ outcome: 'error' }, 0, base).delayMs).toBe(115)
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] checkBans', () => {
  const rules: BanRule[] = [
    { name: 'url', signal: 'captcha', checkUrl: /\/sorry\// },
    { name: 'status', signal: 'rate_limited', checkStatus: [429, 503] },
    { name: 'body', signal: 'banned', checkBody: /access denied/i },
  ]
  const ok = { url: 'https://x.test/search', status: 200, body: 'fine' }

  it('[fs-122] returns the first matching ban signal', () => {
    expect(checkBans(rules, { url: 'https://x.test/sorry/', status: 429, body: 'access denied' })).toBe('captcha')
    expect(checkBans(rules, { ...ok, status: 503, body: 'access denied' })).toBe('rate_limited')
  })

  it('returns null when no rule matches', () => {
    expect(checkBans(rules, ok)).toBeNull()
  })

  it('returns null for an empty rule list', () => {
    expect(checkBans([], ok)).toBeNull()
  })

  it('matches on url, status and body', () => {
    expect(checkBans(rules, { ...ok, url: 'https://x.test/sorry/index' })).toBe('captcha')
    expect(checkBans(rules, { ...ok, status: 429 })).toBe('rate_limited')
    expect(checkBans(rules, { ...ok, body: 'ACCESS DENIED' })).toBe('banned')
  })

  it('first matching rule wins', () => {
    expect(checkBans(rules, { url: 'https://x.test/sorry/', status: 429, body: 'access denied' })).toBe('captcha')
  })
})
