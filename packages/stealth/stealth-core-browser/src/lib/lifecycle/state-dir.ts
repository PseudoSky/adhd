/**
 * @adhd/stealth-core-browser — src/lib/lifecycle/state-dir.ts
 *
 * The per-user, per-port private state directory
 * `<os.tmpdir()>/stealth-browser-<uid>-<port>` that holds the reaper socket,
 * the launched-Chrome owner record and the launch-breaker state. It must be a
 * real directory owned by this uid with mode 0700 (`ensurePrivateSocketDir`).
 * An unsafe or uncreatable directory is NOT a throw: it yields `{ ok: false }`
 * and the manager runs in degraded mode (decision D1).
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.1, CL21 CL28).
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensurePrivateSocketDir } from './sp.js'

export type StateDirResult =
  | { ok: true; dir: string }
  | { ok: false; dir: string; error: unknown }

export interface StateDirOptions {
  /** Explicit directory (ChromeManagerOptions.stateDir). */
  stateDir?: string
  /** Defaults: `os.tmpdir()` and `process.getuid()`. */
  tmpdir?: () => string
  uid?: () => number
}

/** The default state directory path for `port` (not created). */
export function defaultStateDir(port: number, opts: Pick<StateDirOptions, 'tmpdir' | 'uid'> = {}): string {
  const uid = (opts.uid ?? (() => (typeof process.getuid === 'function' ? process.getuid() : 0)))()
  return join((opts.tmpdir ?? tmpdir)(), `stealth-browser-${uid}-${port}`)
}

/** Create (0700) and verify the state directory. Never throws. */
export function resolveStateDir(port: number, opts: StateDirOptions = {}): StateDirResult {
  const dir = opts.stateDir ?? defaultStateDir(port, opts)
  try {
    ensurePrivateSocketDir(dir, { create: true })
    return { ok: true, dir }
  } catch (error) {
    return { ok: false, dir, error }
  }
}
