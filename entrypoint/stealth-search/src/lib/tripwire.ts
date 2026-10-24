/**
 * @adhd/stealth-search: src/lib/tripwire.ts
 *
 * Per-provider tripwire over `@adhd/resilience-core-tripwire` (inventory row I-21 replaces the
 * source runner's hand-rolled lock, audit and TTL code; I-15 is the sparse status record and the
 * clear-returns-false contract; I-13.b is the login_required exemption).
 *
 * Decision O8: the tripwire namespace is `stealth-search`. Locks live at
 * `<dataDir>/tripwire/<provider>.lock` with no namespace in the path, so a lock written by the
 * old `agent-search` runner under the default root is still read (the package parses the legacy
 * flat shape) and is honoured until the 2 h TTL removes it; no lock is migrated.
 *
 * A login interrupt is not a ban (commit 591e1a7): a fire with reason `login_required` writes no
 * lock and no audit line, a stored `login_required` lock never blocks the gate, and a later
 * successful search clears it with `resolved`.
 *
 * An unreadable lock fails closed: `gate`, `read` and `isTripped` raise TRIPWIRE_STATE_UNREADABLE
 * (never "clear"), while `tripwireStatus` lists it so `clearTripwire` can remove it.
 *
 * Ticket 8468f7b1 · plan state search-port-guards · [search-port-guards.3] [search-port-guards.9]
 * [search-port-guards.10] [search-port-guards.11]
 */
import { createNodeFs, createTripwire, isTripwireError } from '@adhd/resilience-core-tripwire'
import type { ClearMethod, JsonValue, Tripwire, TripwireRecord as PackageRecord } from '@adhd/resilience-core-tripwire'
import type { SearchHostConfig } from './config.js'
import { searchError } from '../errors.js'

/** Namespace of the tripwire (decision O8). Locks under the old `agent-search` namespace expire within 2 h and are accepted as lost. */
export const TRIPWIRE_NAMESPACE = 'stealth-search'

/** The reason of a sign-in interrupt, which never trips. */
export const LOGIN_REQUIRED = 'login_required'

/** The verb an agent calls to clear a tripped provider. */
export const CLEAR_VERB = 'clearTripwire'

/** The forensic record of a tripped provider (flat, concrete, non-generic for apigen extraction). */
export interface TripwireRecord {
  provider: string
  namespace: string
  /** Ban signal: captcha, banned, rate_limited (login_required never trips). */
  reason: string
  trippedAt: string
  /** How many searches the gate blocked while tripped. */
  blockedCount: number
  lastBlockedAt?: string
  generation?: string
  recoveryHint?: string
  query: string
  searchSessionId: string
  browserSessionId: string
  pageUrl: string
  strategy: string
  lastOperation: string
}

/** One entry of `tripwireStatus`: the record plus how to clear it and when it lapses. */
export interface TripwireStatusEntry extends TripwireRecord {
  clearWith: 'clearTripwire'
  expiresAt: string
}

/** Input of `fire`. */
export interface FireInput {
  provider: string
  query: string
  reason: string
  pageUrl: string
  strategy: string
  browserSessionId: string
  lastOperation: string
}

/** Result of `gate`. */
export interface GateOutcome {
  locked: boolean
  record: TripwireRecord | null
}

/** How a clear is recorded in the audit. */
export type SearchClearMethod = Extract<ClearMethod, 'mcp-clear' | 'hitl-clear' | 'hitl-retry'>

/** The search-facing tripwire bound to one `SearchHostConfig`. */
export interface SearchTripwire {
  /** Latch the provider; returns null (no lock, no audit) for `login_required`. */
  fire(input: FireInput): Promise<TripwireRecord | null>
  /** Open or closed; counts and audits a block; a `login_required` lock never blocks. */
  gate(provider: string): Promise<GateOutcome>
  /** The agent-callable clear; false when the provider was not tripped. */
  cleared(provider: string, method?: SearchClearMethod): Promise<boolean>
  /** The success path: audit `tripwire-resolved` and clear whatever lock is stored. */
  resolved(provider: string): Promise<void>
  /** The stored record, or null when clear or expired. */
  read(provider: string): Promise<TripwireRecord | null>
  isTripped(provider: string): Promise<boolean>
  /** Sparse map of tripped providers only. */
  tripwireStatus(): Promise<Record<string, TripwireStatusEntry>>
  clearTripwire(provider: string): Promise<boolean>
}

function str(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : ''
}

function toRecord(provider: string, r: PackageRecord): TripwireRecord {
  const c = r.context
  const out: TripwireRecord = {
    provider,
    namespace: r.namespace,
    reason: r.reason,
    trippedAt: r.trippedAt,
    blockedCount: r.blockedCount,
    query: str(c['query']),
    searchSessionId: str(c['searchSessionId']) || (r.trippedBy.sessionId ?? ''),
    browserSessionId: str(c['browserSessionId']),
    pageUrl: str(c['pageUrl']),
    strategy: str(c['strategy']),
    lastOperation: str(c['lastOperation']),
  }
  if (r.lastBlockedAt !== undefined) out.lastBlockedAt = r.lastBlockedAt
  if (r.generation !== undefined) out.generation = r.generation
  if (r.recoveryHint !== undefined) out.recoveryHint = r.recoveryHint
  return out
}

