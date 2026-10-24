/**
 * stealth-core-browser/src/lib/helpers.ts — Shared helper functions for the ADHD package.
 *
 * Extracted from cdp-query-client.ts (helper section + VisitRow).
 */

import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { toUnixTimeSql } from './storage/helpers.js'
import type { ChromeVisit } from './types.js'

/** The single read-only (`mode=ro&immutable=1`) Chrome database opener lives in storage/helpers.ts; re-exported here under the same name. */
export { openDb } from './storage/helpers.js'

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

/** Directory name of the dedicated CDP profile under the Google application-data directory. */
export const CDP_PROFILE_NAME = 'Chrome-CDP'

/**
 * The per-platform directory Chrome keeps user data under: `~/Library/Application Support/Google` on macOS,
 * `%LOCALAPPDATA%\\Google` on Windows, `$XDG_CONFIG_HOME/google` (default `~/.config/google`) elsewhere.
 */
export function googleSupportDir(
  platformName: NodeJS.Platform = platform(),
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platformName === 'darwin') return join(home, 'Library', 'Application Support', 'Google')
  if (platformName === 'win32') return join(env['LOCALAPPDATA'] || join(home, 'AppData', 'Local'), 'Google')
  return join(env['XDG_CONFIG_HOME'] || join(home, '.config'), 'google')
}

/** The dedicated, automation-only Chrome profile (never the everyday profile). */
export function chromeProfileDir(): string {
  return join(googleSupportDir(), CDP_PROFILE_NAME)
}

/** The everyday Chrome profile directory of this platform. */
export function defaultChromeDir(): string {
  const current = platform()
  if (current === 'darwin' || current === 'win32') return join(googleSupportDir(), 'Chrome')
  return join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'google-chrome')
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
export function chromeTimeToDate(chromeTime: number | bigint | string): Date {
  return new Date((Number(chromeTime) / 1000) - 11644473600000)
}

/** Like {@link chromeTimeToDate}, but an unset timestamp (absent, empty or `0`) is `null`, not the year 1601. */
export function chromeTimeToDateOrNull(chromeTime: number | bigint | string | null | undefined): Date | null {
  if (chromeTime === null || chromeTime === undefined || chromeTime === '') return null
  const n = Number(chromeTime)
  return Number.isFinite(n) && n > 0 ? chromeTimeToDate(n) : null
}

// ═══════════════════════════════════════════════════════════════════════════════
// SQL column helpers (used by HistoryClient)
// ═══════════════════════════════════════════════════════════════════════════════

export { toUnixTimeSql } from './storage/helpers.js'

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
    visitTime: new Date(Math.round(visitTimeUnix * 1000)),
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
