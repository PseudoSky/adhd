/**
 * A parsed zero-result page is never retried; transport failures are.
 * Ticket 8468f7b1 · [core-seam.10] · commit c00edea (delta report row 18).
 * Pure decision function: no I/O.
 */
import { describe, expect, it } from 'vitest'
import { decideRetry } from '../../../lib/capture/bans.js'

import type { RetryConfig } from '../../../lib/types.js'

const base: RetryConfig = { maxAttempts: 3, baseDelayMs: 100, onCaptcha: 'retry', onRateLimit: 'retry', onTimeout: 'retry', onBan: 'abort' }
const MAX = base.maxAttempts

describe('8468f7b1 [core-seam.10] decideRetry outcomes (commit c00edea)', () => {
  it.each([0, 1, MAX])('decideRetry({ outcome: empty }) at attempt %i is not retried: legitimate zero results (c00edea)', (attempt) => {
    const d = decideRetry({ outcome: 'empty' }, attempt, base)
    expect(d.shouldRetry).toBe(false)
    expect(d.reason).toMatch(/legitimate zero results/)
  })

  it('an error outcome is retried (c00edea)', () => {
    expect(decideRetry({ outcome: 'error', error: 'boom' }, 0, base)).toMatchObject({ shouldRetry: true, reason: 'error: retry attempt 1' })
  })

  it('a timeout outcome is retried (c00edea)', () => {
    expect(decideRetry({ outcome: 'timeout' }, 0, base)).toMatchObject({ shouldRetry: true, reason: 'timeout: retry attempt 1' })
  })

  it("onTimeout: 'abort' aborts a timeout, it is not retried (c00edea)", () => {
    const d = decideRetry({ outcome: 'timeout' }, 0, { ...base, onTimeout: 'abort' })
    expect(d).toMatchObject({ shouldRetry: false, reason: 'timeout: abort configured' })
  })
})
