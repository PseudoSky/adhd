/**
 * openStoreRecordingSink: the default concrete adapter.
 * Ticket 8468f7b1 AC capture-upgrade.26 · [capture-upgrade.26]
 * Real use: `openStoreRecordingSink({ dbPath })` opens the shared store lazily
 * and returns a sink that owns it. The package is only ever reached through
 * the injectable loadAdapter, so these specs never load it.
 * guards: calls createStoreAdapter once with { dbPath }, runs the DDL and returns a working sink
 * guards: the recording database and its side files are owner-only (0600) and an unsecurable file fails the open
 * tier: S
 * cites: 8468f7b1 [capture-upgrade.26] [audit-fixes.5]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** node:fs is an in-memory fake: the unit lane never creates, chmods or reads a real file. */
const fsFake = vi.hoisted(() => ({
  files: new Map<string, number>(),
  dirs: [] as Array<{ path: string; mode: number | undefined }>,
  chmodFail: null as Error | null,
  mkdirFail: null as Error | null,
}))
vi.mock('node:fs', () => ({
  existsSync: (p: string) => fsFake.files.has(p),
  mkdirSync: (path: string, opts?: { mode?: number }) => {
    if (fsFake.mkdirFail) throw fsFake.mkdirFail
    fsFake.dirs.push({ path, mode: opts?.mode })
  },
  openSync: (path: string, _flags: string, mode?: number) => {
    fsFake.files.set(path, mode ?? 0o666)
    return 3
  },
  closeSync: () => undefined,
  chmodSync: (path: string, mode: number) => {
    if (fsFake.chmodFail) throw fsFake.chmodFail
    fsFake.files.set(path, mode)
  },
}))
import type { createStoreAdapter } from '@adhd/sox-store-adapter'
import { CaptureError } from '../../../src/lib/recording/errors.js'
import { openStoreRecordingSink } from '../../../src/lib/recording/open-store-sink.js'
import { RECORDING_SCHEMA_VERSION } from '../../../src/lib/recording/store-sink.js'
import type { RecordingEnvelope } from '../../../src/lib/recording/types.js'
import { makeStoreFake } from '../../helpers/capture/capture-kit.js'

beforeEach(() => {
  fsFake.files.clear()
  fsFake.dirs.length = 0
  fsFake.chmodFail = null
  fsFake.mkdirFail = null
})

function fakeAdapterModule(opts: { failCreate?: Error } = {}) {
  const fake = makeStoreFake()
  const adapter = { ...fake.store, close: vi.fn(async () => undefined) }
  const create = vi.fn(async (_config?: unknown) => {
    if (opts.failCreate) throw opts.failCreate
    return adapter
  })
  const loadAdapter = vi.fn(async () => ({ createStoreAdapter: create as unknown as typeof createStoreAdapter }))
  return { fake, adapter, create, loadAdapter }
}

const envelope: RecordingEnvelope = {
  recordingId: 'rec',
  key: 'rec:R1',
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  exchange: {
    requestId: 'R1',
    url: 'https://site.test/x',
    request: { method: 'GET', url: 'https://site.test/x', headers: {}, startedAt: 1 },
    response: { status: 200, headers: {}, body: 'ok', bodyEncoding: 'utf8' },
    redirects: [],
    wire: { requestExtraInfo: false, responseExtraInfo: false },
    state: 'finished',
  },
}

describe('8468f7b1 [capture-upgrade.26] happy path with a fake loadAdapter', () => {
  it('calls createStoreAdapter once with { dbPath }, runs the DDL and returns a working sink', async () => {
    const m = fakeAdapterModule()
    const sink = await openStoreRecordingSink({ dbPath: '/data/rec.sqlite', loadAdapter: m.loadAdapter })
    expect(m.loadAdapter).toHaveBeenCalledTimes(1)
    expect(m.create).toHaveBeenCalledTimes(1)
    expect(m.create).toHaveBeenCalledWith({ dbPath: '/data/rec.sqlite' })
    expect(m.fake.exec.length).toBeGreaterThan(0)
    expect(m.fake.rows.get('schema:recordings')).toEqual(['recordings', RECORDING_SCHEMA_VERSION])

    await sink.write(envelope)
    expect(m.fake.rows.has('rec:R1')).toBe(true)
  })

  it('close() closes the adapter it opened exactly once, however often it is called', async () => {
    const m = fakeAdapterModule()
    const sink = await openStoreRecordingSink({ dbPath: '/data/rec.sqlite', loadAdapter: m.loadAdapter })
    await sink.close()
    await sink.close()
    expect(m.adapter.close).toHaveBeenCalledTimes(1)
  })

  it('honours a custom table name', async () => {
    const m = fakeAdapterModule()
    await openStoreRecordingSink({ dbPath: '/data/rec.sqlite', table: 'pages', loadAdapter: m.loadAdapter })
    expect(m.fake.exec[0]).toContain('pages')
  })
})

