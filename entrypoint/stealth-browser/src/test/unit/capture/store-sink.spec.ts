/**
 * StoreRecordingSink over a hand-written three-method store.
 * Ticket 8468f7b1 AC capture-upgrade.11 · [capture-upgrade.11]
 * Real use: an agent persists a browsing session to the shared store. Each
 * settled exchange becomes one row keyed (recording_id, request_id); a batch is
 * one immediate transaction; replays never duplicate; the sink never closes a
 * store the caller owns.
 */
import { describe, expect, it, vi } from 'vitest'
import { CaptureError } from '../../../lib/recording/errors.js'
import { MemoryRecordingSink } from '../../../lib/recording/memory-sink.js'
import { NetworkRecorder } from '../../../lib/recording/network-recorder.js'
import { DEFAULT_RECORDING_TABLE, RECORDING_SCHEMA_VERSION, StoreRecordingSink, recordingDdl } from '../../../lib/recording/store-sink.js'
import type { RecordingEnvelope } from '../../../lib/recording/types.js'
import { connectSession, makeStoreFake, useFixture } from './capture-kit.js'

/** Record `url` through a fixture and hand back the envelopes. */
async function envelopes(url: string, recordingId = 'rec-1'): Promise<RecordingEnvelope[]> {
  const session = await connectSession()
  const mem = new MemoryRecordingSink()
  const recorder = new NetworkRecorder(session, { sink: mem, recordingId, logger: () => undefined })
  await recorder.start()
  await session.send('Page.navigate', { url })
  await recorder.settled()
  await recorder.close()
  return mem.records()
}

const COL = {
  recording_id: 0, request_id: 1, seq: 2, ts: 3, method: 4, url: 5, url_path: 6, state: 7, status: 8,
  request_headers: 9, request_body: 10, response_headers: 11, response_body: 12, body_encoding: 13, redirects: 14, failure: 15, duration_ms: 16,
} as const

describe('8468f7b1 [capture-upgrade.11] init: DDL once, schema version row', () => {
  it('issues each DDL statement once however often init() is called, and writes the recording_schema version row', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    await sink.init()
    await sink.init()
    expect(fake.exec).toEqual(recordingDdl(DEFAULT_RECORDING_TABLE).statements)
    expect(fake.exec.some((s) => s.includes('recording_schema'))).toBe(true)
    expect(fake.exec.filter((s) => s.startsWith('CREATE TABLE IF NOT EXISTS recordings'))).toHaveLength(1)
    expect(fake.rows.get(`schema:${DEFAULT_RECORDING_TABLE}`)).toEqual([DEFAULT_RECORDING_TABLE, RECORDING_SCHEMA_VERSION])
    expect(fake.runs.filter((r) => r.sql.includes('recording_schema'))).toHaveLength(1)
  })

  it('creates the table with the composite primary key and no AUTOINCREMENT', () => {
    const [create] = recordingDdl().statements
    expect(create).toContain('PRIMARY KEY (recording_id, request_id)')
    expect(create).not.toContain('AUTOINCREMENT')
  })

  it('rejects an unsafe table name', () => {
    expect(() => new StoreRecordingSink(makeStoreFake().store, { table: 'x; DROP TABLE y' })).toThrow(CaptureError)
  })

  it('uses a custom table name in every statement', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store, { table: 'session_log' })
    await sink.init()
    expect(fake.exec[0]).toContain('session_log')
    expect(fake.rows.has('schema:session_log')).toBe(true)
  })
})

describe('8468f7b1 [capture-upgrade.11] a batch is ONE immediate transaction', () => {
  useFixture('two-tabs-parallel')

  it('writeBatch of two envelopes runs inside a single transaction with mode immediate', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const envs = await envelopes('https://site.test/a')
    expect(envs).toHaveLength(2)
    await sink.writeBatch(envs)
    expect(fake.transactions).toEqual([{ mode: 'immediate' }])
    const inserts = fake.runs.filter((r) => r.sql.startsWith('INSERT OR REPLACE INTO recordings'))
    expect(inserts).toHaveLength(2)
    expect(inserts.every((r) => r.inTransaction)).toBe(true)
  })

  it('a single write() is also one immediate transaction', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const [env] = await envelopes('https://site.test/a')
    if (!env) throw new Error('no envelope')
    await sink.write(env)
    expect(fake.transactions).toHaveLength(1)
  })
})

