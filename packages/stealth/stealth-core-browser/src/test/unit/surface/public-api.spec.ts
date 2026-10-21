/**
 * The public-API snapshot: the single owner of the sorted root export names and
 * the sorted member names of each namespace of `src/index.ts`. Any added,
 * removed or renamed export fails this spec.
 * Ticket 8468f7b1 · [tests-unit-surface.5] · PA3.1
 *
 * `recording`, `StealthCoreBrowserError`, `ERROR_CODES` and `exitCodeFor` are
 * added together by prod-errors, so they form ONE all-or-none group: the spec
 * passes with none or with all four (and the members of `recording`), and fails
 * when only some are present or on any other drift.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  const refuse = (): never => {
    throw new Error('process spawn is forbidden in the unit lane')
  }
  return { ...real, spawn: refuse, exec: refuse, execFile: refuse, execSync: refuse, execFileSync: refuse, spawnSync: refuse }
})
vi.stubGlobal('fetch', () => {
  throw new Error('network is forbidden in the unit lane')
})

import * as root from '../../../index.js'

const ERRORS_GROUP = ['ERROR_CODES', 'StealthCoreBrowserError', 'exitCodeFor', 'recording'] as const

const ROOT_EXPORTS = [
  'capture',
  'cdp',
  'checkChromeActivity',
  'chromeManager',
  'chromeStatus',
  'getPageContext',
  'launchChrome',
  'lifecycle',
  'listPageTargets',
  'parsers',
  'shutdownChrome',
  'storage',
]

const MEMBERS: Record<string, string[]> = {
  cdp: [
    'CdpClient',
    'CdpSession',
    'IdleShutdown',
    'awaitPageSettled',
    'browserSession',
    'checkWatermark',
    'clearBrowserCache',
    'closeAllPageTargets',
    'closePageTarget',
    'collectResourceUsage',
    'createIsolatedPageTarget',
    'createPageTarget',
    'createPageTargetIdleShutdown',
    'ensureChromeRunning',
    'formatResourceUsage',
    'getChromeInfo',
    'getSessionId',
    'hideAllWindows',
    'humanPause',
    'isChromeReachable',
    'isChromeRunning',
    'killChrome',
    'launchChrome',
    'listPageTargets',
    'listPageTargetsOnly',
    'rand',
    'shortPause',
  ],
  storage: [
    'BookmarkClient',
    'CookieClient',
    'HistoryClient',
    'ProfileClient',
    'openDb',
    'toUnixTimeSql',
  ],
  capture: [
    'captureAllNetworkResponses',
    'captureNetworkResponse',
    'checkBans',
    'decideRetry',
    'walkDomTree',
  ],
  parsers: [
    'extractResultsFromEmbeddedJson',
    'extractResultsFromHtml',
    'extractResultsFromJson',
    'extractStructural',
    'extractWithXpath',
  ],
  chromeManager: [
    'ChromeManager',
    'REAP_IF_IDLE_TIMEOUT_MS',
    'RECONNECT_MIN_INTERVAL_MS',
    'isActiveWebTarget',
  ],
  lifecycle: [
    'EXIT_CODE_FATAL',
    'EXIT_CODE_SIGINT',
    'EXIT_CODE_SIGTERM',
    'EXIT_CODE_STDIN_EOF',
    'FileBreakerStore',
    'LAUNCH_COOLDOWN_MS',
    'LAUNCH_FAILURE_THRESHOLD',
    'LAUNCH_WINDOW_MS',
    'LIFECYCLE_ERROR_CODES',
    'LINK_GIVE_UP_MS',
    'LifecycleError',
    'REAPER_ENTRY_SCRIPT',
    'REAPER_TICK_MS',
    'RPC_INVALID_PARAMS',
    'RPC_INVALID_REQUEST',
    'RPC_METHOD_NOT_FOUND',
    'breakerPath',
    'chromeExitTarget',
    'configureManagers',
    'countActiveWebPages',
    'createLaunchBreaker',
    'createOwnershipStore',
    'createProxyReaperLink',
    'createReaperHost',
    'decideReap',
    'defaultReaperEntry',
    'defaultStateDir',
    'errorMessage',
    'historyTierEnabled',
    'installProcessExitHooks',
    'isActiveWebTarget',
    'isClientActive',
    'isLifecycleError',
    'lifecycleError',
    'lifecycleErrors',
    'managerFor',
    'openIsolatedPage',
    'ownerRecordPath',
    'reaperSingletonKey',
    'resolveStateDir',
    'runChromeReaper',
    'withIsolatedPage',
  ],
}

const sorted = (o: object): string[] => Object.keys(o).sort()

/** Remove the prod-errors group when it is fully present; fail when only part of it is. */
function withoutErrorsGroup(names: string[]): string[] {
  const present = ERRORS_GROUP.filter((n) => names.includes(n))
  if (present.length !== 0 && present.length !== ERRORS_GROUP.length) {
    throw new Error(`the errors group is all-or-none; present: ${present.join(', ')}`)
  }
  return names.filter((n) => !(ERRORS_GROUP as readonly string[]).includes(n))
}

describe('public API snapshot', () => {
  it('exports exactly the documented root names', () => {
    expect(withoutErrorsGroup(sorted(root))).toEqual(ROOT_EXPORTS)
  })

  it.each(Object.keys(MEMBERS))('the %s namespace exposes exactly its documented members', (ns) => {
    expect(sorted((root as unknown as Record<string, object>)[ns]!)).toEqual(MEMBERS[ns])
  })

  it('treats the errors group as all-or-none', () => {
    expect(() => withoutErrorsGroup(['a', 'recording'])).toThrow(/all-or-none/)
    expect(withoutErrorsGroup(['a', ...ERRORS_GROUP])).toEqual(['a'])
    expect(withoutErrorsGroup(['a'])).toEqual(['a'])
  })

  it('exposes the recorder and its sinks in recording when the group has landed', () => {
    const r = (root as unknown as Record<string, object | undefined>)['recording']
    if (r === undefined) return
    // the member list of recording is owned by prod-errors and grows with it: pin the stable core
    expect(sorted(r)).toEqual(expect.arrayContaining(['MemoryRecordingSink', 'NetworkRecorder', 'StoreRecordingSink', 'redactHeaders']))
  })
})
