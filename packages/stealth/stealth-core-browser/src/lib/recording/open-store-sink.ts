/**
 * @adhd/stealth-core-browser — src/lib/recording/open-store-sink.ts
 *
 * The default concrete adapter: open a store at `dbPath` through the shared
 * store adapter and wrap it in a `StoreRecordingSink` that owns (and closes) it.
 *
 * The adapter package is ESM-only while this package publishes CommonJS
 * (ADR-0003), and Node 22.5 to 22.11 cannot require() an ES module. It is
 * therefore reached ONLY through the lazy dynamic import in the default
 * `loadAdapter` below, never at module load: consumers that never record to a
 * store never touch it, and a missing or broken install surfaces as
 * CAPTURE_SINK_UNAVAILABLE from this factory alone.
 *
 * A recording holds whatever the page exchanged, which by default includes cookies and authorization headers
 * (see `redactHeaders`). The database file, and the `-wal` and `-shm` files SQLite derives from it, are therefore
 * created and kept owner-only (0600) whatever the umask; a file that cannot be secured fails the open with
 * CAPTURE_SINK_UNAVAILABLE instead of recording into a readable file.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.26] [capture-upgrade.27].
 */
import type { createStoreAdapter } from '@adhd/sox-store-adapter'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { captureError, errorMessage } from './errors.js'
import { StoreRecordingSink } from './store-sink.js'

export interface OpenStoreRecordingSinkOptions {
  /** Database file handed to the adapter factory as `{ dbPath }`. */
  dbPath: string
  /** Table name; default `recordings`. */
  table?: string
  /** Seam for tests and alternate loaders. Default: lazy dynamic import of the adapter package. */
  loadAdapter?: () => Promise<{ createStoreAdapter: typeof createStoreAdapter }>
}

/** Owner read/write only: the mode of a recording database and its SQLite side files. */
export const RECORDING_FILE_MODE = 0o600

const SIDE_FILES = ['', '-wal', '-shm'] as const

/** True for the paths that name no file (an in-memory database). */
function isMemoryPath(dbPath: string): boolean {
  return dbPath === '' || dbPath === ':memory:' || dbPath.startsWith('file::memory:')
}

/** Create the database file owner-only before the adapter opens it, so it is never readable even briefly. */
function precreateOwnerOnly(dbPath: string): void {
  if (isMemoryPath(dbPath) || existsSync(dbPath)) return
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 })
  closeSync(openSync(dbPath, 'a', RECORDING_FILE_MODE))
}

/** Force owner-only on the database and any side file that exists (a file created earlier under a wider umask). */
function secureOwnerOnly(dbPath: string): void {
  if (isMemoryPath(dbPath)) return
  for (const suffix of SIDE_FILES) {
    const file = `${dbPath}${suffix}`
    if (existsSync(file)) chmodSync(file, RECORDING_FILE_MODE)
  }
}

export async function openStoreRecordingSink(opts: OpenStoreRecordingSinkOptions): Promise<StoreRecordingSink> {
  const loadAdapter = opts.loadAdapter ?? (() => import('@adhd/sox-store-adapter'))

  let adapterModule: { createStoreAdapter: typeof createStoreAdapter }
  try {
    adapterModule = await loadAdapter()
  } catch (cause) {
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `cannot load @adhd/sox-store-adapter (is it installed?): ${errorMessage(cause)}`, { cause })
  }

  try {
    precreateOwnerOnly(opts.dbPath)
  } catch (cause) {
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `cannot create the recording store ${opts.dbPath} owner-only: ${errorMessage(cause)}`, { cause })
  }

  let adapter: Awaited<ReturnType<typeof createStoreAdapter>>
  try {
    adapter = await adapterModule.createStoreAdapter({ dbPath: opts.dbPath })
  } catch (cause) {
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `cannot open the recording store at ${opts.dbPath}: ${errorMessage(cause)}`, { cause })
  }

  const sink = new StoreRecordingSink(adapter, { table: opts.table }, { close: () => adapter.close() })
  try {
    await sink.init()
  } catch (cause) {
    await adapter.close().catch(() => undefined)
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `cannot initialise the recording schema at ${opts.dbPath}: ${errorMessage(cause)}`, { cause })
  }
  try {
    secureOwnerOnly(opts.dbPath)
  } catch (cause) {
    await adapter.close().catch(() => undefined)
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `cannot restrict the recording store ${opts.dbPath} to its owner: ${errorMessage(cause)}`, { cause })
  }
  return sink
}
