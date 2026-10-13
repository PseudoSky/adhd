/**
 * Shared test kit of the capture specs (not a spec itself).
 * Ticket 8468f7b1 · plan state capture-upgrade.
 *
 * Everything runs on the in-memory harness: `FakeCdpServer` replaces the global
 * WebSocket, fixtures stream the protocol, and the persistence store is a
 * hand-written three-method fake. No socket, process, network or Chrome.
 */
import type { AdapterTransaction, TransactionOptions } from '@adhd/sox-store-adapter'
import { CdpSession } from '../../../lib/cdp/session.js'
import type { CaptureOptions } from '../../../lib/capture/network.js'
import type { RecordingStore } from '../../../lib/recording/store-sink.js'
import type { RecordedExchange, RecordingEnvelope, RecordingSink } from '../../../lib/recording/types.js'
import { FakeCdpServer, loadFixture, type CdpFixture } from '../../support/fake-cdp.js'

export const WS_URL = 'ws://127.0.0.1:1/devtools/page/X'

export interface Rig {
  readonly server: FakeCdpServer
}

function resolveFixture(fixture: string | CdpFixture | (() => CdpFixture)): CdpFixture {
  if (typeof fixture === 'string') return loadFixture(fixture)
  if (typeof fixture === 'function') return fixture()
  return structuredClone(fixture)
}

/** Install `fixture` as the global WebSocket for every test of the enclosing describe. */
export function useFixture(fixture: string | CdpFixture | (() => CdpFixture), opts: { strict?: boolean } = {}): Rig {
  let server: FakeCdpServer | undefined
  let restore: (() => void) | undefined
  beforeEach(() => {
    const f = resolveFixture(fixture)
    server = new FakeCdpServer(f, opts)
    restore = server.install()
  })
  afterEach(() => {
    restore?.()
    server = undefined
    vi.useRealTimers()
  })
  return {
    get server(): FakeCdpServer {
      if (!server) throw new Error('useFixture: server read outside a test')
      return server
    },
  }
}

/** The url a fixture navigates to (its Page.navigate step). */
export function navigateUrlOf(f: CdpFixture): string {
  const step = f.steps.find((s) => s.when.method === 'Page.navigate')
  const url = step?.when.params?.['url']
  if (typeof url !== 'string') throw new Error(`fixture ${f.meta.name} has no Page.navigate url`)
  return url
}

/** CaptureOptions for a fixture: match everything, navigate to the fixture url, silent logger. */
export function optionsFor(name: string, extra: Partial<CaptureOptions> = {}): CaptureOptions & { logs: string[] } {
  const logs: string[] = []
  return {
    urlPattern: /./,
    navigateUrl: navigateUrlOf(loadFixture(name)),
    timeoutMs: 2_000,
    logger: (m) => logs.push(m),
    ...extra,
    logs: extra.logger ? [] : logs,
  }
}

/** A fixture copy with extra steps appended and/or events rewritten. */
export function fixtureWith(name: string, edit: (f: CdpFixture) => void): CdpFixture {
  const f = loadFixture(name)
  edit(f)
  return f
}

export async function connectSession(): Promise<CdpSession> {
  const s = new CdpSession()
  await s.connect(WS_URL)
  return s
}

/** The `Network.*` and `Page.*` command methods the server received, in order. */
export function commandLog(server: FakeCdpServer): string[] {
  return server.received.map((r) => r.method)
}

/** Let queued microtasks (fake socket replies) run. */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve()
}

// ---- sinks -------------------------------------------------------------------------------------

export interface SinkSpy extends RecordingSink {
  written: RecordingEnvelope[]
  log: string[]
}

/** A recording sink that logs every call; `write` is overridable. */
export function makeSinkSpy(write?: (env: RecordingEnvelope, index: number) => void | Promise<void>): SinkSpy {
  const written: RecordingEnvelope[] = []
  const log: string[] = []
  return {
    written,
    log,
    async write(env) {
      log.push('write')
      const index = written.length
      written.push(env)
      await write?.(env, index)
    },
    async flush() {
      log.push('flush')
    },
    async close() {
      log.push('close')
    },
  }
}

