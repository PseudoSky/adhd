/**
 * guards: a closed or erroring CDP socket hangs the search or escapes as an unhandled rejection instead of one fallback then outcome error
 * tier: S
 * cites: ticket 8468f7b1 [search-port-engine.9] [search-port-engine.14]
 * A network-capture failure never hangs or escapes as an unhandled rejection (backlog 224e7a44): when the CDP socket
 * closes or errors during capture the engine falls back once to the provider's next strategy when it declares one
 * (the dom strategy for a provider with a dom config) and returns its results; when the fallback also fails it
 * returns outcome error whose message names the cause.
 * Ticket 8468f7b1 · [search-port-engine.9] [search-port-engine.14] · backlog 224e7a44.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getProvider } from '../../../src/lib/providers.js'
import { networkSearch, runStrategies } from '../../../src/lib/network.js'
import { captureFailure, fixture, FakePage, makeDeps, recordingCapture } from '../../helpers/engine/harness.js'

const page = { pageWsUrl: 'ws://page', reveal: async () => undefined }
const SOCKET_CLOSED = 'the CDP socket closed before any matching response was captured'
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('224e7a44: socket closed during capture [search-port-engine.9]', () => {
  const rejections: unknown[] = []
  const listener = (reason: unknown): void => {
    rejections.push(reason)
  }
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', listener)
  })
  afterEach(() => {
    process.off('unhandledRejection', listener)
  })

  it('socket closed falls back to the dom strategy: duckduckgo returns the dom results and no unhandledRejection fires', async () => {
    const rec = recordingCapture(async () => {
      throw captureFailure('CAPTURE_SESSION_CLOSED', SOCKET_CLOSED)
    })
    const dom = new FakePage({ html: fixture('ddg-results.html') })
    const r = await runStrategies(page, getProvider('duckduckgo'), 'tree-sitter', {}, makeDeps({ capture: rec.capture, connect: async () => dom }))
    await flush()
    await flush()
    expect(rec.calls).toHaveLength(1)
    expect(r.outcome).toBe('success')
    expect(r.strategy).toBe('dom')
    expect(r.count).toBe(3)
    expect(dom.closed).toBe(1)
    expect(rejections).toEqual([])
  })

  it('socket closed and the dom fallback also fails: outcome error whose message names the cause, no unhandledRejection', async () => {
    const rec = recordingCapture(async () => {
      throw captureFailure('CAPTURE_SESSION_CLOSED', SOCKET_CLOSED)
    })
    const dom = new FakePage({ html: '<html></html>', reject: { 'Page.navigate': 'Target closed' } })
    const r = await runStrategies(page, getProvider('duckduckgo'), 'tree-sitter', {}, makeDeps({ capture: rec.capture, connect: async () => dom }))
    await flush()
    expect(r.outcome).toBe('error')
    expect(r.strategy).toBe('dom')
    expect(r.error).toBe('Target closed')
    expect(rejections).toEqual([])
  })

  it('socket closed on a provider with no dom config (github): the fallback network call fails too and the error names the cause', async () => {
    const rec = recordingCapture(async () => {
      throw captureFailure('CAPTURE_SESSION_CLOSED', SOCKET_CLOSED)
    })
    const r = await runStrategies(page, getProvider('github'), 'vite', {}, makeDeps({ capture: rec.capture, fetchImpl: async () => new Response('', { status: 502 }) }))
    await flush()
    expect(r.outcome).toBe('error')
    expect(r.error).toBe(SOCKET_CLOSED)
    expect(rejections).toEqual([])
  })

  it('a socket closed when the page itself cannot open a dom session is an error outcome, not a throw', async () => {
    const rec = recordingCapture(async () => {
      throw captureFailure('CAPTURE_SESSION_CLOSED', SOCKET_CLOSED)
    })
    const r = await runStrategies(
      page,
      getProvider('duckduckgo'),
      'x',
      {},
      makeDeps({
        capture: rec.capture,
        connect: async () => {
          throw captureFailure('CAPTURE_CONNECT_FAILED', 'cannot connect to ws://page: WebSocket error')
        },
      }),
    )
    await flush()
    expect(r.outcome).toBe('error')
    expect(r.error).toContain('WebSocket error')
    expect(rejections).toEqual([])
  })

  it('an unexpected exception inside the capture (not a typed capture error) becomes outcome error, falls back to dom and fires no unhandledRejection', async () => {
    const rec = recordingCapture(async () => {
      throw new TypeError('Cannot read properties of undefined')
    })
    const direct = await networkSearch('ws://page', getProvider('duckduckgo'), 'x', {}, makeDeps({ capture: rec.capture }))
    expect(direct.outcome).toBe('error')
    expect(direct.error).toBe('Cannot read properties of undefined')
    const dom = new FakePage({ html: fixture('ddg-results.html') })
    const r = await runStrategies(page, getProvider('duckduckgo'), 'x', {}, makeDeps({ capture: rec.capture, connect: async () => dom }))
    await flush()
    expect(r.outcome).toBe('success')
    expect(r.strategy).toBe('dom')
    expect(rejections).toEqual([])
  })
})
