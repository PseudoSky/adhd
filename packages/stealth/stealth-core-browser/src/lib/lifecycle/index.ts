/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/index.ts
 *
 * Barrel of the Chrome lifecycle: the package `lifecycle` namespace (wired at
 * the root by src/index.ts), including the manager seam of src/lib/managers.ts.
 *
 * Ticket 8468f7b1 · plan states chrome-lifecycle and core-seam.
 */

export * from './errors.js'
export * from './page-tier.js'
export * from './reap-policy.js'
export * from './reaper-host.js'
export type { ReaperLink } from './reaper-link.js'
export * from './isolated-page.js'
export * from './exit-hooks.js'
export * from './state-dir.js'
export * from './ownership.js'
export * from './launch-breaker.js'
export * from './reaper-entry.js'
export { createProxyReaperLink, defaultReaperEntry, reaperSingletonKey, REAPER_ENTRY_SCRIPT, LINK_GIVE_UP_MS } from './reaper-link.js'
export type { ProxyReaperLinkConfig } from './reaper-link.js'
export { configureManagers, managerFor, chromeExitTarget } from '../managers.js'
export type { ManagerSettings } from '../managers.js'
