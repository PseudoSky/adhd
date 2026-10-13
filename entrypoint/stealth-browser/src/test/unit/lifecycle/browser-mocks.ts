/**
 * Shared doubles for the lifecycle specs that drive src/lib/cdp/browser.ts.
 * Each spec declares the `vi.mock` calls itself (they are hoisted per file)
 * and installs `processDoubles().kill` with `vi.spyOn(process, 'kill')`
 * (this module imports nothing from the test runner).
 * No Chrome is launched, no process is signalled, port 9222 is never contacted.
 * Ticket 8468f7b1 · plan state chrome-lifecycle ([chrome-lifecycle.11] [chrome-lifecycle.12]).
 */
export interface KillEntry {
  pid: number
  sig: string | number | undefined
}

export interface ProcessDoubles {
  /** Every process.kill call, in order (signal-0 probes included). */
  log: KillEntry[]
  /** Pids that answer a signal-0 probe (still alive). */
  alive: Set<number>
  /** Negative pids whose group signal throws (not a group leader). */
  ungrouped: Set<number>
  /** The replacement for process.kill: logs, never signals anything real. */
  kill: typeof process.kill
}

export function processDoubles(): ProcessDoubles {
  const d = { log: [] as KillEntry[], alive: new Set<number>(), ungrouped: new Set<number>() }
  const kill = ((pid: number, sig?: string | number) => {
    d.log.push({ pid, sig })
    if (sig === 0 && !d.alive.has(pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    if (pid < 0 && d.ungrouped.has(pid)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    return true
  }) as typeof process.kill
  return { ...d, kill }
}

/** The signals delivered (signal-0 liveness probes removed). */
export function signals(log: KillEntry[]): KillEntry[] {
  return log.filter((e) => e.sig !== 0)
}

/** A scripted `execSync`: the first needle contained in the command decides the output (or throw). */
export function execScript(map: Record<string, string | Error>): (cmd: string) => string {
  return (cmd: string) => {
    for (const [needle, out] of Object.entries(map)) {
      if (cmd.includes(needle)) {
        if (out instanceof Error) throw out
        return out
      }
    }
    throw new Error(`unexpected exec: ${cmd}`)
  }
}
