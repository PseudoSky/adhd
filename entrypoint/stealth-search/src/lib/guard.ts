/**
 * @adhd/stealth-search: src/lib/guard.ts
 *
 * Cross-process spam guards, ported from the source runner's search-guard (inventory rows I-19
 * and I-20). Two layers stop an agent from opening window after window against a hostile
 * provider:
 *
 *   1. A per-provider COOLDOWN, file-backed and shared across processes. After `captcha`,
 *      `rate_limited` or `banned` a cooldown is written atomically (unique temp file, then
 *      rename) to `<dataDir>/guard/<provider>.json`. `hitl` never arms one (the tripwire lock is
 *      the durable gate there); `success` and `empty` disarm it. An expired cooldown is removed
 *      lazily on read.
 *   2. A bounded per-process concurrency cap (`maxConcurrent`, default 2, 0 or below disables):
 *      a FIFO queue in which a finishing call hands its slot directly to the next waiter, so
 *      the cap can never be overshot by a newcomer racing the waiter.
 *
 * Every setting comes from `SearchHostConfig` (ADR-0001); state I/O goes through the tripwire
 * package's `FsPort` so the unit lane runs on the in-memory fs. Unreadable state raises
 * PROVIDER_STATE_IO.
 *
 * Ticket 8468f7b1 · plan state search-port-guards · [search-port-guards.2] [search-port-guards.4]
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createNodeFs } from '@adhd/resilience-core-tripwire'
import type { FsPort } from '@adhd/resilience-core-tripwire'
import type { SearchHostConfig } from './config.js'
import { searchError } from '../errors.js'

/** A cooldown record as stored in `<dataDir>/guard/<provider>.json`. */
export interface ProviderCooldown {
  provider: string
  /** Epoch ms at which the cooldown lifts. */
  until: number
  /** ISO timestamp when it was recorded. */
  firedAt: string
  /** The hostile outcome that armed it. */
  reason: string
  /** The query or URL that triggered it, when known. */
  query?: string
}

/** Diagnostic snapshot of the concurrency queue. */
export interface ConcurrencyInfo {
  active: number
  queued: number
  max: number
}

/** The guard bound to one `SearchHostConfig`. */
export interface SearchGuard {
  setProviderCooldown(provider: string, reason: string, durationMs: number, query?: string): Promise<ProviderCooldown>
  readProviderCooldown(provider: string): Promise<ProviderCooldown | null>
  clearProviderCooldown(provider: string): Promise<void>
  /** Milliseconds until the cooldown lifts (0 = not cooling); removes an expired one. */
  cooldownRemainingMs(provider: string): Promise<number>
  /** Cooldown duration for an outcome, or 0 when none applies. */
  cooldownForOutcome(outcome: string): number
  /** Hostile outcomes arm a cooldown, success and empty disarm it, everything else (hitl) is ignored. */
  recordSearchOutcome(provider: string, outcome: string, query?: string): Promise<void>
  /** Run `fn` under the FIFO concurrency cap. */
  withSearchConcurrency<T>(fn: () => Promise<T>): Promise<T>
  searchConcurrencyInfo(): ConcurrencyInfo
}

const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const FILE_MODE = 0o600
const DIR_MODE = 0o700
const dec = new TextDecoder()
const enc = new TextEncoder()

function codeOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined
  const c = (e as { code?: unknown }).code
  return typeof c === 'string' ? c : undefined
}

function validCooldown(v: unknown): v is ProviderCooldown {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r['provider'] === 'string' && typeof r['until'] === 'number' && Number.isFinite(r['until']) &&
    typeof r['firedAt'] === 'string' && typeof r['reason'] === 'string'
}

