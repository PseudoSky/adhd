/**
 * The Chrome launch failure modes of cdp/browser.ts reach the caller as typed codes, and a spawn failure
 * (ENOENT, EADDRINUSE) is classified instead of crashing the process with an unhandled event.
 * Ticket 8468f7b1 · [prod-errors.2] [prod-errors.8] · PA5.1 / PA5.4 · CHROME_NOT_FOUND, CHROME_START_TIMEOUT, PORT_IN_USE.
 * node:child_process, node:fs, node:os and ./targets are mocked: no Chrome is launched, no process is signalled,
 * and the developer's live Chrome on 9222 is never contacted.
 * guards: rejects with CHROME_NOT_FOUND before spawning when the binary is missing, naming the standard install location and not an environment variable
 * tier: S
 * cites: 8468f7b1 [prod-errors.2] [prod-errors.8]
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  homedir: vi.fn(),
  platform: vi.fn(),
  tmpdir: vi.fn(),
  isChromeReachable: vi.fn(),
}))

vi.mock('node:child_process', () => ({ execSync: m.execSync, spawn: m.spawn }))
vi.mock('node:fs', () => ({
  existsSync: m.existsSync,
  mkdirSync: m.mkdirSync,
  openSync: m.openSync,
  closeSync: m.closeSync,
  unlinkSync: m.unlinkSync,
  statSync: m.statSync,
}))
vi.mock('node:os', () => ({ homedir: m.homedir, platform: m.platform, tmpdir: m.tmpdir }))
vi.mock('../../../src/lib/cdp/targets.js', () => ({ isChromeReachable: m.isChromeReachable }))

import { launchChrome } from '../../../src/lib/cdp/browser.js'
import { StealthCoreBrowserError } from '../../../src/errors.js'

const PORT = 9333
const CHROME = '/fake/bin/chrome'
const PROFILE = '/fake/profile'

interface FakeChild {
  pid: number
  unref: ReturnType<typeof vi.fn>
  once: (event: string, fn: (e: Error) => void) => FakeChild
  fail: (e: Error) => void
}

function fakeChild(): FakeChild {
  let onError: ((e: Error) => void) | undefined
  const child: FakeChild = {
    pid: 4242,
    unref: vi.fn(),
    once: (event, fn) => {
      if (event === 'error') onError = fn
      return child
    },
    fail: (e) => onError?.(e),
  }
  return child
}

beforeEach(() => {
  vi.useFakeTimers()
  for (const fn of Object.values(m)) fn.mockReset()
  m.homedir.mockReturnValue('/fake/home')
  m.platform.mockReturnValue('darwin')
  m.tmpdir.mockReturnValue('/fake/tmp')
  m.existsSync.mockReturnValue(true)
  m.openSync.mockReturnValue(11)
  m.isChromeReachable.mockResolvedValue(false)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('8468f7b1 [prod-errors.2] launchChrome rejects with a typed code (PA5.4)', () => {
  it('rejects with CHROME_NOT_FOUND before spawning when the binary is missing, naming the standard install location and not an environment variable', async () => {
    m.existsSync.mockReturnValue(false)
    const p = launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    await expect(p).rejects.toMatchObject({ code: 'CHROME_NOT_FOUND', message: expect.stringContaining(`Chrome binary not found at "${CHROME}"`), detail: { path: CHROME, port: PORT } })
    await expect(p).rejects.toBeInstanceOf(StealthCoreBrowserError)
    // [audit-fixes.5] the library reads no environment variable, so the message must not tell the user to set one.
    await expect(p).rejects.toMatchObject({ message: expect.not.stringContaining('CHROME_PATH') })
    await expect(p).rejects.toMatchObject({ message: expect.stringContaining('Install Chrome in its standard location') })
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('rejects with CHROME_START_TIMEOUT when CDP never answers within 10 s', async () => {
    m.spawn.mockReturnValue(fakeChild())
    const p = launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    const assertion = expect(p).rejects.toMatchObject({ code: 'CHROME_START_TIMEOUT', message: expect.stringContaining(`Chrome did not start CDP on port ${PORT} within 10s`), detail: { port: PORT } })
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
  })

  it('a spawn that fails with ENOENT rejects with CHROME_NOT_FOUND, the spawn error kept as the cause', async () => {
    const child = fakeChild()
    m.spawn.mockReturnValue(child)
    const p = launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    const cause = Object.assign(new Error(`spawn ${CHROME} ENOENT`), { code: 'ENOENT' })
    const assertion = expect(p).rejects.toMatchObject({ code: 'CHROME_NOT_FOUND', cause })
    await vi.advanceTimersByTimeAsync(1)
    child.fail(cause)
    await assertion
  })

  it('a spawn that fails with EADDRINUSE rejects with PORT_IN_USE, the spawn error kept as the cause', async () => {
    const child = fakeChild()
    m.spawn.mockReturnValue(child)
    const p = launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    const cause = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' })
    const assertion = expect(p).rejects.toMatchObject({ code: 'PORT_IN_USE', cause })
    await vi.advanceTimersByTimeAsync(1)
    child.fail(cause)
    await assertion
  })

  it('any other spawn failure (EACCES) rejects with LAUNCH_FAILED', async () => {
    const child = fakeChild()
    m.spawn.mockReturnValue(child)
    const p = launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    const assertion = expect(p).rejects.toMatchObject({ code: 'LAUNCH_FAILED', detail: { path: CHROME, port: PORT } })
    await vi.advanceTimersByTimeAsync(1)
    child.fail(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))
    await assertion
  })
})
