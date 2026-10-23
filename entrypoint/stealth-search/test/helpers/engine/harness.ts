/**
 * Test harness of the engine unit lane: an HTML-to-CDP-DOM converter, a fake page session that answers the
 * CDP DOM and Page commands the engine sends, a virtual clock and fake collaborators (capture, fetch,
 * sessions). No process, socket or network. HTML fixtures labelled `synthetic-protocol-conformant` are
 * hand-made; the github pages are byte-copies of the captured pages under test/fixtures/providers/github/.
 * Ticket 8468f7b1 · [search-port-engine.2] [search-port-engine.3] [search-port-engine.4]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { capture } from '@adhd/stealth-core-browser'
import type { CapturedBody, EngineDeps } from '../../../src/lib/network.js'
import type { DomNode, DomSession } from '../../../src/lib/dom.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** A fixture of this lane (test/fixtures/engine/). */
export const fixture = (name: string): string => fs.readFileSync(path.join(here, '..', '..', 'fixtures', 'engine', name), 'utf8')
/** A captured github page (test/fixtures/providers/github/), read in place. */
export const githubFixture = (name: string): string => fs.readFileSync(path.join(here, '..', '..', 'fixtures', 'providers', 'github', name), 'utf8')

// ─── HTML to CDP DOM ─────────────────────────────────────────────────────────

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TEXT = new Set(['script', 'style'])

const decode = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

function parseAttributes(src: string): string[] {
  const out: string[] = []
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  for (const m of src.matchAll(re)) out.push(m[1] ?? '', decode(m[2] ?? m[3] ?? m[4] ?? ''))
  return out
}

/**
 * Parse HTML into the node shape `DOM.getDocument({depth: -1})` returns: a document node (id 1) holding
 * elements (uppercase names, flat attribute array) and text nodes. Like Chrome's DOM domain it drops
 * whitespace-only text nodes and comments.
 */
export function htmlToDomTree(html: string): DomNode {
  let nextId = 2
  const root: DomNode = { nodeId: 1, nodeType: 9, nodeName: '#document', children: [] }
  const stack: DomNode[] = [root]
  const top = (): DomNode => stack[stack.length - 1] as DomNode
  const append = (node: DomNode): void => {
    const parent = top()
    ;(parent.children ??= []).push(node)
  }
  const tokens = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/gi
  let m: RegExpExecArray | null
  while ((m = tokens.exec(html)) !== null) {
    const [whole, closeTag, openTag, attrSrc, selfClose, text] = m
    if (whole.startsWith('<!')) continue
    if (closeTag) {
      const name = closeTag.toUpperCase()
      for (let i = stack.length - 1; i > 0; i--) {
        if ((stack[i] as DomNode).nodeName === name) {
          stack.length = i
          break
        }
      }
    } else if (openTag) {
      const lower = openTag.toLowerCase()
      const el: DomNode = { nodeId: nextId++, nodeType: 1, nodeName: openTag.toUpperCase(), attributes: parseAttributes(attrSrc ?? ''), children: [] }
      append(el)
      if (RAW_TEXT.has(lower)) {
        const end = html.toLowerCase().indexOf(`</${lower}`, tokens.lastIndex)
        const raw = html.slice(tokens.lastIndex, end === -1 ? html.length : end)
        if (raw.trim()) el.children?.push({ nodeId: nextId++, nodeType: 3, nodeName: '#text', nodeValue: raw })
        const close = end === -1 ? html.length : html.indexOf('>', end) + 1
        tokens.lastIndex = close
      } else if (!VOID.has(lower) && !selfClose) {
        stack.push(el)
      }
    } else if (text !== undefined && text.trim()) {
      append({ nodeId: nextId++, nodeType: 3, nodeName: '#text', nodeValue: decode(text) })
    }
  }
  return root
}

// ─── A tiny selector engine (compound selectors) ─────────────────────────────

const attrOf = (node: DomNode, name: string): string | undefined => {
  const a = node.attributes ?? []
  for (let i = 0; i < a.length; i += 2) if (a[i] === name) return a[i + 1]
  return undefined
}

