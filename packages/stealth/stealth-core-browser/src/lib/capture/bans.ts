/**
 * stealth-core-browser/src/lib/capture/bans.ts — Ban detection + retry/backoff.
 *
 * Detects CAPTCHAs, rate-limiting, and other ban signals across
 * all provider types. Provides exponential backoff with jitter
 * for retryable outcomes.
 */

import type { RetryConfig, BanRule, BanSignal } from '../types.js'

interface RetryResponse {
  outcome: string
  error?: string
}

// ─── Retry decision ───────────────────────────────────────────────────────────

export interface RetryDecision {
  shouldRetry: boolean
  delayMs: number
  reason: string
}

/**
 * Given a search response outcome and retry config, decide whether
 * to retry and how long to wait.
 */
export function decideRetry(
  response: RetryResponse,
  attempt: number,
  config: RetryConfig,
): RetryDecision {
  // Never retry on success
  if (response.outcome === 'success') {
    return { shouldRetry: false, delayMs: 0, reason: 'already succeeded' }
  }

  // A parsed zero-result page is a legitimate answer: retrying cannot change it, at any attempt.
  if (response.outcome === 'empty') {
    return { shouldRetry: false, delayMs: 0, reason: 'empty: legitimate zero results, no retry' }
  }

  // Check if we're past max attempts
  if (attempt >= config.maxAttempts) {
    return { shouldRetry: false, delayMs: 0, reason: `max attempts (${config.maxAttempts}) reached` }
  }

  switch (response.outcome) {
    case 'hitl':
      // HITL: don't delay, the user is solving manually
      return { shouldRetry: true, delayMs: 0, reason: 'hitl: user solving challenge' }

    case 'captcha':
      if (config.onCaptcha === 'hitl') {
        return { shouldRetry: true, delayMs: 0, reason: 'hitl: user must solve CAPTCHA' }
      }
      if (config.onCaptcha === 'abort') {
        return { shouldRetry: false, delayMs: 0, reason: 'captcha: abort configured' }
      }
      return {
        shouldRetry: true,
        delayMs: backoff(attempt, config.baseDelayMs),
        reason: `captcha: retry attempt ${attempt + 1}`,
      }

    case 'rate_limited':
      if (config.onRateLimit === 'abort') {
        return { shouldRetry: false, delayMs: 0, reason: 'rate_limited: abort configured' }
      }
      return {
        shouldRetry: true,
        delayMs: backoff(attempt, config.baseDelayMs, 2.5),
        reason: `rate_limited: retry attempt ${attempt + 1}`,
      }

    case 'banned':
      if (config.onBan === 'hitl') {
        return { shouldRetry: true, delayMs: 0, reason: 'hitl: user must unban' }
      }
      return { shouldRetry: false, delayMs: 0, reason: 'banned: no retry' }

    case 'timeout':
      if (config.onTimeout === 'abort') {
        return { shouldRetry: false, delayMs: 0, reason: 'timeout: abort configured' }
      }
      return {
        shouldRetry: true,
        delayMs: backoff(attempt, config.baseDelayMs),
        reason: `timeout: retry attempt ${attempt + 1}`,
      }

    case 'error':
      return {
        shouldRetry: true,
        delayMs: backoff(attempt, config.baseDelayMs),
        reason: `${response.outcome}: retry attempt ${attempt + 1}`,
      }

    default:
      return { shouldRetry: false, delayMs: 0, reason: `unknown outcome: ${response.outcome}` }
  }
}

// ─── Exponential backoff ──────────────────────────────────────────────────────

/**
 * Calculate backoff delay: base * multiplier^attempt + random jitter.
 */
function backoff(attempt: number, baseMs: number, multiplier = 2): number {
  const delay = baseMs * Math.pow(multiplier, attempt)
  const jitter = Math.random() * 0.3 * delay // 0-30% jitter
  return Math.min(Math.round(delay + jitter), 30_000) // cap at 30s
}

// ─── Ban check ────────────────────────────────────────────────────────────────

export interface BanCheckContext {
  url: string
  status: number
  body: string
}

/**
 * Stateless `RegExp.test`: a caller-supplied pattern with the `g` or `y` flag carries a `lastIndex` between calls,
 * which would make the same input match on one check and miss on the next. The index is reset before and after.
 */
function matches(pattern: RegExp | undefined, text: string): boolean {
  if (!pattern) return false
  pattern.lastIndex = 0
  const hit = pattern.test(text)
  pattern.lastIndex = 0
  return hit
}

export function checkBans(rules: BanRule[], ctx: BanCheckContext): BanSignal | null {
  for (const rule of rules) {
    if (matches(rule.checkUrl, ctx.url)) return rule.signal
    if (rule.checkStatus?.includes(ctx.status)) return rule.signal
    if (matches(rule.checkBody, ctx.body)) return rule.signal
  }
  return null
}
