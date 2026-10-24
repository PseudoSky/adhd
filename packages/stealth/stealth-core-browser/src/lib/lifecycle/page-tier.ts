/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/page-tier.ts
 *
 * Safety tier 2 (page): an open http(s) document means a human (a captcha
 * window) or another call (a keepPage result) is using Chrome.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (CL7, F10 F11 F12).
 */

/**
 * True only for a real WEB document that means a human (or another call) is
 * using Chrome. Browser-internal pages — `chrome://newtab/`, `chrome://omnibox…`,
 * `chrome-untrusted://…`, `about:`, `devtools://`, extension backgrounds — are
 * NOT a reason to keep Chrome alive: the default window always shows
 * `chrome://newtab/`, so counting it would make the idle shutdown defer forever.
 */
export function isActiveWebTarget(url: string): boolean {
  return /^https?:/i.test(url)
}

/** A page target as listed by `/json/list` (only `url` matters to the tier). */
export interface PageTierTarget {
  url?: string
}

/**
 * Count the page targets that pin Chrome. A listing failure (CDP unreachable
 * during the check) yields `'unreachable'`, which the policy treats as
 * "proceed" (F12): an unreachable Chrome must never defer the reap forever.
 */
export async function countActiveWebPages(list: () => Promise<PageTierTarget[]>): Promise<number | 'unreachable'> {
  try {
    const targets = await list()
    return targets.filter((t) => typeof t.url === 'string' && isActiveWebTarget(t.url)).length
  } catch {
    return 'unreachable'
  }
}
