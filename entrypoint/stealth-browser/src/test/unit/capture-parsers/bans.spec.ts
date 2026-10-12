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

  it('never retries a success', () => {
    const d = decideRetry({ outcome: 'success' }, 0, base)
    expect(d).toEqual({ shouldRetry: false, delayMs: 0, reason: 'already succeeded' })
  })

  it('stops once attempt reaches maxAttempts (error path)', () => {
    const d = decideRetry({ outcome: 'error' }, 3, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('max attempts (3) reached')
  })

  it('hitl outcome retries immediately', () => {
    const d = decideRetry({ outcome: 'hitl' }, 1, base)
    expect(d).toMatchObject({ shouldRetry: true, delayMs: 0 })
  })

  it('captcha with onCaptcha=hitl retries with no delay', () => {
    const d = decideRetry({ outcome: 'captcha' }, 0, { ...base, onCaptcha: 'hitl' })
    expect(d).toMatchObject({ shouldRetry: true, delayMs: 0 })
    expect(d.reason).toContain('CAPTCHA')
  })

  it('captcha with onCaptcha=abort does not retry', () => {
    const d = decideRetry({ outcome: 'captcha' }, 0, { ...base, onCaptcha: 'abort' })
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('captcha: abort configured')
  })

  it('captcha with onCaptcha=retry backs off exponentially', () => {
    expect(decideRetry({ outcome: 'captcha' }, 0, base).delayMs).toBe(100)
    expect(decideRetry({ outcome: 'captcha' }, 2, base).delayMs).toBe(400)
  })

  it('rate_limited uses the 2.5x multiplier', () => {
    const d = decideRetry({ outcome: 'rate_limited' }, 2, base)
    expect(d.shouldRetry).toBe(true)
    expect(d.delayMs).toBe(Math.round(100 * 2.5 ** 2))
  })

  it('rate_limited with abort does not retry', () => {
    const d = decideRetry({ outcome: 'rate_limited' }, 0, { ...base, onRateLimit: 'abort' })
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('rate_limited: abort configured')
  })

  it('banned retries only under hitl', () => {
    expect(decideRetry({ outcome: 'banned' }, 0, { ...base, onBan: 'hitl' }).shouldRetry).toBe(true)
    const d = decideRetry({ outcome: 'banned' }, 0, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('banned: no retry')
  })

  it('timeout honours abort and otherwise backs off', () => {
    expect(decideRetry({ outcome: 'timeout' }, 0, { ...base, onTimeout: 'abort' }).shouldRetry).toBe(false)
    const d = decideRetry({ outcome: 'timeout' }, 1, base)
    expect(d).toMatchObject({ shouldRetry: true, delayMs: 200 })
  })

  it('empty and error outcomes retry with outcome-tagged reason', () => {
    expect(decideRetry({ outcome: 'empty' }, 0, base).reason).toBe('empty: retry attempt 1')
    expect(decideRetry({ outcome: 'error', error: 'boom' }, 1, base).reason).toBe('error: retry attempt 2')
  })

  it('unknown outcomes are not retried', () => {
    const d = decideRetry({ outcome: 'weird' }, 0, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toBe('unknown outcome: weird')
  })

  it('caps the delay at 30s and adds bounded jitter', () => {
    const huge = decideRetry({ outcome: 'error' }, 2, { ...base, maxAttempts: 10, baseDelayMs: 60_000 })
    expect(huge.delayMs).toBe(30_000)
    vi.spyOn(Math, 'random').mockReturnValue(1)
    const jittered = decideRetry({ outcome: 'error' }, 0, base)
    expect(jittered.delayMs).toBe(130)
  })
})

describe('8468f7b1 AC2 [tests-unit-extract.1] checkBans', () => {
  const rules: BanRule[] = [
    { name: 'url', signal: 'captcha', checkUrl: /\/sorry\// },
    { name: 'status', signal: 'rate_limited', checkStatus: [429, 503] },
    { name: 'body', signal: 'banned', checkBody: /access denied/i },
  ]
  const ok = { url: 'https://x.test/search', status: 200, body: 'fine' }

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
