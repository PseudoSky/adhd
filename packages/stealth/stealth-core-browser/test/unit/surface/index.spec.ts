/**
 * The package root is the one public entry: every namespace and verb is
 * exported through it and the manager seam is reachable from `lifecycle`.
 * Ticket 8468f7b1 · [tests-unit-surface.1] [tests-unit-surface.2] · surface-api.
 *
 * Importing the root loads the real library graph; the process and network
 * boundaries (`node:child_process`, `fetch`, WebSocket) are stubbed so that
 * nothing can spawn or connect during import.
 * guards: exposes the library classes through their namespaces
 * tier: S
 * cites: 8468f7b1 [tests-unit-surface.1] [tests-unit-surface.2]
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

import * as root from '../../../src/index.js'

const NAMESPACES = ['cdp', 'storage', 'capture', 'parsers', 'chromeManager', 'lifecycle'] as const
const VERBS = ['chromeStatus', 'launchChrome', 'shutdownChrome', 'listPageTargets', 'checkChromeActivity', 'getPageContext'] as const

describe('package root', () => {
  it.each(NAMESPACES)('exports the %s namespace as a module object', (ns) => {
    const value = (root as Record<string, unknown>)[ns]
    expect(value).toBeTypeOf('object')
    expect(Object.keys(value as object).length).toBeGreaterThan(0)
  })

  it.each(VERBS)('exports the %s verb as an async function', (verb) => {
    const fn = (root as Record<string, unknown>)[verb]
    expect(fn).toBeTypeOf('function')
    expect((fn as { constructor: { name: string } }).constructor.name).toBe('AsyncFunction')
  })

  it('exposes the library classes through their namespaces', () => {
    expect(root.chromeManager.ChromeManager).toBeTypeOf('function')
    expect(root.cdp.CdpClient).toBeTypeOf('function')
    expect(root.storage.HistoryClient).toBeTypeOf('function')
    expect(root.storage.CookieClient).toBeTypeOf('function')
  })

  it('reaches the manager seam from the root', () => {
    expect(root.lifecycle.configureManagers).toBeTypeOf('function')
    expect(root.lifecycle.managerFor).toBeTypeOf('function')
    expect(root.lifecycle.chromeExitTarget.release).toBeTypeOf('function')
    expect(root.lifecycle.chromeExitTarget.shutdownIfIdle).toBeTypeOf('function')
  })

  it('has no default export', () => {
    expect('default' in root).toBe(false)
  })
})
