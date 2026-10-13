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
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.26] [capture-upgrade.27].
 */
import type { createStoreAdapter } from '@adhd/sox-store-adapter'
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

export async function openStoreRecordingSink(opts: OpenStoreRecordingSinkOptions): Promise<StoreRecordingSink> {
  const loadAdapter = opts.loadAdapter ?? (() => import('@adhd/sox-store-adapter'))

  let adapterModule: { createStoreAdapter: typeof createStoreAdapter }
  try {
    adapterModule = await loadAdapter()
  } catch (cause) {
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `cannot load @adhd/sox-store-adapter (is it installed?): ${errorMessage(cause)}`, { cause })
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
  return sink
}
