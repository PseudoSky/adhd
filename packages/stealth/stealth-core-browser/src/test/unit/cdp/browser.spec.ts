/**
 * Unit spec for src/lib/cdp/browser.ts.
 * Ticket 8468f7b1 AC2 (behavior-preserving port, unit lane) ·
 * criteria [tests-unit-core.1] [tests-unit-core.2] [tests-unit-core.3] [tests-unit-core.4].
 * node:child_process, node:fs, node:os and ./targets are mocked and process.kill is spied:
 * no Chrome is launched, no process is signalled, no real profile or HOME is touched,
 * and the developer's live Chrome is never contacted.
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
vi.mock('../../../lib/cdp/targets.js', () => ({ isChromeReachable: m.isChromeReachable }))

type BrowserModule = typeof import('../../../lib/cdp/browser.js')

/** Fresh module so the tracked launchedPid starts null. */
async function loadFresh(): Promise<BrowserModule> {
  vi.resetModules()
  return import('../../../lib/cdp/browser.js')
}

const PORT = 9333
const CHROME = '/fake/bin/chrome'
const PROFILE = '/fake/profile'
const LOCK = `/fake/tmp/stealth-chrome-launch-${PORT}.lock`

let kill: ReturnType<typeof vi.spyOn>
let alive: Set<number>
let errorSpy: ReturnType<typeof vi.spyOn>

function fakeChild(pid: number | undefined): { pid: number | undefined; unref: ReturnType<typeof vi.fn> } {
  return { pid, unref: vi.fn() }
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
  alive = new Set()
  // process.kill is fully replaced: nothing real is ever signalled.
  kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0 && !alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    return true
  }) as typeof process.kill)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Launch with a mocked child so the module tracks `pid`. */
async function launchTracked(mod: BrowserModule, pid: number): Promise<void> {
  m.spawn.mockReturnValue(fakeChild(pid))
  m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
  const p = mod.launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
  await vi.advanceTimersByTimeAsync(250)
  await p
}

