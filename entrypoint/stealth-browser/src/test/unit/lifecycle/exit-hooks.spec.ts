/**
 * CL14 (F23, gap G2) exit hooks.
 * Ticket 8468f7b1 · [chrome-lifecycle.14]
 *
 * `installProcessExitHooks(manager, { forceExitMs = 5000, stdinEof, exit })`
 * against an injected EventEmitter standing in for `process` (no real signal
 * handler is ever installed) and fake timers.
 */
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProcessExitHooks, type ExitHookProcess, type ExitHookStdin } from '../../../lib/lifecycle/exit-hooks.js'

interface Rig {
  proc: EventEmitter
  stdin: EventEmitter
  calls: string[]
  exit: ReturnType<typeof vi.fn>
  manager: { release: ReturnType<typeof vi.fn>; shutdownIfIdle: ReturnType<typeof vi.fn> }
  logs: string[]
}

function rig(opts: { shutdownMs?: number; releaseThrows?: boolean; shutdownThrows?: boolean } = {}): Rig {
  const calls: string[] = []
  const r: Rig = {
    proc: new EventEmitter(),
    stdin: new EventEmitter(),
    calls,
    exit: vi.fn((code: number) => {
      calls.push(`exit:${code}`)
    }),
    manager: {
      release: vi.fn(async () => {
        calls.push('release')
        if (opts.releaseThrows) throw new Error('link down')
      }),
      shutdownIfIdle: vi.fn(async () => {
        calls.push('shutdownIfIdle:start')
        if (opts.shutdownMs) await new Promise((res) => setTimeout(res, opts.shutdownMs))
        if (opts.shutdownThrows) throw new Error('kill failed')
        calls.push('shutdownIfIdle:end')
      }),
    },
    logs: [],
  }
  return r
}

function install(r: Rig, extra: { stdinEof?: boolean; forceExitMs?: number } = {}) {
  return installProcessExitHooks(r.manager, {
    exit: r.exit,
    proc: r.proc as unknown as ExitHookProcess,
    stdin: r.stdin as unknown as ExitHookStdin,
    logger: (m) => r.logs.push(m),
    ...extra,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('8468f7b1 [chrome-lifecycle.14] each exit path runs release() then the soft shutdown once', () => {
  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)('%s: release, then shutdownIfIdle, then exit %i', async (sig, code) => {
    const r = rig()
    install(r)
    r.proc.emit(sig)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual(['release', 'shutdownIfIdle:start', 'shutdownIfIdle:end', `exit:${code}`])
  })

  it('uncaughtException: exit code 1, the error is logged', async () => {
    const r = rig()
    install(r)
    r.proc.emit('uncaughtException', new Error('kaboom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual(['release', 'shutdownIfIdle:start', 'shutdownIfIdle:end', 'exit:1'])
    expect(r.logs.some((l) => l.includes('kaboom'))).toBe(true)
  })

  it('unhandledRejection: exit code 1', async () => {
    const r = rig()
    install(r)
    r.proc.emit('unhandledRejection', new Error('nope'), Promise.resolve())
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual(['release', 'shutdownIfIdle:start', 'shutdownIfIdle:end', 'exit:1'])
  })

  it('stdin end (opt-in, orphaned stdio server): release then soft shutdown, exit 0', async () => {
    const r = rig()
    install(r, { stdinEof: true })
    r.stdin.emit('end')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual(['release', 'shutdownIfIdle:start', 'shutdownIfIdle:end', 'exit:0'])
  })

  it('stdin end is ignored unless stdinEof is set', async () => {
    const r = rig()
    install(r)
    r.stdin.emit('end')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual([])
    expect(r.stdin.listenerCount('end')).toBe(0)
  })

  it('exit (synchronous): starts release and the soft shutdown, never calls exit again', async () => {
    const r = rig()
    install(r)
    r.proc.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual(['release', 'shutdownIfIdle:start', 'shutdownIfIdle:end'])
    expect(r.exit).not.toHaveBeenCalled()
  })

  it('runs once: a second signal while shutting down is ignored', async () => {
    const r = rig({ shutdownMs: 1_000 })
    install(r)
    r.proc.emit('SIGINT')
    r.proc.emit('SIGTERM')
    r.proc.emit('uncaughtException', new Error('late'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(r.manager.release).toHaveBeenCalledTimes(1)
    expect(r.manager.shutdownIfIdle).toHaveBeenCalledTimes(1)
    expect(r.exit).toHaveBeenCalledTimes(1)
    expect(r.exit).toHaveBeenCalledWith(130)
  })

  it('a failing release (link down) still runs the soft shutdown', async () => {
    const r = rig({ releaseThrows: true })
    install(r)
    r.proc.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual(['release', 'shutdownIfIdle:start', 'shutdownIfIdle:end', 'exit:143'])
    expect(r.logs.some((l) => l.includes('release failed'))).toBe(true)
  })

  it('a failing soft shutdown is logged and the process still exits', async () => {
    const r = rig({ shutdownThrows: true })
    install(r)
    r.proc.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.exit).toHaveBeenCalledWith(130)
    expect(r.logs.some((l) => l.includes('soft shutdown failed'))).toBe(true)
  })
})

describe('8468f7b1 [chrome-lifecycle.14] bounded by a force-exit', () => {
  it('force-exits after 5000 ms by default when the teardown hangs', async () => {
    const r = rig({ shutdownMs: 60_000 })
    install(r)
    r.proc.emit('SIGTERM')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(r.exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(r.exit).toHaveBeenCalledTimes(1)
    expect(r.exit).toHaveBeenCalledWith(143)
    // The hung teardown finishing later never exits a second time.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.exit).toHaveBeenCalledTimes(1)
  })

  it('honours a custom forceExitMs', async () => {
    const r = rig({ shutdownMs: 60_000 })
    install(r, { forceExitMs: 250 })
    r.proc.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(250)
    expect(r.exit).toHaveBeenCalledWith(130)
  })

  it('a teardown that finishes in time cancels the force-exit', async () => {
    const r = rig({ shutdownMs: 100 })
    install(r)
    r.proc.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(100)
    expect(r.exit).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.exit).toHaveBeenCalledTimes(1)
  })
})

describe('8468f7b1 [chrome-lifecycle.14] uninstall', () => {
  it('removes every listener it added (and is idempotent)', () => {
    const r = rig()
    const before = ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((e) => r.proc.listenerCount(e))
    const uninstall = install(r, { stdinEof: true })
    expect(['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((e) => r.proc.listenerCount(e))).toEqual([1, 1, 1, 1, 1])
    expect(r.stdin.listenerCount('end')).toBe(1)
    uninstall()
    uninstall()
    expect(['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'].map((e) => r.proc.listenerCount(e))).toEqual(before)
    expect(r.stdin.listenerCount('end')).toBe(0)
  })

  it('after uninstall a signal does nothing', async () => {
    const r = rig()
    install(r)()
    r.proc.emit('SIGINT')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.calls).toEqual([])
  })
})
