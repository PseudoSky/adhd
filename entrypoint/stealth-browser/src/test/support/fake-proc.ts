/**
 * Fake process table for the unit lane.
 * Ticket 8468f7b1 · criterion [cdp-test-harness.6]
 *
 * `FakeProc` simulates liveness (`pidAlive`), process identity (`procStart`,
 * the start-time token that distinguishes a recycled pid), signal delivery
 * (`kill(pid | -pgid, signal)`, logged, never touches a real process) and a
 * recording `spawn`. Nothing here touches a real process.
 */

export interface SpawnCall {
  command: string
  args: string[]
  opts: Record<string, unknown>
  pid: number
}

export interface KillCall {
  /** Positive pid, or negative pgid to signal the whole group. */
  target: number
  signal: string | number
}

export interface FakeProcEntry {
  pid: number
  pgid: number
  start: string
  alive: boolean
  command: string
}

export class FakeProc {
  readonly killLog: KillCall[] = []
  readonly spawnLog: SpawnCall[] = []
  private table = new Map<number, FakeProcEntry>()
  private nextPid: number
  private startSeq = 0

  constructor(firstPid = 4000) {
    this.nextPid = firstPid
  }

  /** Register an already-running process (e.g. a Chrome another manager launched). Returns its entry. */
  addProcess(init: { pid?: number; pgid?: number; start?: string; command?: string } = {}): FakeProcEntry {
    const pid = init.pid ?? this.nextPid++
    const entry: FakeProcEntry = {
      pid,
      pgid: init.pgid ?? pid,
      start: init.start ?? `start-${++this.startSeq}`,
      alive: true,
      command: init.command ?? 'fake',
    }
    this.table.set(pid, entry)
    return entry
  }

  /** True while the process exists and has not died; unknown pids are dead. */
  pidAlive(pid: number): boolean {
    return this.table.get(pid)?.alive === true
  }

  /** Start-time token for a live pid; null when dead/unknown. A recycled pid gets a different token. */
  procStart(pid: number): string | null {
    const e = this.table.get(pid)
    return e?.alive ? e.start : null
  }

  /**
   * Deliver a signal. Mirrors process.kill: signal 0 probes only (throws ESRCH
   * when absent), a negative target signals every live member of that group,
   * SIGTERM/SIGKILL (and numeric 15/9) kill. Every call is logged first.
   */
  kill(target: number, signal: string | number = 'SIGTERM'): true {
    this.killLog.push({ target, signal })
    const victims =
      target < 0
        ? [...this.table.values()].filter((e) => e.alive && e.pgid === -target)
        : [this.table.get(target)].filter((e): e is FakeProcEntry => e?.alive === true)
    if (victims.length === 0) {
      const err = new Error(`kill ESRCH ${target}`) as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    }
    if (signal === 0 || signal === '0') return true
    if (signal === 'SIGTERM' || signal === 15 || signal === 'SIGKILL' || signal === 9 || signal === 'SIGINT') {
      for (const v of victims) v.alive = false
    }
    return true
  }

  /** Recording spawn: allocates a live process (its own group leader) and returns `{ pid }`. */
  spawn(command: string, args: string[] = [], opts: Record<string, unknown> = {}): { pid: number; unref(): void } {
    const entry = this.addProcess({ command })
    this.spawnLog.push({ command, args, opts, pid: entry.pid })
    return { pid: entry.pid, unref: () => undefined }
  }

  /** Test helper: the process dies by itself (crash). */
  die(pid: number): void {
    const e = this.table.get(pid)
    if (e) e.alive = false
  }

  /** Test helper: the OS recycles `pid` for an unrelated new process (new start token). */
  recycle(pid: number): FakeProcEntry {
    return this.addProcess({ pid, command: 'unrelated' })
  }
}
