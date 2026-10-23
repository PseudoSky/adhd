/**
 * @adhd/stealth-search — src/lib/challenge.ts
 *
 * Cloudflare / Turnstile managed-challenge recovery.
 *
 * A `captcha` ban signal in a network search is usually a Cloudflare MANAGED challenge that
 * auto-clears for a real browser, but our contexts render OFF-SCREEN, where the browser throttles the
 * challenge's timers and Cloudflare withholds clearance from a hidden page (measured on pypi: cleared
 * only after ~50 s hidden, and only once the window was revealed). So the recovery is:
 *
 *   1. reveal the window,
 *   2. poll until the provider's OWN challenge markers are gone (`waitForChallengeClear`),
 *   3. retry the search EXACTLY ONCE (the context now holds the clearance cookie, so the retry is fast).
 *
 * Only a challenge that never clears (or one that survives the single retry) is reported as
 * `captcha`, which the caller escalates to the human-in-the-loop gate. There is never a second retry.
 *
 * Browser access is a page session shaped like the core's `cdp.CdpSession` and the core's
 * `capture.checkBans`; the time sources are injected, so the unit lane runs with a virtual clock.
 *
 * Inventory row: I-12 (managed-challenge recovery: reveal, poll provider ban markers, retry once).
 * Ticket 8468f7b1 · plan state search-port-engine.
 */
import { capture, type cdp } from '@adhd/stealth-core-browser'
import type { BanSignal } from '@adhd/stealth-core-browser'
import { defaultClock, type EngineClock } from './dom.js'
import type { ProviderConfig, SearchResponse } from './types.js'

/** Pause between challenge-clear polls, in ms. */
export const CHALLENGE_POLL_MS = 2000
/** Default time budget for a challenge to clear, in ms (the `--challenge-wait` default). */
export const DEFAULT_CHALLENGE_WAIT_MS = 25_000

/** The slice of the core's `cdp.CdpSession` the challenge poll uses. */
export type ChallengeSession = Pick<InstanceType<typeof cdp.CdpSession>, 'send'>

/** The collaborators of the challenge poll. */
export interface ChallengeDeps extends EngineClock {
  checkBans: (rules: ProviderConfig['bans'], ctx: { url: string; status: number; body: string }) => BanSignal | null
}

/** The production dependencies: the core's `capture.checkBans` and the real clock. */
export function defaultChallengeDeps(): ChallengeDeps {
  return { ...defaultClock(), checkBans: (rules, ctx) => capture.checkBans(rules, ctx) }
}

/**
 * Poll a page until the provider's OWN ban rules stop matching, i.e. a managed challenge has cleared.
 * Reads the document wholesale via `DOM.getOuterHTML` (selects nothing, injects no script) and re-runs
 * the exact `checkBans` rules the capture used, so "cleared" is defined by the provider, never by a
 * hardcoded marker. Returns true as soon as a read yields challenge-free HTML, false when the budget
 * elapses first. Never throws (a read can land mid-navigation as the challenge solves).
 */
export async function waitForChallengeClear(
  page: ChallengeSession,
  provider: Pick<ProviderConfig, 'bans'>,
  budgetMs: number,
  overrides: Partial<ChallengeDeps> = {},
): Promise<boolean> {
  const deps: ChallengeDeps = { ...defaultChallengeDeps(), ...overrides }
  const deadline = deps.now() + budgetMs
  while (deps.now() < deadline) {
    await deps.sleep(CHALLENGE_POLL_MS)
    try {
      const { root } = await page.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 })
      const { outerHTML } = await page.send<{ outerHTML: string }>('DOM.getOuterHTML', { nodeId: root.nodeId })
      // url '' so only the provider's body-pattern challenge rules are consulted (status and URL rules
      // are capture-specific and would false-positive here).
      if (outerHTML && !deps.checkBans(provider.bans, { url: '', status: 200, body: outerHTML })) return true
    } catch {
      /* page mid-navigation: try again */
    }
  }
  return false
}

/** How a recovery attempt ended. */
export type ChallengeRecoveryOutcome =
  /** Not a managed-challenge candidate (or recovery disabled): the response is returned untouched. */
  | 'skipped'
  /** The challenge cleared and the single retry produced a response that is not a captcha. */
  | 'recovered'
  /** The challenge never cleared, or it survived the single retry: escalate to the HITL gate. */
  | 'captcha'

export interface ChallengeRecovery {
  outcome: ChallengeRecoveryOutcome
  /** The response to use: the retry's when one ran, otherwise the one passed in. */
  response: SearchResponse
  /** True when the single retry ran. Never more than one. */
  retried: boolean
}

export interface ChallengeRecoveryInput {
  /** The response that may carry the challenge. */
  response: SearchResponse
  provider: Pick<ProviderConfig, 'bans'>
  /** Time budget for the challenge to clear; 0 disables the recovery. */
  budgetMs: number
  /** Bring the window on screen (managed challenges clear only on a visible page). */
  reveal: () => Promise<void>
  /** Open a session on the challenged page; the recovery closes it. */
  connect: () => Promise<ChallengeSession & { close: () => void }>
  /** Run the search again on the same page. Called at most once. */
  retry: () => Promise<SearchResponse>
}

/** True for a network response that stopped on a captcha-class challenge (the only recoverable shape). */
export function isChallengeCandidate(response: SearchResponse): boolean {
  return response.outcome === 'hitl' && response.hitl?.reason === 'captcha' && response.strategy === 'network'
}

/**
 * Cloudflare managed-challenge recovery: reveal the window, poll the provider's ban markers until they
 * clear, then retry the search exactly once.
 *
 * - not a candidate, or `budgetMs` is 0: `skipped`, no page call
 * - the challenge never clears within the budget: `captcha`, the retry is not run
 * - the challenge clears: the retry runs once; a captcha-class result is `captcha` (no second retry),
 *   anything else is `recovered`
 */
export async function recoverFromChallenge(input: ChallengeRecoveryInput, overrides: Partial<ChallengeDeps> = {}): Promise<ChallengeRecovery> {
  const { response } = input
  if (input.budgetMs <= 0 || !isChallengeCandidate(response)) return { outcome: 'skipped', response, retried: false }

  await input.reveal().catch(() => undefined)

  // A page that cannot be reached cannot be polled: that is an unrecovered challenge, not a crash.
  let cleared = false
  let session: Awaited<ReturnType<ChallengeRecoveryInput['connect']>> | undefined
  try {
    session = await input.connect()
    cleared = await waitForChallengeClear(session, input.provider, input.budgetMs, overrides)
  } catch {
    cleared = false
  } finally {
    session?.close()
  }
  if (!cleared) return { outcome: 'captcha', response, retried: false }

  const retried = await input.retry()
  return { outcome: isChallengeCandidate(retried) ? 'captcha' : 'recovered', response: retried, retried: true }
}
