/**
 * @adhd/stealth-core-browser — src/lib/recording/network-recorder.ts
 *
 * The one capture engine. A `NetworkRecorder` attaches to an existing
 * `CdpSession` (multi-handler `on()`), folds `Network.*` events into
 * `RecordedExchange` records and optionally hands every settled exchange to a
 * `RecordingSink`.
 *
 * Merge rules (spec 5.4):
 *   - request and response keep their MAIN part and their ExtraInfo part
 *     separately and are recomputed on every change, so both event orders give
 *     the same record; ExtraInfo headers win, ExtraInfo `statusCode` overrides
 *     the status;
 *   - ExtraInfo that arrives before the main event of an unknown request is
 *     buffered (bounded: 1000 entries, 30_000 ms TTL);
 *   - a redirect (`redirectResponse`) pushes a hop; the chain is one exchange;
 *   - failed exchanges are kept.
 *
 * The recorder is passive (it never navigates) and never closes the session.
 * Stealth: it only uses Network.* commands, never Runtime.evaluate.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.1-9, 14-18].
 */
import { randomUUID } from 'node:crypto'
import type { CdpSession } from '../cdp/session.js'
import { captureError, errorMessage } from './errors.js'
import type {
  Headers,
  RecordedExchange,
  RecordedRequest,
  RecordedResponse,
  RecorderOptions,
  RecordingEnvelope,
  RecordingSink,
} from './types.js'

/** Bounded orphan ExtraInfo buffer. */
export const EXTRA_INFO_BUFFER_MAX = 1000
export const EXTRA_INFO_BUFFER_TTL_MS = 30_000

const DEFAULT_MAX_BODY_BYTES = 5_000_000
const DEFAULT_EXTRA_INFO_GRACE_MS = 100
const DEFAULT_MAX_QUEUE = 1000
const DEFAULT_BATCH_SIZE = 50
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000
const MAX_SEEN_URLS = 10
/** HTTP statuses that carry no body by definition: a body fetch error on them means "empty". */
const NO_CONTENT_STATUSES: ReadonlySet<number> = new Set([204, 205])

type Params = Record<string, unknown>

interface ResponseExtra {
  headers: Headers
  statusCode?: number
}

interface BufferedExtra {
  kind: 'req' | 'res'
  headers: Headers
  statusCode?: number
  at: number
}

interface Draft {
  id: string
  tracked: boolean
  ex: RecordedExchange
  mainRequest: RecordedRequest
  requestExtra?: Headers
  mainResponse?: RecordedResponse
  responseExtra?: ResponseExtra
  /** Body/timing fields that survive a response rebuild. */
  bodyPart: Partial<RecordedResponse>
  expectResponseExtra: boolean
  wakeExtraWaiter?: () => void
  postDataFetch?: Promise<void>
  firstStartedAt: number
  finishing: boolean
}

// ---- small typed readers over untyped CDP params --------------------------------------------

const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function toHeaders(v: unknown): Headers {
  const out: Headers = {}
  if (!isObj(v)) return out
  for (const [k, val] of Object.entries(v)) out[k] = typeof val === 'string' ? val : String(val)
  return out
}

/** Case-insensitive header merge; the extra value (and its casing) wins. */
export function mergeHeaders(base: Headers, extra: Headers | undefined): Headers {
  if (!extra) return { ...base }
  const lowerToKey = new Map<string, string>()
  for (const k of Object.keys(base)) lowerToKey.set(k.toLowerCase(), k)
  const out: Headers = { ...base }
  for (const [k, v] of Object.entries(extra)) {
    const existing = lowerToKey.get(k.toLowerCase())
    if (existing !== undefined && existing !== k) delete out[existing]
    out[k] = v
    lowerToKey.set(k.toLowerCase(), k)
  }
  return out
}

/** The decoded text of a response body ('' when there is none). */
export function decodeBody(response: RecordedResponse | undefined): string {
  if (response?.body === undefined) return ''
  return response.bodyEncoding === 'base64' ? Buffer.from(response.body, 'base64').toString('utf-8') : response.body
}

