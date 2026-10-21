/**
 * A hosting process shuts Chrome down softly on every exit path, through the
 * public manager seam: `lifecycle.chromeExitTarget` reaches every live manager
 * and `lifecycle.installProcessExitHooks` runs release then the soft shutdown once.
 * Ticket 8468f7b1 · [tests-unit-surface.6] · [fs-198] [fs-199] [fs-200] [fs-201] [fs-202] [fs-203]
 *
 * `ChromeManager` is replaced by a recording fake and `process` by an
 * EventEmitter under fake timers: no real signal handler, no Chrome, no process.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const world = vi.hoisted(() => ({
  calls: [] as string[],
  shutdownMs: 0,
}))

vi.mock('../../../lib/chrome-manager.js', () => ({
  ChromeManager: class {
    constructor(public readonly opts: { cdpHost: string }) {}
    async release(): Promise<void> {
      world.calls.push(`release:${this.opts.cdpHost}`)
    }
    async shutdownIfIdle(): Promise<void> {
      world.calls.push(`shutdownIfIdle:${this.opts.cdpHost}`)
      if (world.shutdownMs) await new Promise((r) => setTimeout(r, world.shutdownMs))
    }
  },
}))

import { lifecycle } from '../../../index.js'
import type { ExitHookProcess, ExitHookStdin } from '../../../lib/lifecycle/exit-hooks.js'

let proc: EventEmitter
let stdin: EventEmitter
let exit: ReturnType<typeof vi.fn>
let logs: string[]

function install(extra: { stdinEof?: boolean } = {}): () => void {
  return lifecycle.installProcessExitHooks(lifecycle.chromeExitTarget, {
    proc: proc as unknown as ExitHookProcess,
    stdin: stdin as unknown as ExitHookStdin,
    exit: exit as unknown as (code: number) => void,
    logger: (m) => logs.push(m),
    ...extra,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  world.calls = []
  world.shutdownMs = 0
  proc = new EventEmitter()
  stdin = new EventEmitter()
  exit = vi.fn()
  logs = []
  lifecycle.configureManagers({})
  lifecycle.managerFor('127.0.0.1', 19001, '/profile/one')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('exit hooks on a hosting process', () => {
  it('[fs-198] an uncaught exception runs the soft shutdown once', async () => {
    install()
    proc.emit('uncaughtException', new Error('kaboom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(world.calls.filter((c) => c.startsWith('shutdownIfIdle'))).toHaveLength(1)
    expect(world.calls.indexOf('release:127.0.0.1:19001')).toBeLessThan(world.calls.indexOf('shutdownIfIdle:127.0.0.1:19001'))
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
    expect(logs.some((l) => l.includes('kaboom'))).toBe(true)
  })

  it('[fs-199] runs the exit sequence only once', async () => {
    world.shutdownMs = 500
    install()
    proc.emit('SIGINT')
    proc.emit('SIGTERM')
    proc.emit('unhandledRejection', new Error('late'), Promise.resolve())
    await vi.advanceTimersByTimeAsync(500)
    expect(world.calls.filter((c) => c.startsWith('shutdownIfIdle'))).toHaveLength(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(130)
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('[fs-200] signals run the soft shutdown within five seconds (%s)', async (sig, code) => {
    install()
    proc.emit(sig)
    await vi.advanceTimersByTimeAsync(0)
    expect(world.calls).toEqual(['release:127.0.0.1:19001', 'shutdownIfIdle:127.0.0.1:19001'])
    expect(exit).toHaveBeenCalledExactlyOnceWith(code)
  })

  it('[fs-201] forces exit when shutdown exceeds five seconds', async () => {
    world.shutdownMs = 60_000
    install()
    proc.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledExactlyOnceWith(143)
    expect(logs.some((l) => l.includes('forcing exit'))).toBe(true)
  })

  it('[fs-202] stdin end triggers the shutdown', async () => {
    install({ stdinEof: true })
    stdin.emit('end')
    await vi.advanceTimersByTimeAsync(0)
    expect(world.calls).toContain('shutdownIfIdle:127.0.0.1:19001')
    expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  })

  it('[fs-202] stdin end is ignored unless the host opts in', async () => {
    install()
    stdin.emit('end')
    await vi.advanceTimersByTimeAsync(0)
    expect(world.calls).toEqual([])
    expect(exit).not.toHaveBeenCalled()
  })

  it('[fs-203] a fatal main rejection exits gracefully', async () => {
    install()
    proc.emit('unhandledRejection', new Error('main failed'), Promise.resolve())
    await vi.advanceTimersByTimeAsync(0)
    expect(world.calls).toContain('shutdownIfIdle:127.0.0.1:19001')
    expect(exit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('chromeExitTarget reaches every live manager and the uninstall removes every listener', async () => {
    lifecycle.managerFor('127.0.0.1', 19002)
    const uninstall = install({ stdinEof: true })
    uninstall()
    expect(proc.listenerCount('SIGINT')).toBe(0)
    expect(stdin.listenerCount('end')).toBe(0)
    await lifecycle.chromeExitTarget.shutdownIfIdle()
    expect(world.calls).toEqual(expect.arrayContaining(['shutdownIfIdle:127.0.0.1:19001', 'shutdownIfIdle:127.0.0.1:19002']))
  })
})