/** Build the guard for one config. Construction performs no I/O. */
export function createSearchGuard(config: SearchHostConfig): SearchGuard {
  const fs: FsPort = config.fs ?? createNodeFs()
  const now = config.clock ?? ((): number => Date.now())
  const dir = join(config.dataDir, 'guard')

  const pathOf = (provider: string): string => {
    if (!PROVIDER_PATTERN.test(provider)) {
      throw searchError('UNKNOWN_PROVIDER', `invalid provider id ${JSON.stringify(String(provider)).slice(0, 80)}`, { detail: { provider: String(provider) } })
    }
    return join(dir, `${provider}.json`)
  }

  const io = (what: string, path: string, cause: unknown) =>
    searchError('PROVIDER_STATE_IO', `${what} ${path} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause, detail: { path } })

  const setProviderCooldown: SearchGuard['setProviderCooldown'] = async (provider, reason, durationMs, query) => {
    const fp = pathOf(provider)
    const cd: ProviderCooldown = {
      provider,
      until: now() + Math.max(0, durationMs),
      firedAt: new Date(now()).toISOString(),
      reason,
      ...(query ? { query } : {}),
    }
    const tmp = `${fp}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.mkdir(dir, DIR_MODE)
      const h = await fs.openExclusive(tmp, FILE_MODE)
      try {
        await h.write(enc.encode(JSON.stringify(cd, null, 2)))
        await h.sync()
      } finally {
        await h.close()
      }
      await fs.rename(tmp, fp)
    } catch (e) {
      try { await fs.unlink(tmp) } catch { /* the temp file may not exist */ }
      throw io('writing cooldown', fp, e)
    }
    return cd
  }

  const readProviderCooldown: SearchGuard['readProviderCooldown'] = async (provider) => {
    const fp = pathOf(provider)
    let raw: Uint8Array
    try {
      raw = await fs.readFile(fp)
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return null
      throw io('reading cooldown', fp, e)
    }
    let doc: unknown
    try {
      doc = JSON.parse(dec.decode(raw))
    } catch (e) {
      throw io('parsing cooldown', fp, e)
    }
    if (!validCooldown(doc)) throw io('validating cooldown', fp, 'unexpected shape')
    return doc
  }

  const clearProviderCooldown: SearchGuard['clearProviderCooldown'] = async (provider) => {
    const fp = pathOf(provider)
    try {
      await fs.unlink(fp)
    } catch (e) {
      if (codeOf(e) === 'ENOENT') return
      throw io('removing cooldown', fp, e)
    }
  }

  const cooldownRemainingMs: SearchGuard['cooldownRemainingMs'] = async (provider) => {
    const cd = await readProviderCooldown(provider)
    if (!cd) return 0
    const remaining = cd.until - now()
    if (remaining <= 0) {
      await clearProviderCooldown(provider)
      return 0
    }
    return remaining
  }

  const cooldownForOutcome: SearchGuard['cooldownForOutcome'] = (outcome) => {
    switch (outcome) {
      case 'captcha': return config.cooldownCaptchaMs
      case 'rate_limited': return config.cooldownRateMs
      case 'banned': return config.cooldownBannedMs
      default: return 0
    }
  }

  const recordSearchOutcome: SearchGuard['recordSearchOutcome'] = async (provider, outcome, query) => {
    const dur = cooldownForOutcome(outcome)
    if (dur > 0) await setProviderCooldown(provider, outcome, dur, query)
    else if (outcome === 'success' || outcome === 'empty') await clearProviderCooldown(provider)
  }

  let active = 0
  const waiters: Array<() => void> = []

  const withSearchConcurrency = async <T>(fn: () => Promise<T>): Promise<T> => {
    const max = config.maxConcurrent
    if (max <= 0) return fn()
    if (active >= max) {
      // The releasing call hands its slot over, so `active` is unchanged for the waiter.
      await new Promise<void>((resolve) => waiters.push(resolve))
    } else {
      active++
    }
    try {
      return await fn()
    } finally {
      const next = waiters.shift()
      if (next) next()
      else active--
    }
  }

  return {
    setProviderCooldown,
    readProviderCooldown,
    clearProviderCooldown,
    cooldownRemainingMs,
    cooldownForOutcome,
    recordSearchOutcome,
    withSearchConcurrency,
    searchConcurrencyInfo: () => ({ active, queued: waiters.length, max: config.maxConcurrent }),
  }
}
