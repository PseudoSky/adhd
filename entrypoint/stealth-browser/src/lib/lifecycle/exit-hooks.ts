/**
 * @adhd/stealth-browser — src/lib/lifecycle/exit-hooks.ts
 *
 * Shutdown on EVERY exit path of a hosting process (F23, gap G2): `exit`,
 * SIGINT, SIGTERM, uncaughtException, unhandledRejection and — opt-in, for a
 * stdio server whose parent may vanish — stdin end. Each runs, exactly once,
 * `release()` (this process leaves the reaper's registry) and then the SOFT
 * `shutdownIfIdle()` (never a sibling's or a human's Chrome), bounded by a
 * force-exit after `forceExitMs` (default 5000). Exit codes: SIGINT 130,
 * SIGTERM 143, uncaughtException / unhandledRejection 1, stdin end 0.
 *
 * `exit` is synchronous in Node: on it the hooks only START the release and
 * soft shutdown (best effort) and never call `exit` again.
 *
 * The hosts (`src/server.ts`, `src/cli.ts`) wire this in surface-hosts.14.
 * Every process touch point is injectable so the unit lane never installs a
 * real signal handler.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (CL14).
 */

import { errorMessage } from './errors.js'

/** What the hooks need from a ChromeManager. */
export interface ExitHookTarget {
  release(): Promise<void> | void
  shutdownIfIdle(): Promise<void>
}

/** The subset of `process` the hooks listen on. */
export interface ExitHookProcess {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/** The subset of `process.stdin` the opt-in stdin-EOF hook listens on. */
export interface ExitHookStdin {
  on(event: 'end', listener: () => void): unknown
  removeListener(event: 'end', listener: () => void): unknown
}

export interface ExitHookOptions {
  /** Force-exit bound in ms. Default 5000. */
  forceExitMs?: number
  /** Also shut down when stdin ends (orphaned stdio server). Default false. */
  stdinEof?: boolean
  /** Default `process.exit`. */
  exit?: (code: number) => void
  /** Default `process`. */
  proc?: ExitHookProcess
  /** Default `process.stdin`. */
  stdin?: ExitHookStdin
  /** Diagnostics sink. Default `console.error` with a `[exit-hooks]` prefix. */
  logger?: (msg: string) => void
  /** Timer injection (tests use fake timers instead). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const EXIT_CODE_SIGINT = 130
export const EXIT_CODE_SIGTERM = 143
export const EXIT_CODE_FATAL = 1
export const EXIT_CODE_STDIN_EOF = 0

/**
 * Install the exit hooks for `manager`. Returns an uninstall function that
 * removes every listener it added (idempotent).
 */
export function installProcessExitHooks(manager: ExitHookTarget, opts: ExitHookOptions = {}): () => void {
  const forceExitMs = opts.forceExitMs ?? 5000
  const proc: ExitHookProcess = opts.proc ?? (process as unknown as ExitHookProcess)
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const log = opts.logger ?? ((m: string) => console.error(`[exit-hooks] ${m}`))
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let started = false

  /** release() then the soft shutdown, each failure logged, never thrown. */
  const teardown = async (): Promise<void> => {
    try {
      await manager.release()
    } catch (e) {
      log(`release failed: ${errorMessage(e)}`)
    }
    try {
      await manager.shutdownIfIdle()
    } catch (e) {
      log(`soft shutdown failed: ${errorMessage(e)}`)
    }
  }

  const run = (reason: string, code: number): void => {
    if (started) return
    started = true
    log(`${reason}: releasing and shutting Chrome down if idle (exit ${code})`)
    let exited = false
    const finish = (): void => {
      if (exited) return
      exited = true
      exit(code)
    }
    const force = setTimer(() => {
      log(`teardown exceeded ${forceExitMs} ms: forcing exit ${code}`)
      finish()
    }, forceExitMs)
    void teardown().then(() => {
      clearTimer(force)
      finish()
    })
  }

  const onExit = (): void => {
    if (started) return
    started = true
    // Synchronous `exit`: start the teardown best effort; the process is already leaving.
    void teardown()
  }
  const onSigint = (): void => run('SIGINT', EXIT_CODE_SIGINT)
  const onSigterm = (): void => run('SIGTERM', EXIT_CODE_SIGTERM)
  const onUncaught = (err: unknown): void => {
    log(`uncaughtException: ${errorMessage(err)}`)
    run('uncaughtException', EXIT_CODE_FATAL)
  }
  const onUnhandled = (reason: unknown): void => {
    log(`unhandledRejection: ${errorMessage(reason)}`)
    run('unhandledRejection', EXIT_CODE_FATAL)
  }
  const onStdinEnd = (): void => run('stdin end', EXIT_CODE_STDIN_EOF)

  const listeners: Array<[string, (...args: unknown[]) => void]> = [
    ['exit', onExit],
    ['SIGINT', onSigint],
    ['SIGTERM', onSigterm],
    ['uncaughtException', onUncaught as (...args: unknown[]) => void],
    ['unhandledRejection', onUnhandled as (...args: unknown[]) => void],
  ]
  for (const [ev, fn] of listeners) proc.on(ev, fn)

  const stdin = opts.stdinEof ? (opts.stdin ?? (process.stdin as unknown as ExitHookStdin)) : null
  stdin?.on('end', onStdinEnd)

  let installed = true
  return () => {
    if (!installed) return
    installed = false
    for (const [ev, fn] of listeners) proc.removeListener(ev, fn)
    stdin?.removeListener('end', onStdinEnd)
  }
}