function responseFrom(r: Params): RecordedResponse {
  return {
    status: num(r['status']) ?? 0,
    statusText: str(r['statusText']),
    headers: toHeaders(r['headers']),
    mimeType: str(r['mimeType']),
    protocol: str(r['protocol']),
    remoteIPAddress: str(r['remoteIPAddress']),
    fromCache: r['fromDiskCache'] === true || r['fromServiceWorker'] === true || r['fromPrefetchCache'] === true ? true : undefined,
    encodedDataLength: num(r['encodedDataLength']),
  }
}

function unref(timer: ReturnType<typeof setTimeout>): void {
  ;(timer as { unref?: () => void }).unref?.()
}

export class NetworkRecorder {
  private readonly session: CdpSession
  private readonly opts: RecorderOptions
  private readonly logger: (message: string) => void
  private readonly now: () => number
  private readonly recordingId: string

  private readonly drafts = new Map<string, Draft>()
  private readonly tracked: Draft[] = []
  private readonly orphans = new Map<string, BufferedExtra>()
  private readonly seen: string[] = []
  private readonly unsubscribers: Array<() => void> = []
  private readonly settledListeners = new Set<(exchange: RecordedExchange) => void>()
  private readonly idleWaiters: Array<() => void> = []
  private idleListener?: () => void
  private readonly graceTimers = new Set<ReturnType<typeof setTimeout>>()

  private started = false
  private stopped = false
  private closing?: Promise<void>
  private closeStarted = false

  /** In-flight work after loadingFinished or for a post-data fetch: grace waits, body fetches. */
  private bodyFetchPending = 0

  // sink queue
  private seq = 0
  private readonly queue: RecordingEnvelope[] = []
  private unsent = 0
  private chain: Promise<void> = Promise.resolve()
  private pumpScheduled = false
  private unreportedFailed = 0
  private unreportedDropped = 0
  private firstCause: unknown

  constructor(session: CdpSession, opts: RecorderOptions = {}) {
    this.session = session
    this.opts = opts
    this.logger = opts.logger ?? ((m) => console.error(m))
    this.now = opts.now ?? Date.now
    this.recordingId = opts.recordingId ?? randomUUID()
  }

  // ---- lifecycle ---------------------------------------------------------------------------

  /** Subscribe to the Network events THEN send Network.enable. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const on = (method: string, fn: (p: Params) => void): void => {
      this.unsubscribers.push(this.session.on(method, (p) => this.guarded(method, p, fn)))
    }
    on('Network.requestWillBeSent', (p) => this.onRequestWillBeSent(p))
    on('Network.requestWillBeSentExtraInfo', (p) => this.onRequestExtraInfo(p))
    on('Network.responseReceived', (p) => this.onResponseReceived(p))
    on('Network.responseReceivedExtraInfo', (p) => this.onResponseExtraInfo(p))
    on('Network.loadingFinished', (p) => this.onLoadingFinished(p))
    on('Network.loadingFailed', (p) => this.onLoadingFailed(p))
    await this.session.send('Network.enable')
  }

  /** Remove only this recorder's handlers. Never closes the session. */
  stop(): void {
    this.stopped = true
    for (const off of this.unsubscribers.splice(0)) off()
    for (const t of this.graceTimers) clearTimeout(t)
    this.graceTimers.clear()
    for (const d of this.drafts.values()) d.wakeExtraWaiter?.()
  }

  /** Raw (unredacted) tracked exchanges in the order they were first tracked. */
  exchanges(): readonly RecordedExchange[] {
    return this.tracked.map((d) => d.ex)
  }

