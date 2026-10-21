/**
 * @adhd/stealth-core-browser — the package root and its one public entry (no subpaths).
 *
 * Library areas are namespaces; the six chrome-runner verbs and the shared
 * types are flat. Nothing else is exported and there is no default export.
 *
 *   import { cdp, storage, capture, parsers, chromeManager, lifecycle, recording, StealthCoreBrowserError, chromeStatus } from '@adhd/stealth-core-browser'
 */

export * as cdp from './lib/cdp/index.js'
export * as storage from './lib/storage/index.js'
export * as capture from './lib/capture/index.js'
export * as parsers from './lib/parsers.js'
export * as chromeManager from './lib/chrome-manager.js'
export * as lifecycle from './lib/lifecycle/index.js'
export * as recording from './lib/recording/index.js'

export * from './api.js'
export * from './errors.js'
export type * from './lib/types.js'
