/**
 * guards: a capture with no body is reported as empty, or a socket error or timeout is not retried
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.15]
 * A capture that produced no body is never `empty`: it is `timeout` (no error or the capture timeout) or `error`
 * (a socket error), and the retry policy retries both while a parsed zero-result page is not retried.
 * Inventory row I-24.a (no-body capture is timeout or error). Ports retry-policy-test.ts.
 * Ticket 8468f7b1 · [search-port-engine.15] · commit c00edea.
 */
import { describe, expect, it } from 'vitest'
import { capture } from '@adhd/stealth-core-browser'
import { getProvider } from '../../../src/lib/providers.js'
import { networkSearch, noCaptureOutcome } from '../../../src/lib/network.js'
import { body, captureFailure, fixture, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const ddg = getProvider('duckduckgo')
const retry = ddg.retry

describe('c00edea: noCaptureOutcome is a pure function [search-port-engine.15]', () => {
  it('noCaptureOutcome: null gives timeout (retried), never empty', () => {
    expect(noCaptureOutcome(null)).toBe('timeout')
  })

  it('noCaptureOutcome: undefined and the capture timeout give timeout', () => {
    expect(noCaptureOutcome(undefined)).toBe('timeout')
    expect(noCaptureOutcome('timeout')).toBe('timeout')
  })

  it('noCaptureOutcome: WebSocket error gives error (retried) and the error text is not lost', () => {
    expect(noCaptureOutcome('WebSocket error')).toBe('error')
    expect(noCaptureOutcome('the CDP socket closed before any matching response was captured')).toBe('error')
  })

  it('noCaptureOutcome: the no-capture result is retried by the core policy while empty is not (timeout, error retried; empty legitimate zero results)', () => {
    expect(capture.decideRetry({ outcome: noCaptureOutcome(null) }, 1, retry).shouldRetry).toBe(true)
    expect(capture.decideRetry({ outcome: noCaptureOutcome('WebSocket error') }, 1, retry).shouldRetry).toBe(true)
    const empty = capture.decideRetry({ outcome: 'empty' }, 1, retry)
    expect(empty.shouldRetry).toBe(false)
    expect(empty.reason).toMatch(/legitimate zero results/)
    expect(capture.decideRetry({ outcome: 'timeout' }, 1, { ...retry, onTimeout: 'abort' }).shouldRetry).toBe(false)
  })
})

describe('c00edea: no-body capture is timeout or error, an engine run over a capture that ends without a body [search-port-engine.15]', () => {
  it('timeout, not empty: a capture that timed out with nothing captured (CAPTURE_TIMEOUT) returns outcome timeout and is retried', async () => {
    const rec = recordingCapture(async () => {
      throw captureFailure('CAPTURE_TIMEOUT', 'nothing captured within 30000ms')
    })
    const r = await networkSearch('ws://page', ddg, 'tree-sitter', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('timeout')
    expect(r.outcome).not.toBe('empty')
    expect(r.error).toBe('nothing captured within 30000ms')
    expect(capture.decideRetry(r, 0, retry).shouldRetry).toBe(true)
  })

  it('timeout, not empty: a page whose requests never matched the url pattern (CAPTURE_NO_MATCH) returns timeout', async () => {
    const rec = recordingCapture(async () => {
      throw captureFailure('CAPTURE_NO_MATCH', 'no request matched /html.duckduckgo.com/')
    })
    const r = await networkSearch('ws://page', ddg, 'tree-sitter', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('timeout')
  })

  it('WebSocket error: a raw socket error from the capture returns outcome error carrying the error text, retried', async () => {
    const rec = recordingCapture(async () => {
      throw new Error('WebSocket error')
    })
    const r = await networkSearch('ws://page', ddg, 'tree-sitter', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('error')
    expect(r.error).toBe('WebSocket error')
    expect(capture.decideRetry(r, 0, retry).shouldRetry).toBe(true)
  })

  it('WebSocket error: a closed socket (CAPTURE_SESSION_CLOSED) and a failed connect return outcome error', async () => {
    for (const [code, message] of [
      ['CAPTURE_SESSION_CLOSED', 'the CDP socket closed before any matching response was captured'],
      ['CAPTURE_CONNECT_FAILED', 'cannot connect to ws://page: WebSocket error'],
      ['CAPTURE_NAVIGATE_FAILED', 'Page.navigate to https://x failed: net::ERR_NAME_NOT_RESOLVED'],
    ] as const) {
      const rec = recordingCapture(async () => {
        throw captureFailure(code, message)
      })
      const r = await networkSearch('ws://page', ddg, 'x', {}, makeDeps({ capture: rec.capture }))
      expect(r.outcome).toBe('error')
      expect(r.error).toBe(message)
    }
  })

  it('empty is reserved for a captured page that parsed to zero results, which is not retried', async () => {
    const rec = recordingCapture(async () => body(fixture('ddg-empty.html')))
    const r = await networkSearch('ws://page', ddg, 'zzqxv', {}, makeDeps({ capture: rec.capture }))
    expect(r.outcome).toBe('empty')
    expect(capture.decideRetry(r, 0, retry).shouldRetry).toBe(false)
  })
})
