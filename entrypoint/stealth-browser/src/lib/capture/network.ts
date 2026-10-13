/**
 * stealth-browser/src/lib/capture/network.ts — Event-driven CDP network capture.
 *
 * Opens a raw CDP WebSocket to a page, subscribes to Network events,
 * captures every response matching a URL pattern, and returns the body.
 *
 * Flow:
 *   1. Connect via WebSocket to the page's webSocketDebuggerUrl
 *   2. Send Network.enable
 *   3. Subscribe to Network events
 *   4. Navigate
 *   5. Resolve AS SOON AS the matching response body is captured
 *      (no waiting for Page.loadEventFired — response arrives first)
 *   6. Return the captured response
 *
 * Speed: typically ~800ms for static HTML providers.
 */

import type { BanRule } from '../types.js'
import { checkBans } from './bans.js'

export interface CaptureOptions {
  urlPattern: RegExp
  timeoutMs?: number
  extraWaitMs?: number
  banRules?: BanRule[]
  navigateUrl: string
}

export interface CapturedResponse {
  requestId: string
  url: string
  status: number
  body: string
  responseHeaders?: Record<string, string>
}

interface CdpResponse {
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string }
}

interface CdpEvent {
  method: string
  params: Record<string, unknown>
}

interface InflightRequest {
  requestId: string
  url: string
  method: string
  status: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  base64Encoded?: boolean
  finished: boolean
}

export async function captureNetworkResponse(
  pageWsUrl: string,
  options: CaptureOptions,
): Promise<CapturedResponse> {
  const urlPattern = options.urlPattern
  const timeoutMs = options.timeoutMs ?? 10_000
  const extraWaitMs = options.extraWaitMs ?? 0

  // Track what we need
  let matchedRequest = null as InflightRequest | null
  let matchError: string | null = null

  // Create a promise that resolves after extraWaitMs, picks the best
  // matching response from all captured bodies
  const resultPromise = new Promise<void>((resolve) => {
    const ws = new WebSocket(pageWsUrl)
    let nextId = 1
    const pending = new Map<number, (r: CdpResponse) => void>()
    let timedOut = false
    let resolveTimer: ReturnType<typeof setTimeout> | null = null
    let isResolved = false

    function finalize(): void {
      if (isResolved) return
      isResolved = true
      // Pick the best response: prefer the largest body (typically the document HTML),
      // then fallback to the first captured.
      if (capturedBodies.length > 0) {
        const best = capturedBodies.reduce((a, b) => (a.body.length > b.body.length ? a : b))
        matchedRequest = { requestId: '', url: best.url, method: 'GET', status: 200, responseBody: best.body, base64Encoded: false, finished: true }
      }
      if (!matchedRequest && !matchError) matchError = 'timeout'
      if (resolveTimer) clearTimeout(resolveTimer)
      clearTimeout(timeoutTimer)
      ws.close()
      resolve()
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      if (!matchError) matchError = 'timeout'
      finalize()
    }, timeoutMs)

    ws.addEventListener('open', () => {
      // Enable Page + Network, then navigate
      send('Page.enable').catch((e) => console.error('[capture] Page.enable:', e.message))
      send('Network.enable').catch((e) => console.error('[capture] Network.enable:', e.message))
      send('Page.navigate', { url: options.navigateUrl }).catch((e) => console.error('[capture] Page.navigate:', e.message))
    })

    // Track requestIds whose URLs match our pattern
    const trackedRequestIds = new Set<string>()
    const allUrls = new Map<string, string>()
    // Buffer all captured responses — pick the best one after extraWaitMs
    const capturedBodies: Array<{ url: string; body: string }> = []

    ws.addEventListener('message', (ev) => {
      if (timedOut) return
      const msg = JSON.parse(String(ev.data)) as CdpResponse | CdpEvent

      if ('id' in msg && typeof msg.id === 'number') {
        const cb = pending.get(msg.id)
        if (cb) { pending.delete(msg.id); cb(msg) }
        return
      }

      const event = msg as CdpEvent
      const p = event.params

      if (event.method === 'Network.requestWillBeSent') {
        const r = p as { requestId: string; request: { url: string; method: string } }
        allUrls.set(r.requestId, r.request.url)
        if (urlPattern.test(r.request.url)) {
          trackedRequestIds.add(r.requestId)
        }
      } else if (event.method === 'Network.loadingFinished') {
        const r = p as { requestId: string }
        if (!trackedRequestIds.has(r.requestId)) return

        const bodyId = nextId++
        pending.set(bodyId, (resp: CdpResponse) => {
          if (resp.error) return
          const result = resp.result as { body: string; base64Encoded: boolean } | undefined
          if (!result) return
          const body = result.base64Encoded
            ? Buffer.from(result.body, 'base64').toString('utf-8')
            : result.body
          capturedBodies.push({
            url: allUrls.get(r.requestId) ?? '',
            body,
          })
          // Resolve after extraWaitMs once we get at least one body
          if (resolveTimer) clearTimeout(resolveTimer)
          resolveTimer = setTimeout(finalize, extraWaitMs > 0 ? extraWaitMs : 500)
        })
        ws.send(JSON.stringify({
          id: bodyId,
          method: 'Network.getResponseBody',
          params: { requestId: r.requestId },
        }))
      }
    })

    ws.addEventListener('error', () => {
      if (!matchError) matchError = 'WebSocket error'
      finalize()
    })

    function send(method: string, params: Record<string, unknown> = {}) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++
        pending.set(id, (r) => r.error ? reject(new Error(r.error.message)) : resolve(r.result ?? {}))
        try { ws.send(JSON.stringify({ id, method, params })) } catch { reject(new Error('ws closed')) }
      })
    }
  })

  await resultPromise

  if (!matchedRequest) {
    throw new Error(matchError ?? 'No matching request captured')
  }

  const body = matchedRequest.responseBody ?? ''
  const url = matchedRequest.url || options.navigateUrl

  // Ban detection
  if (options.banRules && options.banRules.length > 0) {
    const banSignal = checkBans(options.banRules, {
      url,
      status: matchedRequest.status,
      body,
    })
    if (banSignal) {
      throw new Error(`Ban detected: ${banSignal}`)
    }
  }

  return {
    requestId: matchedRequest.requestId,
    url,
    status: matchedRequest.status,
    body,
    responseHeaders: matchedRequest.responseHeaders,
  }
}
