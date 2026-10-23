/**
 * @adhd/stealth-search: examples/types.ts
 *
 * The dependencies every example's `run` takes. The examples never import the package at run time:
 * the caller injects the eleven operations, so a unit test can hand in fakes and a real script can
 * hand in `import * as api from '@adhd/stealth-search'`. Each `run` returns the text it would print.
 *
 * Ticket 8468f7b1 · plan state search-examples · [search-examples.1]
 */
import type * as api from '../src/api.js'

/** The eleven operations an example may call. */
export type StealthSearchApi = Pick<
  typeof api,
  | 'search'
  | 'listProviders'
  | 'describeProvider'
  | 'tripwireStatus'
  | 'clearTripwire'
  | 'chromeStatus'
  | 'launchChrome'
  | 'shutdownChrome'
  | 'listPageTargets'
  | 'checkChromeActivity'
  | 'getPageContext'
>

/** What `run` receives. */
export interface ExampleDeps {
  api: StealthSearchApi
}