/** Match one compound selector: tag, #id, .class, [attr], [attr="v"], [attr*="v"] in any combination. */
export function matchesSelector(node: DomNode, selector: string): boolean {
  if (node.nodeType !== 1) return false
  const tag = /^[a-zA-Z][\w-]*/.exec(selector)?.[0]
  if (tag && node.nodeName !== tag.toUpperCase()) return false
  for (const m of selector.matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:(\*?=)"([^"]*)")?\]/g)) {
    const [, id, cls, attr, op, val] = m
    if (id !== undefined && attrOf(node, 'id') !== id) return false
    if (cls !== undefined && !(attrOf(node, 'class') ?? '').split(/\s+/).includes(cls)) return false
    if (attr !== undefined) {
      const v = attrOf(node, attr)
      if (v === undefined) return false
      if (op === '=' && v !== val) return false
      if (op === '*=' && !v.includes(val ?? '')) return false
    }
  }
  return true
}

function find(node: DomNode, selector: string): DomNode | undefined {
  for (const child of node.children ?? []) {
    if (matchesSelector(child, selector)) return child
    const deeper = find(child, selector)
    if (deeper) return deeper
  }
  return undefined
}

// ─── The fake page session ───────────────────────────────────────────────────

export interface FakePageOptions {
  /** The document the page renders. */
  html: string
  /** The URL after redirects (Page.getNavigationHistory). Default: the navigate URL. */
  url?: string
  /** `DOM.querySelector` calls for a selector that answer "not found" before it appears (selector -> misses). */
  appearsAfter?: Record<string, number>
  /** A selector that never appears at all. */
  never?: string[]
  /** CDP commands that reject, with the message (method -> message). */
  reject?: Record<string, string>
}

/** A page session over an HTML document that answers the CDP commands the engine sends and records them. */
export class FakePage {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = []
  readonly tree: DomNode
  private navigatedTo = ''
  private readonly misses = new Map<string, number>()
  closed = 0

  constructor(private readonly options: FakePageOptions) {
    this.tree = htmlToDomTree(options.html)
  }

  /** The commands sent, by method name. */
  methods(): string[] {
    return this.calls.map((c) => c.method)
  }

  /** How many `DOM.querySelector` calls asked for `selector`. */
  queries(selector: string): number {
    return this.calls.filter((c) => c.method === 'DOM.querySelector' && c.params['selector'] === selector).length
  }

  close(): void {
    this.closed++
  }

  readonly send: DomSession['send'] = async <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
    this.calls.push({ method, params })
    const rejection = this.options.reject?.[method]
    if (rejection !== undefined) throw new Error(rejection)
    switch (method) {
      case 'Page.navigate':
        this.navigatedTo = String(params['url'] ?? '')
        return {} as T
      case 'Page.getNavigationHistory':
        return { currentIndex: 0, entries: [{ url: this.options.url ?? this.navigatedTo }] } as T
      case 'DOM.getDocument':
        return { root: params['depth'] === -1 ? this.tree : { nodeId: this.tree.nodeId, nodeType: 9, nodeName: '#document' } } as T
      case 'DOM.getOuterHTML':
        return { outerHTML: this.options.html } as T
      case 'DOM.querySelector': {
        const selector = String(params['selector'])
        if (this.options.never?.includes(selector)) return { nodeId: 0 } as T
        const wait = this.options.appearsAfter?.[selector]
        if (wait !== undefined) {
          const seen = this.misses.get(selector) ?? 0
          if (seen < wait) {
            this.misses.set(selector, seen + 1)
            return { nodeId: 0 } as T
          }
        }
        return { nodeId: find(this.tree, selector)?.nodeId ?? 0 } as T
      }
      default:
        return {} as T
    }
  }
}

// ─── Virtual clock ───────────────────────────────────────────────────────────

export interface VirtualClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
  random: () => number
  /** Every requested sleep, in ms. */
  sleeps: number[]
  set: (t: number) => void
}

/** A clock whose `sleep` advances time instantly. `randoms` are consumed in order, then 0.5 repeats. */
export function makeClock(randoms: number[] = []): VirtualClock {
  let t = 1_700_000_000_000
  const queue = [...randoms]
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
    random: () => queue.shift() ?? 0.5,
    sleeps,
    set: (v) => {
      t = v
    },
  }
}

