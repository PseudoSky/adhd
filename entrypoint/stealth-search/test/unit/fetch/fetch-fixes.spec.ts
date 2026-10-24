/**
 * guards: a 403/500 from the direct PDF download is reported as a PDF parse failure, an error-status page hides that its markdown was cut, an IPv6-literal PDF host is dialled with a bracketed TLS server name, the fetch endpoint constant shares a name with the host flag
 * tier: S
 * cites: 8468f7b1 [resolve-findings.4] (F47 F118 F119 F120)
 * plan: resolve-findings
 * teeth: red: nx run stealth-search:test --skip-nx-cache -- test/unit/fetch/fetch-fixes.spec.ts -> exit 1 (3 failed) with the direct-fetch status check removed, the truncated flag dropped from the error-status branch and the bracket strip removed from pinnedGet.
 * Real use: an agent fetches a PDF behind a login (403 on the direct download); a huge error page; a PDF served from an IPv6 literal.
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('node:https', () => ({ default: { request: hoisted.request }, request: hoisted.request }))

import * as fetchModule from '../../../src/lib/fetch/fetch.js'
import { fetchPage } from '../../../src/lib/fetch/fetch.js'
import type { FetchDeps } from '../../../src/lib/fetch/fetch.js'
import { TURNDOWN_INPUT_CAP } from '../../../src/lib/fetch/markdown.js'
import { pinnedGet } from '../../../src/lib/fetch/pinned.js'
import { PROVIDER, makeWorld, page } from '../../helpers/fetch/harness.js'

const pdfUrl = 'https://files.example.org/paper.pdf'

describe('8468f7b1 [resolve-findings.4] fetch fixes', () => {
  it('F118: a 403 from the direct PDF download is an HTTP error, not PDF_EXTRACT_FAILED', async () => {
    const fetchDirect: FetchDeps['fetchDirect'] = async () => ({ status: 403, location: null, body: new TextEncoder().encode('<html>Forbidden</html>') })
    const w = makeWorld({ html: ['<html></html>'], responses: [{ url: pdfUrl, status: 200, mimeType: 'application/pdf' }] }, { fetchDirect })
    const r = await fetchPage(PROVIDER, pdfUrl, {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.error).toMatch(/HTTP 403/)
    expect(r.error).not.toMatch(/PDF_EXTRACT_FAILED/)
  })

  it('F120: an error-status page whose markdown was cut reports truncated', async () => {
    const huge = page('Boom', `<h1>Boom</h1><p>${'x '.repeat(TURNDOWN_INPUT_CAP)}</p>`)
    const w = makeWorld({ html: [huge], responses: [{ url: 'https://example.com/a', status: 500, mimeType: 'text/html' }] })
    const r = await fetchPage(PROVIDER, 'https://example.com/a', {}, w.deps)
    expect(r.outcome).toBe('error')
    expect(r.truncated).toBe(true)
  })

  it('F47: an IPv6-literal host is dialled by its bare address and sets no TLS server name', async () => {
    class Req extends EventEmitter {
      destroy = vi.fn()
      end = vi.fn()
    }
    class Res extends EventEmitter {
      statusCode = 200
      headers = {}
      destroy = vi.fn()
    }
    let options: Record<string, unknown> = {}
    const res = new Res()
    hoisted.request.mockImplementation((o: Record<string, unknown>, cb: (r: Res) => void) => {
      options = o
      queueMicrotask(() => cb(res))
      return new Req()
    })
    const done = pinnedGet('https://[2001:db8::1]/a.pdf', '2001:db8::1', { headers: {}, maxBytes: 10, timeoutMs: 1000 })
    await Promise.resolve()
    res.emit('end')
    await done
    expect(options['hostname']).toBe('2001:db8::1')
    expect('servername' in options).toBe(false)
  })

  it('F119: the fetch endpoint constant is not named like the host flag default', () => {
    expect(fetchModule.DEFAULT_FETCH_CDP_ENDPOINT).toBe('127.0.0.1:9222')
    expect('DEFAULT_CDP_HOST' in fetchModule).toBe(false)
  })
})