// ---- store fake ----------------------------------------------------------------------------------

export interface StoreFake {
  store: RecordingStore
  /** Rows keyed by primary key (`recording_id:request_id`) or `schema:<table>`. */
  rows: Map<string, unknown[]>
  exec: string[]
  runs: Array<{ sql: string; args: unknown[] | undefined; inTransaction: boolean }>
  transactions: Array<TransactionOptions | undefined>
  failOnRun?: (callIndex: number) => Error | undefined
}

/** A hand-written 3-method store (exec, executeRun, transaction) keyed by primary key. Not the package's mock. */
export function makeStoreFake(opts: { failOnRun?: (callIndex: number) => Error | undefined } = {}): StoreFake {
  const rows = new Map<string, unknown[]>()
  const exec: string[] = []
  const runs: StoreFake['runs'] = []
  const transactions: Array<TransactionOptions | undefined> = []
  let depth = 0
  let runCount = 0
  const executeRun = async (sql: string, args?: unknown[]): Promise<{ rowsAffected: number; lastInsertRowid: number }> => {
    runs.push({ sql, args, inTransaction: depth > 0 })
    const fail = opts.failOnRun?.(runCount++)
    if (fail) throw fail
    if (/^INSERT OR REPLACE INTO recording_schema/.test(sql)) rows.set(`schema:${String(args?.[0])}`, args ?? [])
    else if (/^INSERT OR REPLACE INTO/.test(sql)) rows.set(`${String(args?.[0])}:${String(args?.[1])}`, args ?? [])
    return { rowsAffected: 1, lastInsertRowid: 0 }
  }
  const tx: AdapterTransaction = {
    executeRun,
    exec: async (sql) => {
      exec.push(sql)
    },
    executeGet: () => Promise.reject(new Error('unsupported in fake')),
    executeAll: () => Promise.reject(new Error('unsupported in fake')),
  }
  const store = {
    exec: async (sql: string): Promise<void> => {
      exec.push(sql)
    },
    executeRun,
    transaction: async <T>(fn: (t: AdapterTransaction) => T | Promise<T>, o?: TransactionOptions): Promise<T> => {
      transactions.push(o)
      depth += 1
      try {
        return await fn(tx)
      } finally {
        depth -= 1
      }
    },
  } satisfies RecordingStore
  return { store, rows, exec, runs, transactions }
}

/** Stable view of a captured response for cross-sink comparison. */
export function plain(c: { requestId: string; url: string; status: number; body: string; headers: Record<string, string>; method: string }): unknown {
  return { requestId: c.requestId, url: c.url, status: c.status, body: c.body, headers: c.headers, method: c.method }
}

export function ids(list: readonly RecordedExchange[]): string[] {
  return list.map((e) => e.requestId)
}

// ---- synthetic traffic ---------------------------------------------------------------------------

/** Push one complete request lifecycle through the server (the fixture's generic body step answers). */
export function fireRequest(server: FakeCdpServer, id: string, opts: { url?: string; status?: number; startedAt?: number } = {}): void {
  const url = opts.url ?? `https://site.test/${id}`
  const t = opts.startedAt ?? 100
  server.emitNow('Network.requestWillBeSent', { requestId: id, request: { url, method: 'GET', headers: {} }, timestamp: t, wallTime: 1700000000 })
  server.emitNow('Network.responseReceived', {
    requestId: id,
    timestamp: t + 0.1,
    type: 'XHR',
    response: { url, status: opts.status ?? 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, mimeType: 'text/plain' },
  })
  server.emitNow('Network.loadingFinished', { requestId: id, timestamp: t + 0.2, encodedDataLength: 10 })
}

/** A fixture whose navigation produces no traffic at all. */
export function silentFixture(name = 'doc-200'): CdpFixture {
  return fixtureWith(name, (f) => {
    const nav = f.steps.find((s) => s.when.method === 'Page.navigate')
    if (nav) nav.emit = []
  })
}

/** Resolve a promise's settlement without throwing: tracks done-ness for fake-timer assertions. */
export function track<T>(p: Promise<T>): { done: () => boolean; value: () => Promise<T> } {
  let done = false
  void p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  return { done: () => done, value: () => p }
}
