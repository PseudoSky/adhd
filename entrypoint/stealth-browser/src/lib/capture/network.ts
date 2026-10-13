/**
 * @adhd/stealth-browser — src/lib/capture/network.ts
 *
 * Event-driven CDP network capture: a thin wrapper over the one capture
 * pipeline. It connects a `CdpSession`, attaches a `NetworkRecorder`,
 * navigates, waits for the matching bodies and selects the answer.
 *
 * Flow:
 *   1. connect a CdpSession to the page's webSocketDebuggerUrl (or use the one supplied)
 *   2. Page.enable, then the recorder subscribes and sends Network.enable, then Page.navigate
 *   3. every response whose request URL matches `urlPattern` (sticky across redirects) has its body fetched
 *   4. resolve once a body has landed, `extraWaitMs` has passed without another body, and no body fetch is in flight
 *   5. select (default: the largest body; ties go to the later capture), check ban rules on the selected response
 *
 * Graceful outcomes: a timeout, a closed socket or a failed navigation with at least one captured body is a
 * success; only an empty-handed capture throws a typed `CaptureError`. A recording sink is a pure observer:
 * its failures are logged and never change what is returned or thrown.
 *
 * Ticket 8468f7b1 · plan state capture-upgrade [capture-upgrade.1] [capture-upgrade.4] [capture-upgrade.8] [capture-upgrade.9] [capture-upgrade.12].
 */

import { CdpSession } from '../cdp/session.js'
import { captureError, errorMessage, type CaptureError } from '../recording/errors.js'
import { NetworkRecorder, decodeBody } from '../recording/network-recorder.js'
import type { Headers, RecordedExchange, RecordedRequest, RecordingSink, RedirectHop } from '../recording/types.js'
import type { BanRule } from '../types.js'
import { checkBans } from './bans.js'

export interface CaptureOptions {
  urlPattern: RegExp
  /** Hard upper bound of the whole capture. Default 10_000. */
  timeoutMs?: number
  /** Quiet period after the latest landed body before resolving. Default 0 = resolve at once. */
  extraWaitMs?: number
  banRules?: BanRule[]
  navigateUrl: string
  /** Choose among the captured candidates (landing order). Default: the largest body, ties to the later capture. */
  select?: (candidates: readonly RecordedExchange[]) => RecordedExchange | undefined
  /** Optional persistence. Closed by the capture, also when it throws. */
  sink?: RecordingSink
  /** Applied to what the sink and `onExchange` receive. Default identity. */
  redact?: (exchange: RecordedExchange) => RecordedExchange
  onExchange?: (exchange: RecordedExchange) => void
  /** Unsent sink envelopes kept before the newest is dropped. Default 1000. */
  maxQueue?: number
  recordingId?: string
  /** Default console.error. */
  logger?: (message: string) => void
  /** Use this connected session instead of opening one. A supplied session is never closed. */
  session?: CdpSession
}

export interface CapturedResponse {
  requestId: string
  /** URL of the final hop (the request that produced the body), or `navigateUrl` when empty. */
  url: string
  /** The REAL response status (ExtraInfo `statusCode` wins). */
  status: number
  /** Decoded response text ('' when the response has no body). */
  body: string
  /** Response headers (ExtraInfo merged). */
  headers: Headers
  /** Same object as `headers`; the name the runner has always exposed. */
  responseHeaders: Headers
  method: string
  requestHeaders: Headers
  postData?: string
  mimeType?: string
  redirects: RedirectHop[]
  durationMs?: number
  exchange: RecordedExchange
}

type FinishReason = 'settled' | 'timeout' | 'closed' | 'connect-failed' | 'navigate-failed'

const DEFAULT_TIMEOUT_MS = 10_000
/** The session exposes `connected` but no close event, so a closed socket is noticed by polling. */
const SESSION_POLL_MS = 50
const MAX_NO_MATCH_URLS = 10

const defaultLogger = (message: string): void => console.error(message)

function firstStartedAt(ex: RecordedExchange): number {
  const first: RecordedRequest = ex.redirects[0]?.request ?? ex.request
  return first.startedAt
}

function largestBody(candidates: readonly RecordedExchange[]): RecordedExchange | undefined {
  if (candidates.length === 0) return undefined
  const len = (e: RecordedExchange): number => decodeBody(e.response).length
  return candidates.reduce((a, b) => (len(a) > len(b) ? a : b))
}

