/**
 * @adhd/stealth-browser — src/lib/lifecycle/ownership.ts
 *
 * The single-writer launched-Chrome record `<stateDir>/chrome-<port>.json` =
 * `{ pid, procStart, port, profileDir, launchedAt }`. Only the process whose
 * `ensureChromeRunning` actually spawned Chrome (a non-null pid) writes it,
 * atomically (temp file + rename). The record is VALID only while
 * `isSameProcess(pid, procStart)` holds — the pid is alive AND its start token
 * is unchanged — so a recycled pid is never signalled. All I/O is best effort
 * (F26): a failure is logged and never fails a call.
 *
 * Ticket 8468f7b1 · plan state chrome-lifecycle (SPEC-single-pass-lifecycle.md 3.1, CL12 CL21).
 */

import * as nodeFs from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from './errors.js'
import type { OwnerRecord } from './reaper-host.js'
import { isSameProcess, readProcessStartToken } from './sp.js'

/** The synchronous fs subset the record needs (MemFs implements it). */
export interface OwnershipFs {
  readFileSync(path: string, encoding: 'utf8'): string
  writeFileSync(path: string, data: string, opts?: { mode?: number }): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
}

export interface OwnershipOptions {
  stateDir: string
  port: number
  fs?: OwnershipFs
  logger?: (msg: string) => void
  /** Default `isSameProcess` of the service proxy. */
  isSameProcess?: (pid: number, procStart: string | null) => boolean
  /** Default `readProcessStartToken` of the service proxy. */
  readProcessStartToken?: (pid: number) => string | null
  now?: () => number
}

export interface OwnershipStore {
  readonly path: string
  /** Record that this process launched `pid`. Best effort. */
  write(pid: number, profileDir: string): OwnerRecord | null
  /** The record, or null when absent or malformed. Never throws. */
  read(): OwnerRecord | null
  /** pid alive and its start token unchanged (never a recycled pid). */
  isValid(rec: OwnerRecord): boolean
  /** Forget the record. Best effort. */
  remove(): void
}

export function ownerRecordPath(stateDir: string, port: number): string {
  return join(stateDir, `chrome-${port}.json`)
}

function parseRecord(raw: string, port: number): OwnerRecord | null {
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const pid = v['pid']
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
    if (v['port'] !== port) return null
    const procStart = typeof v['procStart'] === 'string' ? v['procStart'] : null
    const profileDir = v['profileDir']
    const launchedAt = v['launchedAt']
    return {
      pid,
      procStart,
      port,
      ...(typeof profileDir === 'string' ? { profileDir } : {}),
      ...(typeof launchedAt === 'number' ? { launchedAt } : {}),
    }
  } catch {
    return null
  }
}

export function createOwnershipStore(opts: OwnershipOptions): OwnershipStore {
  const fs: OwnershipFs = opts.fs ?? (nodeFs as unknown as OwnershipFs)
  const log = opts.logger ?? (() => undefined)
  const same = opts.isSameProcess ?? ((pid: number, start: string | null) => isSameProcess(pid, start))
  const token = opts.readProcessStartToken ?? ((pid: number) => readProcessStartToken(pid))
  const now = opts.now ?? Date.now
  const path = ownerRecordPath(opts.stateDir, opts.port)

  return {
    path,
    write(pid: number, profileDir: string): OwnerRecord | null {
      const rec: OwnerRecord = { pid, procStart: null, port: opts.port, profileDir, launchedAt: now() }
      try {
        rec.procStart = token(pid)
      } catch (e) {
        log(`owner record: start token of ${pid} unreadable: ${errorMessage(e)}`)
      }
      const tmp = `${path}.${process.pid}.tmp`
      try {
        fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 })
        fs.renameSync(tmp, path)
        return rec
      } catch (e) {
        log(`owner record write failed (${path}): ${errorMessage(e)}`)
        try {
          fs.unlinkSync(tmp)
        } catch {
          /* nothing to clean */
        }
        return null
      }
    },
    read(): OwnerRecord | null {
      try {
        return parseRecord(fs.readFileSync(path, 'utf8'), opts.port)
      } catch {
        return null
      }
    },
    isValid(rec: OwnerRecord): boolean {
      // A record without a start token cannot prove the pid was not recycled: never valid.
      if (rec.procStart === null) return false
      try {
        return same(rec.pid, rec.procStart)
      } catch (e) {
        log(`owner record check failed: ${errorMessage(e)}`)
        return false
      }
    },
    remove(): void {
      try {
        fs.unlinkSync(path)
      } catch {
        /* absent or unremovable: best effort */
      }
    },
  }
}