describe('8468f7b1 AC2 [tests-unit-core.1] launchChrome', () => {
  it('is idempotent: returns alreadyRunning without spawning when CDP answers', async () => {
    const { launchChrome } = await loadFresh()
    m.isChromeReachable.mockResolvedValue(true)
    const r = await launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    expect(r).toEqual({ pid: null, port: PORT, alreadyRunning: true, profileDir: PROFILE })
    expect(m.isChromeReachable).toHaveBeenCalledWith(`127.0.0.1:${PORT}`)
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('[fs-070] never passes --enable-automation: spawns with --remote-debugging-port and WITHOUT --enable-automation', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    expect(m.spawn).toHaveBeenCalledTimes(1)
    const [bin, args, opts] = m.spawn.mock.calls[0] as [string, string[], Record<string, unknown>]
    expect(bin).toBe(CHROME)
    expect(args).toContain(`--remote-debugging-port=${PORT}`)
    expect(args).toContain(`--user-data-dir=${PROFILE}`)
    expect(args.some((a) => a.includes('--enable-automation'))).toBe(false)
    expect(args).not.toContain('--enable-automation')
    expect(opts).toMatchObject({ stdio: 'ignore', detached: true })
  })

  it('[fs-071] passes disable-backgrounding-occluded-windows so minimized windows are not timer-throttled', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 11)
    const args = m.spawn.mock.calls[0][1] as string[]
    expect(args).toContain('--disable-backgrounding-occluded-windows')
  })

  it('[fs-072] launches minimized without first-run or default-browser prompts', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 12)
    const args = m.spawn.mock.calls[0][1] as string[]
    expect(args).toEqual(expect.arrayContaining(['--no-first-run', '--start-minimized', '--no-default-browser-check']))
    expect(args).not.toContain('--enable-automation')
  })

  it('[fs-073] appends extraArgs after the built-in flags', async () => {
    const mod = await loadFresh()
    m.spawn.mockReturnValue(fakeChild(1))
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const p = mod.launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE, extraArgs: ['--foo', '--bar=1'] })
    await vi.advanceTimersByTimeAsync(250)
    await p
    const args = m.spawn.mock.calls[0][1] as string[]
    expect(args.slice(-2)).toEqual(['--foo', '--bar=1'])
    expect(args.indexOf('--foo')).toBeGreaterThan(args.indexOf('--no-default-browser-check'))
  })

  it('detaches the child (unref) and returns its pid once CDP answers', async () => {
    const mod = await loadFresh()
    const child = fakeChild(4242)
    m.spawn.mockReturnValue(child)
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const p = mod.launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    await vi.advanceTimersByTimeAsync(250)
    await expect(p).resolves.toEqual({ pid: 4242, port: PORT, alreadyRunning: false, profileDir: PROFILE })
    expect(child.unref).toHaveBeenCalledTimes(1)
    expect(m.mkdirSync).toHaveBeenCalledWith(PROFILE, { recursive: true })
  })

  it('reports a null pid when spawn yields none', async () => {
    const mod = await loadFresh()
    m.spawn.mockReturnValue(fakeChild(undefined))
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const p = mod.launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    await vi.advanceTimersByTimeAsync(250)
    expect((await p).pid).toBeNull()
  })

  it('rejects when CDP never comes up within 10s (error path)', async () => {
    const mod = await loadFresh()
    m.spawn.mockReturnValue(fakeChild(4242))
    const p = mod.launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    const assertion = expect(p).rejects.toThrow(`Chrome did not start CDP on port ${PORT} within 10s`)
    await vi.advanceTimersByTimeAsync(10_500)
    await assertion
  })

  it('[fs-075] fails before spawning when the binary is missing: rejects with an actionable message when the binary is missing (negative)', async () => {
    const { launchChrome } = await loadFresh()
    m.existsSync.mockReturnValue(false)
    await expect(launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })).rejects.toThrow(
      `Chrome binary not found at "${CHROME}"`,
    )
    await expect(launchChrome({ port: PORT, chromePath: CHROME, profileDir: PROFILE })).rejects.toThrow('CHROME_PATH')
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('[fs-076] uses a dedicated profile directory: derives the profile dir from the mocked HOME when none is given', async () => {
    const { launchChrome } = await loadFresh()
    m.isChromeReachable.mockResolvedValue(true)
    const r = await launchChrome({ port: PORT, chromePath: CHROME })
    expect(r.profileDir.startsWith('/fake/home/')).toBe(true)
    expect(r.profileDir.endsWith('Chrome-CDP')).toBe(true)
    expect(m.mkdirSync).toHaveBeenCalledWith(expect.stringMatching(/^\/fake\/home\//), { recursive: true })
    expect(r.profileDir).not.toContain('/fake/home/.config/google-chrome')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] [fs-074] resolves the Chrome binary per platform', () => {
  it('[fs-074] an explicit chromePath overrides the per-platform default', async () => {
    const mod = await loadFresh()
    m.platform.mockReturnValue('linux')
    await launchTracked(mod, 13)
    expect(m.spawn.mock.calls[0][0]).toBe(CHROME)
    expect(m.execSync).not.toHaveBeenCalled()
  })


  async function missingMessage(): Promise<string> {
    const { launchChrome } = await loadFresh()
    m.existsSync.mockReturnValue(false)
    try {
      await launchChrome({ port: PORT, profileDir: PROFILE })
    } catch (e) {
      return (e as Error).message
    }
    return ''
  }

  it('darwin uses the macOS app bundle path', async () => {
    m.platform.mockReturnValue('darwin')
    expect(await missingMessage()).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })

  it('win32 uses the Program Files path', async () => {
    m.platform.mockReturnValue('win32')
    expect(await missingMessage()).toContain('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  })

  it('linux resolves the binary through `which` (mocked exec)', async () => {
    m.platform.mockReturnValue('linux')
    m.execSync.mockReturnValue('/usr/bin/google-chrome\n')
    expect(await missingMessage()).toContain('"/usr/bin/google-chrome"')
    expect(m.execSync).toHaveBeenCalledWith(expect.stringContaining('which google-chrome'), { encoding: 'utf8' })
  })

  it('linux with no installed browser yields an empty path and a not-found error', async () => {
    m.platform.mockReturnValue('linux')
    m.execSync.mockImplementation(() => {
      throw new Error('not found')
    })
    expect(await missingMessage()).toContain('Chrome binary not found at ""')
  })

  it('an unknown platform yields an empty path and a not-found error', async () => {
    m.platform.mockReturnValue('freebsd')
    expect(await missingMessage()).toContain('Chrome binary not found at ""')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] ensureChromeRunning', () => {
  it('no-ops (no lock, no spawn) when Chrome is already reachable', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.isChromeReachable.mockResolvedValue(true)
    const r = await ensureChromeRunning({ port: PORT, profileDir: PROFILE })
    expect(r).toEqual({ pid: null, port: PORT, profileDir: PROFILE })
    expect(m.openSync).not.toHaveBeenCalled()
    expect(m.spawn).not.toHaveBeenCalled()
  })

  it('takes the exclusive per-port lock, launches, then releases the lock', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.spawn.mockReturnValue(fakeChild(555))
    // initial check, re-check under lock, launchChrome check: all down; then up while polling
    m.isChromeReachable
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const p = ensureChromeRunning({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    await vi.advanceTimersByTimeAsync(250)
    const r = await p
    expect(m.openSync).toHaveBeenCalledWith(LOCK, 'wx')
    expect(r).toMatchObject({ pid: 555, port: PORT })
    expect(m.closeSync).toHaveBeenCalledWith(11)
    expect(m.unlinkSync).toHaveBeenCalledWith(LOCK)
    expect(errorSpy).toHaveBeenCalledWith(`[cdp] Chrome not found on port ${PORT} — launching...`)
  })

  it('stays quiet when quiet:true', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.spawn.mockReturnValue(fakeChild(555))
    m.isChromeReachable
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    const p = ensureChromeRunning({ port: PORT, chromePath: CHROME, profileDir: PROFILE, quiet: true })
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('releases the lock even when the launch fails (error path)', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.existsSync.mockReturnValue(false)
    await expect(ensureChromeRunning({ port: PORT, chromePath: CHROME, profileDir: PROFILE, quiet: true })).rejects.toThrow(
      'Chrome binary not found',
    )
    expect(m.closeSync).toHaveBeenCalledWith(11)
    expect(m.unlinkSync).toHaveBeenCalledWith(LOCK)
  })

  it('loser of the lock race waits for the winner and does not spawn a second Chrome', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.openSync.mockImplementation(() => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    })
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const p = ensureChromeRunning({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    await vi.advanceTimersByTimeAsync(300)
    await expect(p).resolves.toEqual({ pid: null, port: PORT, profileDir: PROFILE })
    expect(m.spawn).not.toHaveBeenCalled()
    expect(m.unlinkSync).not.toHaveBeenCalled()
  })

  it('reclaims a stale lock after 15s, then proceeds to launch', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.openSync.mockImplementation(() => {
      throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
    })
    m.existsSync.mockReturnValue(false)
    const p = ensureChromeRunning({ port: PORT, chromePath: CHROME, profileDir: PROFILE, quiet: true })
    const assertion = expect(p).rejects.toThrow('Chrome binary not found')
    await vi.advanceTimersByTimeAsync(15_500)
    await assertion
    expect(m.unlinkSync).toHaveBeenCalledWith(LOCK)
    expect(m.openSync.mock.calls.length).toBe(2)
  })

  it('re-checks under the lock and skips the launch if a rival just started Chrome', async () => {
    const { ensureChromeRunning } = await loadFresh()
    m.isChromeReachable.mockResolvedValueOnce(false).mockResolvedValue(true)
    const r = await ensureChromeRunning({ port: PORT, chromePath: CHROME, profileDir: PROFILE })
    expect(r.pid).toBeNull()
    expect(m.spawn).not.toHaveBeenCalled()
    expect(m.unlinkSync).toHaveBeenCalledWith(LOCK)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] isChromeRunning', () => {
  it('is the targets.isChromeReachable probe', async () => {
    const mod = await loadFresh()
    expect(mod.isChromeRunning).toBe(m.isChromeReachable)
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] killChrome — tracked launch', () => {
  it('SIGTERMs the whole process group of the launched Chrome, then SIGKILLs stragglers', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    const p = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
    expect(m.execSync).not.toHaveBeenCalled()
  })

  it('never shells out to lsof for a Chrome this session launched', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    const p = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(m.execSync).not.toHaveBeenCalledWith(expect.stringContaining('lsof'), expect.anything())
  })

  it('stops tracking afterwards, so the next kill uses port discovery', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    const first = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await first
    m.execSync.mockReturnValue('')
    await mod.killChrome(PORT)
    expect(m.execSync).toHaveBeenCalledWith(`lsof -ti tcp:${PORT} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
  })

  it('falls back to a single-pid SIGTERM when the group signal is not deliverable', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    kill.mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) throw new Error('ESRCH')
      if (pid < 0) throw new Error('EPERM')
      return true
    }) as typeof process.kill)
    const p = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(250)
    await p
    expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
  })

  it('gives up waiting after 5s when the main process will not die, then SIGKILLs the group', async () => {
    const mod = await loadFresh()
    await launchTracked(mod, 4242)
    alive.add(4242)
    const p = mod.killChrome(PORT)
    await vi.advanceTimersByTimeAsync(5200)
    await p
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL')
  })
})

describe('8468f7b1 AC2 [tests-unit-core.1] killChrome — port discovery (mocked exec)', () => {
  function execScript(map: Record<string, string | Error>): void {
    m.execSync.mockImplementation((cmd: string) => {
      for (const [needle, out] of Object.entries(map)) {
        if (cmd.includes(needle)) {
          if (out instanceof Error) throw out
          return out
        }
      }
      throw new Error(`unexpected exec: ${cmd}`)
    })
  }

  it('issues `lsof -ti tcp:<port>` through the mocked exec', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: '' , fuser: '' })
    await killChrome(PORT)
    expect(m.execSync).toHaveBeenCalledWith(`lsof -ti tcp:${PORT} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
  })

  it('kills the process group of each listener pid, then SIGKILLs the first group', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: '111\n222\n', 'ps -o pgid= -p 111': '111\n', 'ps -o pgid= -p 222': '300\n' })
    await killChrome(PORT)
    expect(kill).toHaveBeenCalledWith(-111, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-300, 'SIGTERM')
    expect(kill).toHaveBeenCalledWith(-111, 'SIGKILL')
  })

  it('falls back to the pid itself when pgid lookup fails', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: '111\n', 'ps -o pgid=': new Error('ps failed') })
    await killChrome(PORT)
    expect(kill).toHaveBeenCalledWith(-111, 'SIGTERM')
  })

  it('falls back to fuser when lsof is missing', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: new Error('lsof: not found'), fuser: '333', 'ps -o pgid= -p 333': '333' })
    await killChrome(PORT)
    expect(m.execSync).toHaveBeenCalledWith(`fuser ${PORT}/tcp 2>/dev/null`, { encoding: 'utf8', timeout: 3000 })
    expect(kill).toHaveBeenCalledWith(-333, 'SIGTERM')
  })

  it('does nothing when nothing listens on the port (negative)', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: '', fuser: new Error('no fuser') })
    await killChrome(PORT)
    expect(kill).not.toHaveBeenCalled()
  })

  it('falls back to single-pid SIGTERM when the group signal fails', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: '111\n', 'ps -o pgid= -p 111': '111' })
    kill.mockImplementation(((pid: number, sig?: string | number) => {
      if (sig === 0) throw new Error('ESRCH')
      if (pid < 0) throw new Error('EPERM')
      return true
    }) as typeof process.kill)
    await killChrome(PORT)
    expect(kill).toHaveBeenCalledWith(111, 'SIGTERM')
  })

  it('stops waiting after 25 polls (5s) if the listener never exits, with no SIGKILL', async () => {
    const { killChrome } = await loadFresh()
    execScript({ lsof: '111\n', 'ps -o pgid= -p 111': '111' })
    alive.add(111)
    const p = killChrome(PORT)
    await vi.advanceTimersByTimeAsync(5200)
    await p
    expect(kill).not.toHaveBeenCalledWith(-111, 'SIGKILL')
    expect(kill).toHaveBeenCalledWith(-111, 'SIGTERM')
  })
})
