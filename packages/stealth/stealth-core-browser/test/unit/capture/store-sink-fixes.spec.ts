/**
 * StoreRecordingSink lifecycle fixes.
 * Ticket 8468f7b1 [resolve-findings.3] (F75 F76 F77)
 * Real use: a long agent session records through the shared store while the store is flaky at start-up,
 * the caller closes the sink mid-flight, and an older build opens a table a newer build wrote.
 * guards: a failed init() is retried by the next write; an empty batch opens no transaction; close() waits for an admitted write and refuses later ones; the schema version never goes down
 * tier: S
 * cites: 8468f7b1 [resolve-findings.3]
 * plan: resolve-findings
 * teeth: red: nx run stealth-core-browser:test --skip-nx-cache -- test/unit/capture/store-sink-fixes.spec.ts -> exit 1 with initPromise cached on rejection, no empty-batch guard, close() not awaiting in-flight writes and the INSERT OR REPLACE version upsert; 4 failed in the mutation run, 4 passed restored.
 */
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { RECORDING_SCHEMA_VERSION, StoreRecordingSink, recordingDdl } from '../../../src/lib/recording/store-sink.js'
import type { RecordingEnvelope } from '../../../src/lib/recording/types.js'
import { makeStoreFake } from '../../helpers/capture/capture-kit.js'

function envelope(n: number): RecordingEnvelope {
  return {
    recordingId: 'rec-1',
    seq: n,
    ts: '2026-01-01T00:00:00.000Z',
    exchange: {
      requestId: `r${n}`,
      url: `https://example.com/${n}`,
      state: 'settled',
      request: { method: 'GET', headers: {} },
      response: { status: 200, headers: {}, body: 'ok', bodyEncoding: 'utf8' },
      redirects: [],
    },
  } as unknown as RecordingEnvelope
}

describe('8468f7b1 [resolve-findings.3] store sink lifecycle', () => {
  it('a failed init() is not cached: the next write retries it and lands', async () => {
    const fake = makeStoreFake()
    let first = true
    const store = {
      ...fake.store,
      exec: async (sql: string): Promise<void> => {
        if (first) {
          first = false
          throw new Error('database is locked')
        }
        await fake.store.exec(sql)
      },
    }
    const sink = new StoreRecordingSink(store)
    await expect(sink.write(envelope(1))).rejects.toThrow('database is locked')
    await sink.write(envelope(1))
    expect(fake.rows.has('rec-1:r1')).toBe(true)
  })

  it('an empty batch opens no transaction and runs no init', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    await sink.writeBatch([])
    expect(fake.transactions).toHaveLength(0)
    expect(fake.exec).toHaveLength(0)
  })

  it('close() waits for a write already admitted, then refuses further writes', async () => {
    const fake = makeStoreFake()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    const store = {
      ...fake.store,
      transaction: async <T>(fn: Parameters<typeof fake.store.transaction<T>>[0], o?: Parameters<typeof fake.store.transaction<T>>[1]): Promise<T> => {
        await gate
        return fake.store.transaction(fn, o)
      },
    }
    let storeClosed = false
    const sink = new StoreRecordingSink(store, {}, { close: async () => { storeClosed = true } })
    const pending = sink.write(envelope(1))
    await Promise.resolve()
    const closing = sink.close()
    await new Promise((r) => setTimeout(r, 5))
    expect(storeClosed).toBe(false)
    release()
    await pending
    await closing
    expect(storeClosed).toBe(true)
    expect(fake.rows.has('rec-1:r1')).toBe(true)
    await expect(sink.write(envelope(2))).rejects.toMatchObject({ code: 'CAPTURE_SINK_FAILED' })
  })

  it('the schema version row is upgrade-only: an older build never lowers a newer version', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const ddl = recordingDdl()
      for (const sql of ddl.statements) db.exec(sql)
      db.prepare(ddl.versionSql).run('recordings', RECORDING_SCHEMA_VERSION + 4)
      db.prepare(ddl.versionSql).run('recordings', RECORDING_SCHEMA_VERSION)
      const row = db.prepare('SELECT version FROM recording_schema WHERE table_name = ?').get('recordings') as { version: number }
      expect(row.version).toBe(RECORDING_SCHEMA_VERSION + 4)
    } finally {
      db.close()
    }
  })
})