describe('8468f7b1 [capture-upgrade.26] failures are CAPTURE_SINK_UNAVAILABLE with the cause', () => {
  it('a loadAdapter rejecting with ERR_MODULE_NOT_FOUND', async () => {
    const missing = Object.assign(new Error("Cannot find package '@adhd/sox-store-adapter'"), { code: 'ERR_MODULE_NOT_FOUND' })
    const err = await openStoreRecordingSink({ dbPath: '/x', loadAdapter: () => Promise.reject(missing) }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CaptureError)
    expect(err).toMatchObject({ code: 'CAPTURE_SINK_UNAVAILABLE', cause: missing })
  })

  it('a createStoreAdapter rejecting keeps its error as cause', async () => {
    const boom = new Error('database is locked')
    const m = fakeAdapterModule({ failCreate: boom })
    const err = await openStoreRecordingSink({ dbPath: '/x', loadAdapter: m.loadAdapter }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'CAPTURE_SINK_UNAVAILABLE', cause: boom })
    expect(m.adapter.close).not.toHaveBeenCalled()
  })

  it('a schema failure closes the adapter it just opened and is SINK_UNAVAILABLE', async () => {
    const m = fakeAdapterModule()
    m.adapter.exec = vi.fn(async () => {
      throw new Error('read-only database')
    })
    const err = await openStoreRecordingSink({ dbPath: '/x', loadAdapter: m.loadAdapter }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'CAPTURE_SINK_UNAVAILABLE' })
    expect(m.adapter.close).toHaveBeenCalledTimes(1)
  })
})

describe('8468f7b1 [audit-fixes.5] P26 the recording database is owner-only', () => {
  it('a new database file is created 0600 before the adapter opens it, in a 0700 directory', async () => {
    const m = fakeAdapterModule()
    const order: string[] = []
    m.create.mockImplementationOnce(async () => {
      order.push(`adapter sees mode ${fsFake.files.get('/data/rec.sqlite')?.toString(8)}`)
      return m.adapter
    })
    await openStoreRecordingSink({ dbPath: '/data/rec.sqlite', loadAdapter: m.loadAdapter })
    expect(order).toEqual(['adapter sees mode 600'])
    expect(fsFake.dirs).toEqual([{ path: '/data', mode: 0o700 }])
  })

  it('a database and side files created earlier under a wider umask are tightened to 0600', async () => {
    fsFake.files.set('/data/rec.sqlite', 0o644)
    fsFake.files.set('/data/rec.sqlite-wal', 0o644)
    fsFake.files.set('/data/rec.sqlite-shm', 0o666)
    await openStoreRecordingSink({ dbPath: '/data/rec.sqlite', loadAdapter: fakeAdapterModule().loadAdapter })
    expect([...fsFake.files.values()]).toEqual([0o600, 0o600, 0o600])
  })

  it('an in-memory database touches no file', async () => {
    await openStoreRecordingSink({ dbPath: ':memory:', loadAdapter: fakeAdapterModule().loadAdapter })
    expect(fsFake.files.size).toBe(0)
    expect(fsFake.dirs).toEqual([])
  })

  it('a file that cannot be restricted fails the open and closes the adapter it opened', async () => {
    fsFake.files.set('/data/rec.sqlite', 0o644)
    fsFake.chmodFail = Object.assign(new Error('EPERM'), { code: 'EPERM' })
    const m = fakeAdapterModule()
    const err = await openStoreRecordingSink({ dbPath: '/data/rec.sqlite', loadAdapter: m.loadAdapter }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'CAPTURE_SINK_UNAVAILABLE' })
    expect(String((err as Error).message)).toMatch(/owner/)
    expect(m.adapter.close).toHaveBeenCalledTimes(1)
  })

  it('a directory that cannot be created fails the open before the adapter is created', async () => {
    fsFake.mkdirFail = Object.assign(new Error('EACCES'), { code: 'EACCES' })
    const m = fakeAdapterModule()
    const err = await openStoreRecordingSink({ dbPath: '/locked/rec.sqlite', loadAdapter: m.loadAdapter }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'CAPTURE_SINK_UNAVAILABLE' })
    expect(m.create).not.toHaveBeenCalled()
  })
})
