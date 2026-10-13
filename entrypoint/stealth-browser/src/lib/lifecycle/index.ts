/**
 * @adhd/stealth-browser — src/lib/lifecycle/index.ts
 *
 * Barrel of the Chrome lifecycle (the package `lifecycle` namespace is wired at
 * the root by prod-errors).
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle.
 */

export * from './errors.js'
export * from './page-tier.js'
export * from './reap-policy.js'
export * from './reaper-host.js'
export type { ReaperLink } from './reaper-link.js'
export * from './isolated-page.js'
export * from './exit-hooks.js'