describe('8468f7b1 [capture-upgrade.11] each envelope is one parametrized INSERT OR REPLACE', () => {
  useFixture('post-json-api')

  it('carries status, headers, bodies, encoding, duration, redirects and failure as bound parameters (never inlined)', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const [env] = await envelopes('https://site.test/api/search', 'rec-9')
    if (!env) throw new Error('no envelope')
    await sink.write(env)
    const insert = fake.runs.find((r) => r.sql.startsWith('INSERT OR REPLACE INTO recordings'))
    expect(insert?.sql).not.toContain('cats')
    const a = insert?.args ?? []
    expect(a).toHaveLength(17)
    expect(a[COL.recording_id]).toBe('rec-9')
    expect(a[COL.request_id]).toBe('R1')
    expect(a[COL.method]).toBe('POST')
    expect(a[COL.url_path]).toBe('/api/search')
    expect(a[COL.state]).toBe('finished')
    expect(a[COL.status]).toBe(200)
    expect(JSON.parse(a[COL.request_headers] as string)).toEqual({ 'content-type': 'application/json' })
    expect(a[COL.request_body]).toBe('{"q":"cats"}')
    expect(JSON.parse(a[COL.response_headers] as string)).toEqual({ 'content-type': 'application/json' })
    expect(a[COL.response_body]).toBe('{"results":[1,2,3]}')
    expect(a[COL.body_encoding]).toBe('utf8')
    expect(a[COL.duration_ms]).toBe(200)
    expect(a[COL.redirects]).toBe('[]')
    expect(a[COL.failure]).toBeNull()
  })
})

describe('8468f7b1 [capture-upgrade.11] redirect chain row', () => {
  useFixture('redirect-301-200')
  it('stores the 301 hop in the redirects column', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const [env] = await envelopes('https://site.test/old')
    if (!env) throw new Error('no envelope')
    await sink.write(env)
    const args = [...fake.rows.entries()].find(([k]) => !k.startsWith('schema:'))?.[1] ?? []
    const hops = JSON.parse(args[COL.redirects] as string) as Array<{ response: { status: number } }>
    expect(hops).toHaveLength(1)
    expect(hops[0]?.response.status).toBe(301)
    expect(args[COL.url]).toBe('https://site.test/new')
  })
})

describe('8468f7b1 [capture-upgrade.11] binary body row', () => {
  useFixture('binary-base64')
  it('keeps the raw base64 text and flags the encoding', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const [env] = await envelopes('https://site.test/img.png')
    if (!env) throw new Error('no envelope')
    await sink.write(env)
    const args = [...fake.rows.entries()].find(([k]) => !k.startsWith('schema:'))?.[1] ?? []
    expect(args[COL.response_body]).toBe('iVBORw0KGgo=')
    expect(args[COL.body_encoding]).toBe('base64')
  })
})

describe('8468f7b1 [capture-upgrade.11] failed exchange row', () => {
  useFixture('cors-failure')
  it('stores state failed, the ExtraInfo status and the failure JSON', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const [env] = await envelopes('https://site.test/api/x')
    if (!env) throw new Error('no envelope')
    await sink.write(env)
    const args = [...fake.rows.entries()].find(([k]) => !k.startsWith('schema:'))?.[1] ?? []
    expect(args[COL.state]).toBe('failed')
    expect(args[COL.status]).toBe(403)
    expect(JSON.parse(args[COL.failure] as string).errorText).toBe('net::ERR_FAILED')
    expect(args[COL.response_body]).toBeNull()
  })
})

describe('8468f7b1 [capture-upgrade.11] idempotent replay and close', () => {
  useFixture('doc-200')

  it('replaying the same key leaves one row', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    const [env] = await envelopes('https://site.test/home')
    if (!env) throw new Error('no envelope')
    await sink.write(env)
    await sink.write(env)
    await sink.writeBatch([env, env])
    const rows = [...fake.rows.keys()].filter((k) => !k.startsWith('schema:'))
    expect(rows).toEqual(['rec-1:R1'])
  })

  it('double close() is safe and an injected store is NOT closed', async () => {
    const fake = makeStoreFake()
    const sink = new StoreRecordingSink(fake.store)
    await sink.init()
    const before = { exec: fake.exec.length, runs: fake.runs.length }
    await sink.close()
    await sink.close()
    expect({ exec: fake.exec.length, runs: fake.runs.length }).toEqual(before) // nothing was called on the store
  })

  it('a store the sink owns is closed exactly once, however often close() is called', async () => {
    const fake = makeStoreFake()
    const closeStore = vi.fn(async () => undefined)
    const sink = new StoreRecordingSink(fake.store, {}, { close: closeStore })
    await sink.close()
    await sink.close()
    expect(closeStore).toHaveBeenCalledTimes(1)
  })

  it('writing after close rejects', async () => {
    const sink = new StoreRecordingSink(makeStoreFake().store)
    const [env] = await envelopes('https://site.test/home')
    if (!env) throw new Error('no envelope')
    await sink.close()
    await expect(sink.write(env)).rejects.toThrow('closed')
  })
})