// ─── Fake capture ────────────────────────────────────────────────────────────

type Candidate = Parameters<NonNullable<capture.CaptureOptions['select']>>[0][number]

/** A recorded exchange as the core's recorder hands it to `select` (only the fields the engine reads are meaningful). */
export function exchange(init: { url: string; body: string; status?: number; headers?: Record<string, string> }): Candidate {
  const response: NonNullable<Candidate['response']> = { status: init.status ?? 0, headers: init.headers ?? {}, body: init.body, bodyEncoding: 'utf8' }
  return {
    requestId: `r-${init.url}`,
    url: init.url,
    request: { method: 'GET', url: init.url, headers: {}, startedAt: 0 },
    response,
    redirects: [],
    wire: { requestExtraInfo: false, responseExtraInfo: false },
    state: 'finished',
  }
}

export interface CaptureCall {
  pageWsUrl: string
  options: capture.CaptureOptions
}

/** A CaptureError-shaped rejection: a typed error with a stable `code`, as the core's capture throws. */
export function captureFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

export type CaptureScript = (call: CaptureCall, n: number) => Promise<CapturedBody>

/** Records every capture call and answers with the script (the nth call gets n = 0, 1, ...). */
export function recordingCapture(script: CaptureScript): { capture: EngineDeps['capture']; calls: CaptureCall[] } {
  const calls: CaptureCall[] = []
  return {
    calls,
    capture: async (pageWsUrl, options) => {
      const call = { pageWsUrl, options }
      calls.push(call)
      return script(call, calls.length - 1)
    },
  }
}

/**
 * A capture over a set of exchanges that behaves like the core: it applies the caller's `select` to the
 * landed candidates, so the engine's own selection logic is what decides which response is read. Each
 * exchange lands `at` ms after the start; when `options.timeoutMs` elapses first and nothing landed, it
 * rejects with CAPTURE_TIMEOUT; whatever landed by then is chosen (the core's graceful-timeout rule).
 */
export function exchangesCapture(landings: Array<{ at: number; exchange: Candidate }>): CaptureScript {
  return async ({ options }) => {
    const within = landings.filter((l) => l.at <= (options.timeoutMs ?? 10_000))
    const last = within.reduce((t, l) => Math.max(t, l.at), 0)
    if (within.length === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, options.timeoutMs ?? 10_000))
      throw captureFailure('CAPTURE_TIMEOUT', `nothing captured within ${options.timeoutMs ?? 10_000}ms`)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, last))
    const chosen = (options.select ?? ((c) => c[0]))(within.map((l) => l.exchange))
    if (!chosen) throw captureFailure('CAPTURE_NO_MATCH', 'the selector chose none of the captured responses')
    return {
      url: chosen.url,
      status: chosen.response?.status ?? 0,
      body: chosen.response?.body ?? '',
      headers: chosen.response?.headers ?? {},
    }
  }
}

/** A captured body for a capture script. */
export const body = (b: string, init: { status?: number; url?: string; headers?: Record<string, string> } = {}): CapturedBody => ({
  url: init.url ?? '',
  status: init.status ?? 200,
  body: b,
  headers: init.headers ?? {},
})

/** Engine dependencies over fakes: nothing real is reachable unless a test supplies it. */
export function makeDeps(parts: Partial<EngineDeps> & { clock?: VirtualClock } = {}): EngineDeps {
  const clock = parts.clock ?? makeClock()
  const { clock: _clock, ...rest } = parts
  void _clock
  return {
    now: clock.now,
    sleep: clock.sleep,
    random: clock.random,
    capture: async () => {
      throw captureFailure('CAPTURE_TIMEOUT', 'no capture script')
    },
    fetchImpl: async () => {
      throw new TypeError('no fetch script')
    },
    checkBans: (rules, ctx) => capture.checkBans([...rules], ctx),
    connect: async () => {
      throw new TypeError('no session script')
    },
    log: () => undefined,
    ...rest,
  }
}
