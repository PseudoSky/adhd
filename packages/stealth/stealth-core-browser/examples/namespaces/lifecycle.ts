/**
 * Scenario: reap-and-launch-guard -- decide whether an idle Chrome may be closed right now (another
 * client, an open web page or a recent history visit each keep it alive) and
 * guard against a launch storm with the circuit breaker.
 */
// eslint-disable-next-line @nx/enforce-module-boundaries -- examples import the package root exactly as a consumer does
import { lifecycle } from '@adhd/stealth-core-browser'

export interface RunOptions {
  /** CDP remote-debugging port of the managed Chrome. */
  port?: number
  /** Number of http(s) pages currently open. */
  openWebPages?: number
  /** Whether the profile history shows a visit within the last two minutes. */
  recentHistory?: boolean
}

export interface ReapReport {
  action: 'keep' | 'wait' | 'reap' | 'none'
  pinnedBy?: 'client' | 'page' | 'history' | 'grace'
  stateDir: string
  launchAllowed: boolean
}

export function run({ port = 9333, openWebPages = 0, recentHistory = false }: RunOptions = {}): ReapReport {
  const decision = lifecycle.decideReap({
    now: Date.now(),
    clients: [],
    idleTimeoutMs: 120_000,
    graceMs: 0,
    chromeUp: true,
    httpPageCount: openWebPages,
    historyRecent: recentHistory,
    checkHistoryDefault: true,
    scope: 'launched-only',
    ownerValid: true,
    lastPinAt: null,
  })

  const breaker = lifecycle.createLaunchBreaker({ port })
  let launchAllowed = true
  try {
    breaker.assertClosed()
  } catch {
    launchAllowed = false
  }
  return { ...decision, stateDir: lifecycle.defaultStateDir(port), launchAllowed }
}
