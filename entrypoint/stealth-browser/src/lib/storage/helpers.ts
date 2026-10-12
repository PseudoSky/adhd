import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'

export function openDb(dbPath: string): DatabaseSyncType {
  const uri = `file:${dbPath}?mode=ro&immutable=1`
  const db = new DatabaseSync(uri, { readBigInts: true })
  db.exec('PRAGMA query_only = ON')
  return db
}

export function toUnixTimeSql(column: string): string {
  return `((${column} / 1000000) - 11644473600)`
}