/** Build the tripwire for one config. Construction performs no I/O. */
export function createSearchTripwire(config: SearchHostConfig): SearchTripwire {
  const tw: Tripwire = createTripwire({
    namespace: TRIPWIRE_NAMESPACE,
    stateDir: config.dataDir,
    auditPath: config.auditPath,
    maxAuditBytes: config.auditMaxBytes,
    expiry: { ttlMs: config.tripwireTtlMs },
    clearPolicy: 'open',
    sessionId: () => config.sessionId,
    fs: config.fs ?? createNodeFs(),
    ...(config.clock ? { clock: config.clock } : {}),
  })

  const keyed = async <T>(provider: string, code: 'TRIPWIRE_STATE_UNREADABLE' | 'TRIPWIRE_CLEAR_FAILED', fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn()
    } catch (e) {
      if (isTripwireError(e) && e.code === 'TRIPWIRE_INVALID_KEY') {
        throw searchError('UNKNOWN_PROVIDER', `invalid provider id for the tripwire: ${provider}`, { cause: e, detail: { provider } })
      }
      throw searchError(code, `tripwire ${provider}: ${e instanceof Error ? e.message : String(e)}`, { cause: e, detail: { provider } })
    }
  }

  const snapshot = async (provider: string) => {
    const snap = await keyed(provider, 'TRIPWIRE_STATE_UNREADABLE', () => tw.read(provider))
    if (snap.status === 'unreadable') {
      throw searchError('TRIPWIRE_STATE_UNREADABLE', `the tripwire lock of ${provider} cannot be read (${String(snap.record?.context['error'] ?? 'corrupt')})`, {
        detail: { provider },
      })
    }
    return snap
  }

  const fire: SearchTripwire['fire'] = async (input) => {
    if (input.reason === LOGIN_REQUIRED) return null
    const result = await keyed(input.provider, 'TRIPWIRE_STATE_UNREADABLE', () =>
      tw.trip(input.provider, {
        reason: input.reason,
        context: {
          query: input.query,
          searchSessionId: config.sessionId,
          browserSessionId: input.browserSessionId,
          pageUrl: input.pageUrl,
          strategy: input.strategy,
          lastOperation: input.lastOperation,
        },
        recoveryHint: `Solve the challenge in the browser window, then call ${CLEAR_VERB}("${input.provider}").`,
      }),
    )
    return toRecord(input.provider, result.record)
  }

  const gate: SearchTripwire['gate'] = async (provider) => {
    // Decided before the package gate, which counts and audits every block.
    const snap = await snapshot(provider)
    if (snap.record && snap.status === 'tripped' && snap.record.reason === LOGIN_REQUIRED) return { locked: false, record: null }
    const g = await keyed(provider, 'TRIPWIRE_STATE_UNREADABLE', () => tw.gate(provider))
    if (g.open || !g.snapshot.record) return { locked: false, record: null }
    return { locked: true, record: toRecord(provider, g.snapshot.record) }
  }

  const cleared: SearchTripwire['cleared'] = async (provider, method = 'mcp-clear') => {
    const r = await keyed(provider, 'TRIPWIRE_CLEAR_FAILED', () => tw.clear(provider, { method }))
    return r.cleared
  }

  const resolved: SearchTripwire['resolved'] = (provider) => keyed(provider, 'TRIPWIRE_CLEAR_FAILED', () => tw.resolve(provider))

  const read: SearchTripwire['read'] = async (provider) => {
    const snap = await snapshot(provider)
    if (snap.status !== 'tripped' || !snap.record || snap.record.reason === LOGIN_REQUIRED) return null
    return toRecord(provider, snap.record)
  }

  const isTripped: SearchTripwire['isTripped'] = async (provider) => (await read(provider)) !== null

  const tripwireStatus: SearchTripwire['tripwireStatus'] = async () => {
    const all = await keyed('*', 'TRIPWIRE_STATE_UNREADABLE', () => tw.status())
    const out: Record<string, TripwireStatusEntry> = {}
    for (const [provider, r] of Object.entries(all)) {
      if (r.reason === LOGIN_REQUIRED) continue
      const rec = toRecord(provider, r)
      out[provider] = {
        ...rec,
        clearWith: 'clearTripwire',
        expiresAt: new Date(Date.parse(rec.trippedAt) + config.tripwireTtlMs).toISOString(),
      }
    }
    return out
  }

  return { fire, gate, cleared, resolved, read, isTripped, tripwireStatus, clearTripwire: (p) => cleared(p) }
}