function toCaptured(ex: RecordedExchange, navigateUrl: string): CapturedResponse {
  const headers = ex.response?.headers ?? {}
  return {
    requestId: ex.requestId,
    url: ex.url || navigateUrl,
    status: ex.response?.status ?? 0,
    body: decodeBody(ex.response),
    headers,
    responseHeaders: headers,
    method: ex.request.method,
    requestHeaders: ex.request.headers,
    postData: ex.request.postData,
    mimeType: ex.response?.mimeType,
    redirects: ex.redirects,
    durationMs: ex.durationMs,
    exchange: ex,
  }
}

function assertNoBan(options: CaptureOptions, captured: CapturedResponse): void {
  if (!options.banRules || options.banRules.length === 0) return
  const signal = checkBans(options.banRules, { url: captured.url, status: captured.status, body: captured.body })
  if (signal) {
    throw captureError('CAPTURE_BAN_DETECTED', `ban detected: ${signal}`, { detail: { signal, url: captured.url, status: captured.status } })
  }
}

/** The one capture run behind both public functions. Resolves the candidates (landing order) or throws a CaptureError. */
async function runCapture(pageWsUrl: string, options: CaptureOptions): Promise<RecordedExchange[]> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const extraWaitMs = options.extraWaitMs ?? 0
  const logger = options.logger ?? defaultLogger
  const ownsSession = options.session === undefined
  const session = options.session ?? new CdpSession()
  const pattern = options.urlPattern

  const recorder = new NetworkRecorder(session, {
    filter: (url) => {
      pattern.lastIndex = 0
      return pattern.test(url)
    },
    sink: options.sink,
    onExchange: options.onExchange,
    redact: options.redact,
    maxQueue: options.maxQueue,
    recordingId: options.recordingId,
    logger,
  })

  const candidates: RecordedExchange[] = []
  let finished = false
  let reason: FinishReason | undefined
  let connectCause: unknown
  let navigateFailure: { cause?: unknown; errorText?: string } | undefined
  let sessionOpened = false
  let waitIdle = false
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let resolveDone!: () => void
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  // Stage captured before anything async can add candidates after the verdict.
  let snapshot: RecordedExchange[] = []

  const finalize = (r: FinishReason): void => {
    if (finished) return
    finished = true
    reason = r
    snapshot = [...candidates]
    resolveDone()
  }

  /** NAVIGATE_FAILED only when navigation failed, nothing was captured and nothing is in flight. */
  const nothingLeftAfterNavigateFailure = (): boolean =>
    navigateFailure !== undefined && candidates.length === 0 && recorder.inflight() === 0 && recorder.pending() === 0
  const checkNavigateFailure = (): void => {
    if (nothingLeftAfterNavigateFailure()) finalize('navigate-failed')
  }

  /** Resolve unless a body fetch (bodyFetchPending in the recorder) is still in flight. */
  const settleNow = (): void => {
    if (finished) return
    if (recorder.pending() > 0) {
      waitIdle = true
      return
    }
    finalize('settled')
  }
  const armDebounce = (): void => {
    waitIdle = false
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = undefined
    if (extraWaitMs > 0) debounceTimer = setTimeout(settleNow, extraWaitMs)
    else settleNow()
  }

  recorder.onIdle(() => {
    if (waitIdle) finalize('settled')
    else checkNavigateFailure()
  })
  const offSettled = recorder.onSettled((ex) => {
    if (finished) return
    if (ex.state === 'finished' && ex.response?.body !== undefined) {
      candidates.push(ex)
      armDebounce()
    } else {
      checkNavigateFailure()
    }
  })

  const timeoutTimer = setTimeout(() => finalize('timeout'), timeoutMs)
  const closePoll = setInterval(() => {
    if (sessionOpened && !session.connected) finalize('closed')
  }, SESSION_POLL_MS)
  for (const t of [timeoutTimer, closePoll]) t.unref()

  // Runs alongside the wait below; it never rejects and stops acting once the verdict is in.
  void (async (): Promise<void> => {
    try {
      if (!session.connected) {
        const connecting = session.connect(pageWsUrl)
        connecting.catch(() => undefined) // a late rejection after the verdict is not unhandled
        await Promise.race([connecting, done])
        if (finished) return
      }
      sessionOpened = true
      await session.send('Page.enable').catch((e: unknown) => logger(`[capture] Page.enable: ${errorMessage(e)}`))
      if (finished) return
      await recorder.start().catch((e: unknown) => logger(`[capture] Network.enable: ${errorMessage(e)}`))
      if (finished) return
      try {
        const nav = await session.send<{ errorText?: string }>('Page.navigate', { url: options.navigateUrl })
        if (nav.errorText) navigateFailure = { errorText: nav.errorText }
      } catch (e) {
        navigateFailure = { cause: e }
        if (!finished) logger(`[capture] Page.navigate: ${errorMessage(e)}`)
      }
      if (navigateFailure && !finished) checkNavigateFailure()
    } catch (e) {
      if (!sessionOpened) {
        connectCause = e
        finalize('connect-failed')
      } else if (!finished) {
        logger(`[capture] setup: ${errorMessage(e)}`)
      }
    }
  })()

  try {
    await done
    if (snapshot.length > 0) return snapshot
    throw failureFor(reason ?? 'timeout')
  } finally {
    clearTimeout(timeoutTimer)
    clearInterval(closePoll)
    if (debounceTimer) clearTimeout(debounceTimer)
    recorder.onIdle(undefined)
    offSettled()
    finished = true
    try {
      await recorder.close()
    } catch (e) {
      // The sink is a pure observer: its loss is reported, never allowed to replace the capture outcome.
      logger(`[capture] recording sink: ${errorMessage(e)}`)
    }
    if (ownsSession) session.close()
  }

  function failureFor(r: FinishReason): CaptureError {
    switch (r) {
      case 'connect-failed':
        return captureError('CAPTURE_CONNECT_FAILED', `cannot connect to ${pageWsUrl}: ${errorMessage(connectCause)}`, { cause: connectCause })
      case 'navigate-failed':
        return navigateError()
      case 'closed':
        return captureError('CAPTURE_SESSION_CLOSED', 'the CDP socket closed before any matching response was captured')
      case 'timeout':
      case 'settled':
        if (nothingLeftAfterNavigateFailure()) return navigateError()
        if (recorder.seenUrls().length > 0 && recorder.exchanges().length === 0) {
          return captureError('CAPTURE_NO_MATCH', `no request matched ${String(pattern)}`, {
            detail: { urls: recorder.seenUrls().slice(0, MAX_NO_MATCH_URLS) },
          })
        }
        return captureError('CAPTURE_TIMEOUT', `nothing captured within ${timeoutMs}ms`, { detail: { timeoutMs } })
    }
  }

  function navigateError(): CaptureError {
    const text = navigateFailure?.errorText ?? errorMessage(navigateFailure?.cause)
    return captureError('CAPTURE_NAVIGATE_FAILED', `Page.navigate to ${options.navigateUrl} failed: ${text}`, {
      cause: navigateFailure?.cause,
      detail: { errorText: navigateFailure?.errorText },
    })
  }
}

/** Capture the response selected among the matching ones (default: the largest body). */
export async function captureNetworkResponse(pageWsUrl: string, options: CaptureOptions): Promise<CapturedResponse> {
  const candidates = await runCapture(pageWsUrl, options)
  const chosen = (options.select ?? largestBody)(candidates)
  if (!chosen) {
    throw captureError('CAPTURE_NO_MATCH', 'the selector chose none of the captured responses', {
      detail: { urls: candidates.map((c) => c.url).slice(0, MAX_NO_MATCH_URLS) },
    })
  }
  const captured = toCaptured(chosen, options.navigateUrl)
  assertNoBan(options, captured)
  return captured
}

/** Capture every matching finished response that has a body, ordered by start. Ban rules are checked on each. */
export async function captureAllNetworkResponses(pageWsUrl: string, options: CaptureOptions): Promise<CapturedResponse[]> {
  const candidates = await runCapture(pageWsUrl, options)
  const ordered = [...candidates].sort((a, b) => firstStartedAt(a) - firstStartedAt(b))
  const all = ordered.map((ex) => toCaptured(ex, options.navigateUrl))
  for (const c of all) assertNoBan(options, c)
  return all
}
