/**
 * @adhd/stealth-search: src/lib/config.ts
 *
 * `SearchHostConfig` is the single typed source of every setting the guard layer reads. It
 * replaces each former environment toggle of the source runner (the concurrency cap, the three
 * cooldown durations, the tripwire TTL, the audit path and size cap and the data directory) with
 * a typed field (ADR-0001: a library reads no environment; the host passes values in).
 * `createSearchHostConfig` merges overrides over `DEFAULT_SEARCH_HOST_CONFIG` and derives the
 * audit path from the data directory, so overriding `dataDir` moves the locks, the cooldowns and
 * the audit log together (backlog 982ea870).
 *
 * `InteractionPort` is the human-in-the-loop seam: the CLI host supplies a TTY implementation,
 * the MCP host supplies none (a tripped provider then answers `hitl` and an agent clears it with
 * the `clearTripwire` verb).
 *
 * Ticket 8468f7b1 · plan state search-port-guards · [search-port-guards.1] [search-port-guards.4]
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { adhdDataDir } from '@adhd/resilience-core-tripwire'
import type { FsPort } from '@adhd/resilience-core-tripwire'
import { searchError } from '../errors.js'

/** Every setting of the guard layer. Pure data except the optional test seams `fs` and `clock`. */
export interface SearchHostConfig {
  /** Root of the lock, cooldown and audit state (`<dataDir>/tripwire`, `<dataDir>/guard`). */
  dataDir: string
  /** NDJSON audit log; shared across tools, so it survives under the default root. */
  auditPath: string
  /** Audit cap in bytes (the tripwire package clamps it to at least 100000). */
  auditMaxBytes: number
  /** A tripwire older than this no longer blocks (milliseconds). */
  tripwireTtlMs: number
  /** Cooldown after a `captcha` outcome (milliseconds). */
  cooldownCaptchaMs: number
  /** Cooldown after a `rate_limited` outcome (milliseconds). */
  cooldownRateMs: number
  /** Cooldown after a `banned` outcome (milliseconds). */
  cooldownBannedMs: number
  /** Search and fetch calls allowed in flight per process; 0 or below disables the cap. */
  maxConcurrent: number
  /** Sibling processes sharing one Chrome that are tolerated before the host logs a warning (launching is never refused). */
  maxSiblings: number
  /** Non-loopback hosts the chrome verbs and search may address; loopback is always allowed. */
  allowCdpHosts: readonly string[]
  /** Correlation id written into tripwire records and audit lines. */
  sessionId: string
  /** File-system port for guard and tripwire state; default the Node fs. */
  fs?: FsPort
  /** Milliseconds since the epoch; default `Date.now`. */
  clock?: () => number
}

/** What the gate prompt shows a human about a tripped provider. */
export interface GatePromptInfo {
  provider: string
  reason: string
  trippedAt: string
  blockedCount: number
  pageUrl: string
}

/** The human's decision at the gate prompt. */
export type GateDecision = 'retry' | 'clear' | 'abort'

/** What the solved-confirmation prompt shows after a challenge fired. */
export interface SolvedPromptInfo {
  provider: string
  reason: string
  query: string
  strategy: string
  pageUrl: string
}

/** The human's answer once they looked at the browser window. */
export type SolvedAnswer = 'solved' | 'abort'

/**
 * The interactive seam used by `configureSearch({ interaction })`. The CLI host implements it
 * over a TTY; the MCP host provides none.
 */
export interface InteractionPort {
  /** Asked before work on a tripped provider: retry, clear it, or abort. */
  promptTripwireGate(info: GatePromptInfo): Promise<GateDecision>
  /** Asked after a challenge fired: wait for the human to solve it in the visible window. */
  confirmSolved(info: SolvedPromptInfo): Promise<SolvedAnswer>
}

/** The default data root when no override is given: `~/.adhd/reverse/data`. */
export const DEFAULT_DATA_DIR: string = adhdDataDir(['reverse', 'data'])

/** The spec defaults. TTL 7200000 (2 h), cooldowns 30000 / 20000 / 60000, cap 2, siblings 4. */
export const DEFAULT_SEARCH_HOST_CONFIG: Readonly<SearchHostConfig> = Object.freeze({
  dataDir: DEFAULT_DATA_DIR,
  auditPath: join(DEFAULT_DATA_DIR, 'audit.log'),
  auditMaxBytes: 5242880,
  tripwireTtlMs: 7200000,
  cooldownCaptchaMs: 30000,
  cooldownRateMs: 20000,
  cooldownBannedMs: 60000,
  maxConcurrent: 2,
  maxSiblings: 4,
  allowCdpHosts: [],
  sessionId: randomUUID(),
})

type NumericKey = 'auditMaxBytes' | 'tripwireTtlMs' | 'cooldownCaptchaMs' | 'cooldownRateMs' | 'cooldownBannedMs' | 'maxConcurrent' | 'maxSiblings'

/** Lower bound per numeric field; `maxConcurrent` may be zero or negative (disables the cap). */
const NUMERIC_MIN: Readonly<Record<NumericKey, number>> = {
  auditMaxBytes: 1,
  tripwireTtlMs: 1,
  cooldownCaptchaMs: 0,
  cooldownRateMs: 0,
  cooldownBannedMs: 0,
  maxConcurrent: Number.NEGATIVE_INFINITY,
  maxSiblings: 0,
}

/**
 * Build a complete config from overrides. A `dataDir` override with no `auditPath` moves the
 * audit log under that directory. A non-integer or out-of-range numeric field raises
 * HOST_FLAG_INVALID naming the field.
 */
export function createSearchHostConfig(overrides: Partial<SearchHostConfig> = {}): SearchHostConfig {
  const base = DEFAULT_SEARCH_HOST_CONFIG
  const dataDir = overrides.dataDir ?? base.dataDir
  const merged: SearchHostConfig = {
    ...base,
    ...stripUndefined(overrides),
    dataDir,
    auditPath: overrides.auditPath ?? (overrides.dataDir !== undefined ? join(dataDir, 'audit.log') : base.auditPath),
  }
  if (merged.dataDir.trim() === '') {
    throw searchError('HOST_FLAG_INVALID', 'SearchHostConfig.dataDir must be a non-empty path', { detail: { field: 'dataDir' } })
  }
  for (const key of Object.keys(NUMERIC_MIN) as NumericKey[]) {
    const v = merged[key]
    if (!Number.isInteger(v) || v < NUMERIC_MIN[key]) {
      throw searchError('HOST_FLAG_INVALID', `SearchHostConfig.${key} must be an integer >= ${NUMERIC_MIN[key]} (got ${String(v)})`, {
        detail: { field: key, value: v },
      })
    }
  }
  return merged
}

function stripUndefined(o: Partial<SearchHostConfig>): Partial<SearchHostConfig> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as Partial<SearchHostConfig>
}