  /** Resolves when no tracked exchange is in flight and no body/ExtraInfo/post-data work is pending. */
  settled(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  /** Number of fetches (response body, post data) and ExtraInfo grace waits still in flight. */
  pending(): number {
    return this.bodyFetchPending
  }

  /** Called whenever pending work drops to zero. One listener (the capture wrapper). */
  onIdle(listener: (() => void) | undefined): void {
    this.idleListener = listener
  }

  /** Raw-exchange subscription fired when a tracked exchange settles. Returns an unsubscribe. */
  onSettled(listener: (exchange: RecordedExchange) => void): () => void {
    this.settledListeners.add(listener)
    return () => this.settledListeners.delete(listener)
  }

  /** Number of tracked exchanges still waiting for loadingFinished or loadingFailed. */
  inflight(): number {
    let n = 0
    for (const d of this.tracked) if (d.ex.state === 'inflight') n += 1
    return n
  }

  /** The first 10 distinct request URLs seen, tracked or not (for NO_MATCH diagnostics). */
  seenUrls(): string[] {
    return [...this.seen]
  }

  // ---- event handlers ----------------------------------------------------------------------

  private guarded(method: string, p: Params, fn: (p: Params) => void): void {
    try {
      if (!isObj(p)) throw new Error('params is not an object')
      fn(p)
    } catch (e) {
      this.logger(`[recorder] skipped malformed ${method}: ${errorMessage(e)}`)
    }
  }

  private requireId(p: Params): string {
    const id = str(p['requestId'])
    if (!id) throw new Error('missing requestId')
    return id
  }

  private onRequestWillBeSent(p: Params): void {
    const id = this.requireId(p)
    const reqObj = p['request']
    if (!isObj(reqObj)) throw new Error('missing request')
    const url = str(reqObj['url'])
    if (url === undefined) throw new Error('missing request.url')
    const method = str(reqObj['method']) ?? 'GET'
    const rec: RecordedRequest = {
      method,
      url,
      headers: toHeaders(reqObj['headers']),
      postData: str(reqObj['postData']),
      hasPostData: reqObj['hasPostData'] === true ? true : undefined,
      resourceType: str(p['type']),
      startedAt: num(p['timestamp']) ?? 0,
      wallTime: num(p['wallTime']),
    }
    if (this.seen.length < MAX_SEEN_URLS && !this.seen.includes(url)) this.seen.push(url)

    let d = this.drafts.get(id)
    const redirectResponse = p['redirectResponse']
    if (d && isObj(redirectResponse)) {
      // The previous request finished with a redirect: it becomes a hop.
      d.mainResponse = responseFrom(redirectResponse)
      this.rebuildResponse(d)
      d.ex.redirects.push({ request: d.ex.request, response: d.ex.response ?? { status: 0, headers: {} } })
      d.mainRequest = rec
      d.requestExtra = undefined
      d.mainResponse = undefined
      d.responseExtra = undefined
      d.bodyPart = {}
      d.expectResponseExtra = false
      d.ex.response = undefined
      d.ex.wire = { requestExtraInfo: false, responseExtraInfo: false }
      d.ex.url = url
    } else if (d) {
      d.mainRequest = rec
      d.ex.url = url
    } else {
      d = {
        id,
        tracked: false,
        mainRequest: rec,
        bodyPart: {},
        expectResponseExtra: false,
        firstStartedAt: rec.startedAt,
        finishing: false,
        ex: {
          requestId: id,
          url,
          request: rec,
          redirects: [],
          wire: { requestExtraInfo: false, responseExtraInfo: false },
          state: 'inflight',
        },
      }
      this.drafts.set(id, d)
    }

    // ExtraInfo that beat this request here.
    const reqBuf = this.takeOrphan('req', id)
    if (reqBuf) d.requestExtra = mergeHeaders(d.requestExtra ?? {}, reqBuf.headers)
    const resBuf = this.takeOrphan('res', id)
    if (resBuf) d.responseExtra = { headers: mergeHeaders(d.responseExtra?.headers ?? {}, resBuf.headers), statusCode: resBuf.statusCode }
    this.rebuildRequest(d)
    if (d.responseExtra) this.rebuildResponse(d)

    if (!d.tracked && this.matches(url, method)) {
      d.tracked = true
      this.tracked.push(d)
    }
    if (d.tracked && rec.hasPostData && !rec.postData) d.postDataFetch = this.fetchPostData(d, rec)
  }

  private onRequestExtraInfo(p: Params): void {
    const id = this.requireId(p)
    const headers = toHeaders(p['headers'])
    const d = this.drafts.get(id)
    if (!d) {
      this.bufferOrphan('req', id, headers)
      return
    }
    d.requestExtra = mergeHeaders(d.requestExtra ?? {}, headers)
    this.rebuildRequest(d)
  }

  private onResponseReceived(p: Params): void {
    const id = this.requireId(p)
    const resp = p['response']
    if (!isObj(resp)) throw new Error('missing response')
    const d = this.drafts.get(id)
    if (!d) return // started before Network.enable
    d.mainResponse = responseFrom(resp)
    d.expectResponseExtra = p['hasExtraInfo'] === true && !d.responseExtra
    const type = str(p['type'])
    if (type) {
      d.mainRequest.resourceType = type
      this.rebuildRequest(d)
    }
    this.rebuildResponse(d)
  }

  private onResponseExtraInfo(p: Params): void {
    const id = this.requireId(p)
    const headers = toHeaders(p['headers'])
    const status = num(p['statusCode'])
    const d = this.drafts.get(id)
    if (!d) {
      this.bufferOrphan('res', id, headers, status)
      return
    }
    d.responseExtra = { headers: mergeHeaders(d.responseExtra?.headers ?? {}, headers), statusCode: status ?? d.responseExtra?.statusCode }
    d.expectResponseExtra = false
    this.rebuildResponse(d)
    d.wakeExtraWaiter?.()
  }

  private onLoadingFinished(p: Params): void {
    const id = this.requireId(p)
    const d = this.drafts.get(id)
    if (!d) return
    if (!d.tracked) {
      this.drafts.delete(id)
      return
    }
    if (d.finishing) return
    d.finishing = true
    const ts = num(p['timestamp'])
    if (ts !== undefined) d.ex.durationMs = Math.max(0, Math.round((ts - d.firstStartedAt) * 1000))
    d.bodyPart.finishedAt = ts
    const enc = num(p['encodedDataLength'])
    if (enc !== undefined) d.bodyPart.encodedDataLength = enc
    this.bodyFetchPending += 1
    void this.finish(d).then((ready) => {
      // The pending count drops BEFORE listeners run, so a listener sees only OTHER work as pending.
      this.bodyFetchPending -= 1
      if (ready) this.settle(d)
      this.checkIdle()
    })
  }

  private onLoadingFailed(p: Params): void {
    const id = this.requireId(p)
    const d = this.drafts.get(id)
    if (!d) return
    if (!d.tracked) {
      this.drafts.delete(id)
      return
    }
    if (d.finishing) return
    d.finishing = true
    const ts = num(p['timestamp'])
    if (ts !== undefined) d.ex.durationMs = Math.max(0, Math.round((ts - d.firstStartedAt) * 1000))
    d.ex.state = 'failed'
    d.ex.failure = {
      errorText: str(p['errorText']) ?? 'unknown',
      canceled: p['canceled'] === true ? true : undefined,
      blockedReason: str(p['blockedReason']),
      corsErrorStatus: p['corsErrorStatus'],
    }
    this.rebuildResponse(d)
    this.settle(d)
    this.checkIdle()
  }

  // ---- merge ---------------------------------------------------------------------------------

  private rebuildRequest(d: Draft): void {
    d.ex.request = { ...d.mainRequest, headers: mergeHeaders(d.mainRequest.headers, d.requestExtra) }
    if (d.requestExtra) d.ex.wire.requestExtraInfo = true
  }

  private rebuildResponse(d: Draft): void {
    const main = d.mainResponse
    const extra = d.responseExtra
    const hasBody = Object.keys(d.bodyPart).length > 0
    if (!main && !extra && !hasBody) {
      d.ex.response = undefined
      return
    }
    const base: RecordedResponse = main ?? { status: 0, headers: {} }
    const status = extra?.statusCode !== undefined && extra.statusCode > 0 ? extra.statusCode : base.status
    d.ex.response = { ...base, status, headers: mergeHeaders(base.headers, extra?.headers), ...d.bodyPart }
    if (extra) d.ex.wire.responseExtraInfo = true
  }

  private matches(url: string, method: string): boolean {
    const f = this.opts.filter
    return f ? f(url, method) : true
  }

  // ---- ExtraInfo orphan buffer -------------------------------------------------------------

  private bufferOrphan(kind: 'req' | 'res', id: string, headers: Headers, statusCode?: number): void {
    const t = this.now()
    this.purgeExpired(t)
    const key = `${kind}:${id}`
    const prev = this.orphans.get(key)
    if (prev) this.orphans.delete(key) // re-insert as newest
    else if (this.orphans.size >= EXTRA_INFO_BUFFER_MAX) {
      const oldest = this.orphans.keys().next()
      if (!oldest.done) this.orphans.delete(oldest.value)
    }
    this.orphans.set(key, { kind, headers: prev ? mergeHeaders(prev.headers, headers) : headers, statusCode: statusCode ?? prev?.statusCode, at: t })
  }

  private takeOrphan(kind: 'req' | 'res', id: string): BufferedExtra | undefined {
    const key = `${kind}:${id}`
    const e = this.orphans.get(key)
    if (!e) return undefined
    this.orphans.delete(key)
    return this.now() - e.at > EXTRA_INFO_BUFFER_TTL_MS ? undefined : e
  }

  private purgeExpired(t: number): void {
    for (const [k, e] of this.orphans) {
      if (t - e.at <= EXTRA_INFO_BUFFER_TTL_MS) break // insertion order is age order
      this.orphans.delete(k)
    }
  }

  // ---- finishing pipeline ----------------------------------------------------------------

  private async fetchPostData(d: Draft, forRequest: RecordedRequest): Promise<void> {
    this.bodyFetchPending += 1
    try {
      const r = await this.session.send<{ postData?: unknown }>('Network.getRequestPostData', { requestId: d.id })
      const postData = str(r?.postData)
      if (postData !== undefined && d.mainRequest === forRequest) {
        d.mainRequest.postData = postData
        this.rebuildRequest(d)
      }
    } catch {
      /* post data is best effort; the exchange simply carries none */
    } finally {
      this.bodyFetchPending -= 1
      this.checkIdle()
    }
  }

  /** Resolves true when the exchange is finished and ready to settle, false when it was abandoned. Never rejects. */
  private async finish(d: Draft): Promise<boolean> {
    try {
      if (d.postDataFetch) await d.postDataFetch
      await this.awaitResponseExtra(d)
      if (this.stopped) return false
      this.rebuildResponse(d)
      await this.fetchBody(d)
      if (this.stopped) return false
      d.ex.state = 'finished'
      this.rebuildResponse(d)
      return true
    } catch (e) {
      this.logger(`[recorder] ${d.id}: ${errorMessage(e)}`)
      return false
    }
  }

  /** Wait (bounded) for response ExtraInfo that the main event announced but has not arrived. */
  private awaitResponseExtra(d: Draft): Promise<void> {
    const grace = this.opts.extraInfoGraceMs ?? DEFAULT_EXTRA_INFO_GRACE_MS
    if (!d.expectResponseExtra || d.responseExtra || grace <= 0 || this.stopped) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.graceTimers.delete(timer)
        d.wakeExtraWaiter = undefined
        resolve()
      }
      const timer = setTimeout(done, grace)
      unref(timer)
      this.graceTimers.add(timer)
      d.wakeExtraWaiter = done
    })
  }

  private shouldFetchBody(d: Draft): boolean {
    const f = this.opts.fetchBodies
    if (f === undefined) return true
    return typeof f === 'function' ? f(d.ex) : f
  }

  private async fetchBody(d: Draft): Promise<void> {
    if (!this.shouldFetchBody(d)) return
    const max = this.opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
    if ((d.bodyPart.encodedDataLength ?? 0) > max) {
      d.bodyPart.bodyError = 'BODY_TOO_LARGE'
      return
    }
    try {
      const r = await this.session.send<{ body?: unknown; base64Encoded?: unknown }>('Network.getResponseBody', { requestId: d.id })
      const body = str(r?.body)
      if (body === undefined) throw new Error('no body in Network.getResponseBody result')
      const base64 = r.base64Encoded === true
      const bytes = base64 ? Math.floor((body.length * 3) / 4) : Buffer.byteLength(body)
      if (bytes > max) {
        d.bodyPart.bodyError = 'BODY_TOO_LARGE'
        return
      }
      d.bodyPart.body = body
      d.bodyPart.bodyEncoding = base64 ? 'base64' : 'utf8'
    } catch (e) {
      this.rebuildResponse(d)
      const status = d.ex.response?.status
      if (status !== undefined && NO_CONTENT_STATUSES.has(status)) {
        d.bodyPart.body = ''
        d.bodyPart.bodyEncoding = 'utf8'
      } else {
        d.bodyPart.bodyError = errorMessage(e)
      }
    }
  }

  // ---- settle + sink ------------------------------------------------------------------------

  private settle(d: Draft): void {
    if (this.stopped || this.closeStarted) return
    for (const l of [...this.settledListeners]) {
      try {
        l(d.ex)
      } catch (e) {
        this.logger(`[recorder] settle listener: ${errorMessage(e)}`)
      }
    }
    const { onExchange, sink } = this.opts
    if (!onExchange && !sink) return
    const redacted = this.opts.redact ? this.opts.redact(d.ex) : d.ex
    if (onExchange) {
      try {
        onExchange(redacted)
      } catch (e) {
        this.logger(`[recorder] onExchange: ${errorMessage(e)}`)
      }
    }
    if (sink) this.enqueue(redacted)
  }

  private enqueue(exchange: RecordedExchange): void {
    this.seq += 1
    const envelope: RecordingEnvelope = {
      recordingId: this.recordingId,
      key: `${this.recordingId}:${exchange.requestId}`,
      seq: this.seq,
      ts: new Date(this.now()).toISOString(),
      exchange,
    }
    const maxQueue = this.opts.maxQueue ?? DEFAULT_MAX_QUEUE
    if (this.unsent >= maxQueue) {
      this.unreportedDropped += 1
      this.logger(`[recorder] sink queue full (${maxQueue}): dropped ${envelope.key}`)
      return
    }
    this.unsent += 1
    this.queue.push(envelope)
    if (!this.pumpScheduled) {
      this.pumpScheduled = true
      this.chain = this.chain.then(() => this.pump())
    }
  }

  private recordSinkFailure(cause: unknown, count: number, what: string): void {
    this.unreportedFailed += count
    if (this.firstCause === undefined) this.firstCause = cause
    this.logger(`[recorder] sink ${what} failed: ${errorMessage(cause)}`)
  }

  private async pump(): Promise<void> {
    this.pumpScheduled = false
    const sink = this.opts.sink
    if (!sink) return
    const batchSize = Math.max(1, this.opts.batchSize ?? DEFAULT_BATCH_SIZE)
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, sink.writeBatch ? batchSize : 1)
      try {
        if (sink.writeBatch && batch.length > 1) {
          try {
            await sink.writeBatch(batch)
          } catch (e) {
            this.recordSinkFailure(e, batch.length, 'writeBatch')
          }
        } else {
          for (const env of batch) {
            try {
              await sink.write(env)
            } catch (e) {
              this.recordSinkFailure(e, 1, `write ${env.key}`)
            }
          }
        }
      } finally {
        this.unsent -= batch.length
      }
    }
  }

  private async drain(): Promise<void> {
    for (;;) {
      const c = this.chain
      await c
      if (c === this.chain && this.unsent === 0) return
    }
  }

  private async withTimeout(work: Promise<void>, what: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${DEFAULT_CLOSE_TIMEOUT_MS}ms`)), DEFAULT_CLOSE_TIMEOUT_MS)
      unref(timer)
    })
    try {
      await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async flushQuiet(): Promise<void> {
    const sink: RecordingSink | undefined = this.opts.sink
    if (!sink) return
    try {
      await this.withTimeout(this.drain(), 'sink drain')
      await sink.flush?.()
    } catch (e) {
      this.recordSinkFailure(e, 1, 'flush')
    }
  }

  private throwUnreported(): void {
    const failed = this.unreportedFailed
    const dropped = this.unreportedDropped
    if (failed + dropped === 0) return
    const firstCause = this.firstCause
    this.unreportedFailed = 0
    this.unreportedDropped = 0
    this.firstCause = undefined
    throw captureError('CAPTURE_SINK_FAILED', `recording sink lost data: ${failed} failed, ${dropped} dropped`, {
      cause: firstCause,
      detail: { failed, dropped, firstCause },
    })
  }

  /** Wait until every queued envelope is written, then flush the sink. Rejects CAPTURE_SINK_FAILED for failures since the last flush. */
  async flush(): Promise<void> {
    await this.flushQuiet()
    this.throwUnreported()
  }

  /** flush, then sink.close, then stop(). Idempotent. Rejects CAPTURE_SINK_FAILED when the sink lost data. */
  close(): Promise<void> {
    this.closeStarted = true
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    const sink = this.opts.sink
    if (sink) {
      await this.flushQuiet()
      try {
        await sink.close?.()
      } catch (e) {
        this.recordSinkFailure(e, 1, 'close')
      }
    }
    this.stop()
    this.throwUnreported()
  }

  // ---- idle -----------------------------------------------------------------------------------

  private isIdle(): boolean {
    return this.bodyFetchPending === 0 && this.inflight() === 0
  }

  private checkIdle(): void {
    if (this.bodyFetchPending === 0) this.idleListener?.()
    if (this.idleWaiters.length > 0 && this.isIdle()) for (const w of this.idleWaiters.splice(0)) w()
  }
}
