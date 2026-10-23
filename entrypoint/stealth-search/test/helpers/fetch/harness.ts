/**
 * Test harness for the fetch unit lane: a scripted CDP page session, a virtual clock and fake
 * collaborators. No process, socket or network. Fixtures are labelled synthetic-protocol-conformant.
 * Ticket 8468f7b1 · [search-port-fetch.2]
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FetchDeps, FetchPage, FetchSession, FetchSettle } from '../../../src/lib/fetch/fetch.js'
import { htmlToMarkdown } from '../../../src/lib/fetch/markdown.js'
import { extractPdfText } from '../../../src/lib/fetch/pdf.js'

export const FIXTURES = path.join(__dirname, '..', '..', 'fixtures', 'fetch')
export const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name))
export const PDF_SENTENCE = 'the stealth runner survived the audit'

export interface PageScript {
  /** Document responses emitted during settle, in order (the last wins). */
  responses?: Array<{ url: string; status: number; mimeType: string }>
  /** outerHTML per grab; the last entry repeats. */
  html?: string[]
  /** PDF bytes served through Fetch.getResponseBody when the page navigates. */
  pdf?: Uint8Array
  settled?: boolean
}

export interface World {
  deps: Partial<FetchDeps>
  calls: string[]
  logs: string[]
  opened: number
  revealed: number
  disposed: number
  closed: number
  grabs: number
  clock: { t: number }
}

export function makeWorld(script: PageScript, extra: Partial<FetchDeps> = {}): World {
  const clock = { t: 0 }
  const handlers = new Map<string, Array<(p: Record<string, unknown>) => void>>()
  const w: World = { deps: {}, calls: [], logs: [], opened: 0, revealed: 0, disposed: 0, closed: 0, grabs: 0, clock }
  const emit = (m: string, p: Record<string, unknown>): void => (handlers.get(m) ?? []).forEach((h) => h(p))
  const session: FetchSession = {
    connect: async () => undefined,
    on: (m, h) => {
      handlers.set(m, [...(handlers.get(m) ?? []), h])
      return () => handlers.set(m, (handlers.get(m) ?? []).filter((x) => x !== h))
    },
    close: () => {
      w.closed++
    },
    send: (async (method: string, params?: Record<string, unknown>) => {
      w.calls.push(method)
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
      if (method === 'DOM.getOuterHTML') {
        const list = script.html ?? ['<html></html>']
        return { outerHTML: list[Math.min(w.grabs++, list.length - 1)] }
      }
      if (method === 'Page.navigate' && script.pdf) {
        emit('Fetch.requestPaused', {
          requestId: 'r1',
          responseStatusCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }],
          request: { url: String(params?.['url']) },
        })
      }
      if (method === 'Fetch.getResponseBody') return { body: Buffer.from(script.pdf ?? []).toString('base64'), base64Encoded: true }
      return {}
    }) as FetchSession['send'],
  }
  const page: FetchPage = {
    pageWsUrl: 'ws://fake/page',
    reveal: async () => {
      w.revealed++
    },
    dispose: async () => {
      w.disposed++
    },
  }
  w.deps = {
    openPage: async () => {
      w.opened++
      return page
    },
    newSession: () => session,
    settle: async (_s, opts): Promise<FetchSettle> => {
      for (const r of script.responses ?? [{ url: opts.navigate, status: 200, mimeType: 'text/html' }]) {
        emit('Network.responseReceived', { type: 'Document', requestId: 'req1', response: r })
      }
      return { signal: script.settled === false ? 'deadline' : 'networkIdle', settled: script.settled !== false, tookMs: 50 }
    },
    checkBans: (rules, ctx) => {
      for (const r of rules) if (r.checkBody?.test(ctx.body)) return r.signal
      return null
    },
    toMarkdown: (html) => htmlToMarkdown(html),
    extractPdf: (bytes) => extractPdfText(bytes),
    resolveHost: async () => ['93.184.216.34'],
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms
    },
    log: (m) => {
      w.logs.push(m)
    },
    ...extra,
  }
  return w
}

export const CF_BAN = [{ name: 'cf', signal: 'captcha' as const, checkBody: /Just a moment/ }]
export const PROVIDER = { id: 'fetch', bans: CF_BAN }

export const page = (title: string, body: string): string => `<html><head><title>${title}</title></head><body>${body}</body></html>`
export const longBody = (n = 4000): string => `<p>${'A real, substantial paragraph of documentation text. '.repeat(Math.ceil(n / 50))}</p>`
