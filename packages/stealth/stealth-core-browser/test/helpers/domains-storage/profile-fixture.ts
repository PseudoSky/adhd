/**
 * Test-only fixture builder (ticket 8468f7b1, [tests-unit-data.3]).
 * Creates a throwaway Chrome-shaped profile under the OS temp dir. Never reads a real profile.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Fixture {
  root: string
  defaultDir: string
  db(name: string, ddl: string[]): DatabaseSync
  json(name: string, value: unknown): void
  raw(name: string, text: string): void
  cleanup(): void
}

export function makeProfile(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'stealth-browser-profile-'))
  const defaultDir = join(root, 'Default')
  mkdirSync(defaultDir, { recursive: true })
  return {
    root,
    defaultDir,
    db(name, ddl) {
      const d = new DatabaseSync(join(defaultDir, name))
      for (const stmt of ddl) d.exec(stmt)
      return d
    },
    json(name, value) { writeFileSync(join(defaultDir, name), JSON.stringify(value)) },
    raw(name, text) { writeFileSync(join(defaultDir, name), text) },
    cleanup() { rmSync(root, { recursive: true, force: true }) },
  }
}
