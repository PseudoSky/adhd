/**
 * @adhd/stealth-browser — src/lib/recording/types.ts
 *
 * Public types of the capture pipeline: the exchange model a `NetworkRecorder`
 * folds out of `Network.*` events, the recorder options and the optional
 * persistence seam (`RecordingSink`).
 *
 * Ticket 8468f7b1 · plan state capture-upgrade (spec 5.3, design B'' in EVAL-store-adapter.md).
 */

/** CDP header shape: one string per name, duplicate headers joined by "\n". */
export type Headers = Record<string, string>

export interface RecordedRequest {
  method: string
  url: string
  headers: Headers
  postData?: string
  hasPostData?: boolean
  resourceType?: string
  /** CDP MonotonicTime (seconds) at which the request was sent. */
  startedAt: number
  wallTime?: number
}

export interface RecordedResponse {
  status: number
  statusText?: string
  headers: Headers
  mimeType?: string
  protocol?: string
  remoteIPAddress?: string
  fromCache?: boolean
  encodedDataLength?: number
  body?: string
  bodyEncoding?: 'utf8' | 'base64'
  bodyError?: string
  finishedAt?: number
}

export interface RedirectHop {
  request: RecordedRequest
  response: RecordedResponse
}

export interface RecordedFailure {
  errorText: string
  canceled?: boolean
  blockedReason?: string
  corsErrorStatus?: unknown
}

export type ExchangeState = 'inflight' | 'finished' | 'failed'

export interface RecordedExchange {
  requestId: string
  /** URL of the LAST hop (the final request of a redirect chain). */
  url: string
  request: RecordedRequest
  response?: RecordedResponse
  redirects: RedirectHop[]
  failure?: RecordedFailure
  /** Whether the Chrome-internal ExtraInfo events were merged into this exchange. */
  wire: { requestExtraInfo: boolean; responseExtraInfo: boolean }
  state: ExchangeState
  durationMs?: number
}

/** One settled exchange as handed to a sink. */
export interface RecordingEnvelope {
  recordingId: string
  /** `${recordingId}:${requestId}` — the idempotency key. */
  key: string
  /** Strictly increasing per recorder, starting at 1. */
  seq: number
  /** ISO timestamp from the recorder clock. */
  ts: string
  exchange: RecordedExchange
}

/**
 * Optional persistence seam. A sink is a pure observer: a throwing sink never
 * changes what capture returns.
 */
export interface RecordingSink {
  /** Called once per settled exchange (state finished or failed), after redaction. */
  write(envelope: RecordingEnvelope): void | Promise<void>
  /** Optional batch form; the recorder prefers it when more than one envelope is queued. */
  writeBatch?(envelopes: readonly RecordingEnvelope[]): void | Promise<void>
  flush?(): void | Promise<void>
  /** Idempotent. */
  close?(): void | Promise<void>
}

export interface RecorderOptions {
  /** Which exchanges are tracked. Evaluated per hop and sticky: tracked once ANY hop matched. Default: all. */
  filter?: (url: string, method: string) => boolean
  /** Whether to fetch response bodies for tracked exchanges. Default true. */
  fetchBodies?: boolean | ((exchange: RecordedExchange) => boolean)
  /** Larger bodies are omitted and flagged `bodyError: 'BODY_TOO_LARGE'`. Default 5_000_000. */
  maxBodyBytes?: number
  /** How long to wait for response ExtraInfo after loadingFinished when it was announced. Default 100. */
  extraInfoGraceMs?: number
  sink?: RecordingSink
  /** Receives the REDACTED exchange of every settled tracked exchange. */
  onExchange?: (exchange: RecordedExchange) => void
  /** Applied before `onExchange` and the sink; in-memory exchanges stay raw. Default identity. */
  redact?: (exchange: RecordedExchange) => RecordedExchange
  recordingId?: string
  /** Unsent envelopes kept before the newest is dropped. Default 1000. */
  maxQueue?: number
  /** Envelopes handed to `writeBatch` at once. Default 50. */
  batchSize?: number
  /** Default console.error. */
  logger?: (message: string) => void
  /** Clock for envelope timestamps and the ExtraInfo orphan TTL. Default `Date.now`. */
  now?: () => number
}
