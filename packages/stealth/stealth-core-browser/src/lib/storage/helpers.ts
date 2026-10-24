import { DatabaseSync } from 'node:sqlite'
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

/**
 * Opens a Chrome database read-only and immutable. The path goes through `pathToFileURL`, so `?`, `#`, `%` and
 * spaces in a profile directory are percent-encoded instead of being parsed as URI syntax.
 *
 * `immutable=1` takes no locks and ignores any write-ahead log: it reads the main database file as it is on disk.
 * That is the only way to read a database a running Chrome holds exclusively, and it is exact for a closed
 * profile, but rows Chrome has committed to a WAL and not yet checkpointed are not visible.
 */
export function openDb(dbPath: string): DatabaseSyncType {
  const uri = pathToFileURL(dbPath)
  uri.search = '?mode=ro&immutable=1'
  const db = new DatabaseSync(uri.href, { readBigInts: true })
  db.exec('PRAGMA query_only = ON')
  return db
}

/**
 * Chrome timestamp column (microseconds since 1601-01-01) to Unix seconds, in SQL. The divisor is a REAL, so the
 * sub-second part survives; an integer divisor would truncate to whole seconds.
 */
export function toUnixTimeSql(column: string): string {
  return `((${column} / 1000000.0) - 11644473600)`
}

/** Like {@link toUnixTimeSql}, but an unset (`0`) column is NULL instead of the year 1601. */
export function toUnixTimeOrNullSql(column: string): string {
  return `CASE WHEN ${column} = 0 THEN NULL ELSE ${toUnixTimeSql(column)} END`
}
