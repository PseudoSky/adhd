/**
 * @adhd/stealth-core-browser — src/lib/recording/store-sink.ts
 *
 * `RecordingSink` over the shared store adapter. The store is typed as the
 * three adapter methods the sink needs (`import type` only, so a signature
 * drift in the adapter is a compile error here, and no module of the adapter
 * is loaded by this file). Batches run inside ONE immediate transaction;
 * every envelope is one parametrized INSERT OR REPLACE keyed by
 * (recording_id, request_id), so a replay never duplicates a row.
 *
 * Redaction is NOT this sink's job: it persists the envelope the recorder hands it, headers and
 * `postData` included. Pass the recorder `redactHeaders()` (docs/reference/README.md) to keep `cookie`,
 * `set-cookie` and `authorization` out of the table.
 *
 * Lifecycle: a failed `init()` is not cached (the next write retries it); `close()` waits for every
 * write already admitted and every later write is refused; an empty batch touches nothing.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.11], resolve-findings [resolve-findings.3].
 */
import type { StoreAdapter } from '@adhd/sox-store-adapter'
import { captureError } from './errors.js'
import type { RecordingEnvelope, RecordingSink } from './types.js'

export type RecordingStore = Pick<StoreAdapter, 'exec' | 'executeRun' | 'transaction'>

export const RECORDING_SCHEMA_VERSION = 1
export const DEFAULT_RECORDING_TABLE = 'recordings'

export interface StoreRecordingSinkOptions {
  /** Table name; letters, digits and underscore. Default `recordings`. */
  table?: string
}

/** Closes a store the sink does not own the lifetime of by default (set by `openStoreRecordingSink`). */
export interface StoreOwnership {
  close(): Promise<void>
}

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** The DDL statements, one per `exec` call, followed by the schema-version upsert SQL. */
export function recordingDdl(table: string = DEFAULT_RECORDING_TABLE): { statements: string[]; versionSql: string } {
  if (!TABLE_NAME.test(table)) {
    throw captureError('CAPTURE_SINK_UNAVAILABLE', `invalid recording table name: ${JSON.stringify(table)}`)
  }
  return {
    statements: [
      `CREATE TABLE IF NOT EXISTS ${table} (
  recording_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  url_path TEXT NOT NULL,
  state TEXT NOT NULL,
  status INTEGER,
  request_headers TEXT NOT NULL,
  request_body TEXT,
  response_headers TEXT NOT NULL,
  response_body TEXT,
  body_encoding TEXT,
  redirects TEXT NOT NULL,
  failure TEXT,
  duration_ms INTEGER,
  PRIMARY KEY (recording_id, request_id)
)`,
      `CREATE INDEX IF NOT EXISTS ${table}_ts ON ${table} (ts)`,
      `CREATE INDEX IF NOT EXISTS ${table}_url_path ON ${table} (url_path)`,
      `CREATE INDEX IF NOT EXISTS ${table}_status ON ${table} (status)`,
      'CREATE TABLE IF NOT EXISTS recording_schema (table_name TEXT PRIMARY KEY, version INTEGER NOT NULL)',
    ],
    // Upgrade-only: an older build opening a table written by a newer one never lowers the recorded version.
    versionSql: 'INSERT INTO recording_schema (table_name, version) VALUES (?, ?) ON CONFLICT(table_name) DO UPDATE SET version = excluded.version WHERE recording_schema.version < excluded.version',
  }
}

function urlPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** The parameter array of one envelope's INSERT OR REPLACE, in column order. */
export function envelopeParams(env: RecordingEnvelope): unknown[] {
  const ex = env.exchange
  return [
    env.recordingId,
    ex.requestId,
    env.seq,
    env.ts,
    ex.request.method,
    ex.url,
    urlPath(ex.url),
    ex.state,
    ex.response?.status ?? null,
    JSON.stringify(ex.request.headers),
    ex.request.postData ?? null,
    JSON.stringify(ex.response?.headers ?? {}),
    ex.response?.body ?? null,
    ex.response?.bodyEncoding ?? null,
    JSON.stringify(ex.redirects),
    ex.failure ? JSON.stringify(ex.failure) : null,
    ex.durationMs ?? null,
  ]
}

export class StoreRecordingSink implements RecordingSink {
  private readonly store: RecordingStore
  private readonly table: string
  private readonly owned?: StoreOwnership
  private initPromise?: Promise<void>
  private closePromise?: Promise<void>
  /** Writes admitted before close(); close() waits for them so none races the store shutting down. */
  private readonly inflight = new Set<Promise<void>>()
  private readonly insertSql: string

  /**
   * @param store an injected store is NEVER closed by the sink
   * @param owned set only by `openStoreRecordingSink`: closing the sink then closes the store it opened
   */
  constructor(store: RecordingStore, opts: StoreRecordingSinkOptions = {}, owned?: StoreOwnership) {
    this.store = store
    this.table = opts.table ?? DEFAULT_RECORDING_TABLE
    this.owned = owned
    recordingDdl(this.table) // validates the table name eagerly
    this.insertSql =
      `INSERT OR REPLACE INTO ${this.table} (recording_id, request_id, seq, ts, method, url, url_path, state, status, ` +
      'request_headers, request_body, response_headers, response_body, body_encoding, redirects, failure, duration_ms) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  }

  /** Creates the table and records the schema version. Runs once; later calls return the same promise. */
  init(): Promise<void> {
    if (!this.initPromise) {
      const attempt = this.runInit()
      this.initPromise = attempt
      // A rejected init must not be cached forever: clear it so the next write retries.
      attempt.catch(() => {
        if (this.initPromise === attempt) this.initPromise = undefined
      })
    }
    return this.initPromise
  }

  private async runInit(): Promise<void> {
    const ddl = recordingDdl(this.table)
    for (const sql of ddl.statements) await this.store.exec(sql)
    await this.store.executeRun(ddl.versionSql, [this.table, RECORDING_SCHEMA_VERSION])
  }

  async write(envelope: RecordingEnvelope): Promise<void> {
    await this.writeBatch([envelope])
  }

  /** One immediate transaction for the whole batch. */
  async writeBatch(envelopes: readonly RecordingEnvelope[]): Promise<void> {
    if (this.closePromise) throw captureError('CAPTURE_SINK_FAILED', 'StoreRecordingSink is closed')
    if (envelopes.length === 0) return
    const run = this.runBatch(envelopes)
    this.inflight.add(run)
    try {
      await run
    } finally {
      this.inflight.delete(run)
    }
  }

  private async runBatch(envelopes: readonly RecordingEnvelope[]): Promise<void> {
    await this.init()
    await this.store.transaction(
      async (tx) => {
        for (const env of envelopes) await tx.executeRun(this.insertSql, envelopeParams(env))
      },
      { mode: 'immediate' },
    )
  }

  /** Idempotent. Closes the store only when this sink opened it. */
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      // Writes admitted before close() finish first; the store is never closed under a running transaction.
      await Promise.allSettled([...this.inflight])
      if (this.owned) await this.owned.close()
    })()
    return this.closePromise
  }
}
