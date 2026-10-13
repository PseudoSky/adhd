/**
 * stealth-core-browser/src/lib/helpers.ts — Shared helper functions for the ADHD package.
 *
 * Extracted from cdp-query-client.ts (helper section + VisitRow).
 */

import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ChromeVisit } from './types.js'

// ═══════════════════════════════════════════════════════════════════════════════
// Transition helpers
// ═══════════════════════════════════════════════════════════════════════════════

const TRANSITION_NAMES: Record<number, string> = {
  [0]: 'LINK',
  [1]: 'TYPED',
  [2]: 'AUTO_BOOKMARK',
  [3]: 'AUTO_SUBFRAME',
  [4]: 'MANUAL_SUBFRAME',
  [5]: 'GENERATED',
  [6]: 'AUTO_TOPLEVEL',
  [7]: 'FORM_SUBMIT',
  [8]: 'RELOAD',
  [9]: 'KEYWORD',
  [10]: 'KEYWORD_GENERATED',
}

export function transitionName(raw: number): string {
  return TRANSITION_NAMES[raw & 0xff] ?? `UNKNOWN(${raw & 0xff})`
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chrome profile / paths
// ═══════════════════════════════════════════════════════════════════════════════

export function chromeProfileDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome-CDP')
}

export function defaultChromeDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
}

// ═══════════════════════════════════════════════════════════════════════════════
// Database helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Open a Chrome SQLite DB with immutable mode — no file locking. */
export function openDb(dbPath: string): DatabaseSyncType {
  const uri = `file:${dbPath}?mode=ro&immutable=1`
  const db = new DatabaseSync(uri)
  db.exec('PRAGMA query_only = ON')
  return db
}

// ═══════════════════════════════════════════════════════════════════════════════
// Placeholder helper
// ═══════════════════════════════════════════════════════════════════════════════

export function notYet(name: string): void {
  console.warn(`[cdp-query] ${name} is not yet implemented`)
}

// ═══════════════════════════════════════════════════════════════════════════════
// Chrome timestamp conversion
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert a Chrome timestamp (microseconds since 1601-01-01) to a JS Date. */
export function chromeTimeToDate(chromeTime: number): Date {
  return new Date((chromeTime / 1000) - 11644473600000)
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL column helpers (used by HistoryClient)
// ═══════════════════════════════════════════════════════════════════════════════

/** Convert a Chrome timestamp column to Unix epoch seconds in SQL. */
export function toUnixTimeSql(column: string): string {
  return `((${column} / 1000000) - 11644473600)`
}

// ═══════════════════════════════════════════════════════════════════════════════
// Visit row helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Row shape returned by visit queries (visit_time computed to unix epoch in SQL).
 * The read-only opener runs with `readBigInts`, so integer columns arrive as `bigint`;
 * {@link hydrateVisit} converts every one of them to a plain number.
 */
export interface VisitRow {
  id: number | bigint
  url_id: number | bigint
  url: string
  title: string
  /** Unix timestamp in seconds. */
  visit_time_unix: number | bigint
  transition: number | bigint
  from_visit: number | bigint
  visit_duration: number | bigint
  opener_visit: number | bigint
}

export function hydrateVisit(row: VisitRow): ChromeVisit {
  const transition = Number(row.transition)
  const visitTimeUnix = Number(row.visit_time_unix)
  return {
    id: Number(row.id),
    urlId: Number(row.url_id),
    url: row.url,
    title: row.title,
    visitTimeUnix,
    visitTime: new Date(visitTimeUnix * 1000),
    transitionType: transitionName(transition),
    transitionRaw: transition,
    fromVisitId: Number(row.from_visit),
    visitDurationMs: Math.round(Number(row.visit_duration) / 1000),
    openerVisitId: Number(row.opener_visit),
  }
}

export const VISIT_COLUMNS = `
  v.id, v.url AS url_id, u.url, u.title,
  ${toUnixTimeSql('v.visit_time')} AS visit_time_unix,
  v.transition, v.from_visit, v.visit_duration, v.opener_visit
`
