/**
 * Feature-level pins for the three source defects the port fixed.
 * Ticket 8468f7b1 AC port-fixes · criteria [port-fixes.2] [port-fixes.3] [port-fixes.4] [port-fixes.8] [port-fixes.11] ·
 * failsafe rows [fs-160] [fs-169] [fs-178].
 *
 * Each test drives the public class end to end against a throwaway Chrome-shaped SQLite profile in the
 * OS temp dir (no real profile) or against a WebSocket stub (no network, no Chrome).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CookieClient } from '../../../lib/storage/cookies.js'
import { HistoryClient } from '../../../lib/storage/history.js'
import { cdpCall } from '../../../lib/domains/transport.js'
import { chromeMicros, makeProfile, type Fixture } from './profile-fixture.js'

const NOW = 1_800_000_000
const TYPED = 1 | 0x20000000

describe('8468f7b1 AC port-fixes [port-fixes.2] [fs-160] BigInt columns reach callers as plain numbers', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeProfile()
    const d = fx.db('History', [
      'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)',
      'CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, transition INTEGER, from_visit INTEGER, visit_duration INTEGER, opener_visit INTEGER)',
    ])
    d.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,?)').run(1, 'https://a.test/', 'Alpha', 5, 2, chromeMicros(NOW), 0)
    d.prepare('INSERT INTO urls VALUES (?,?,?,?,?,?,?)').run(2, 'https://b.test/', 'Beta', 1, 0, chromeMicros(NOW - 10), 0)
    const v = d.prepare('INSERT INTO visits VALUES (?,?,?,?,?,?,?)')
    v.run(1, 2, chromeMicros(NOW - 10), TYPED, 0, 500_000, 0)
    v.run(2, 1, chromeMicros(NOW), TYPED, 1, 1_500_000, 1)
    d.close()
  })
  afterEach(() => fx.cleanup())

  it('coerces bigint columns to numbers', () => {
    const h = new HistoryClient(fx.root)
    const last = h.getLastVisit()
    expect(last).not.toBeNull()
    expect(last).toMatchObject({ id: 2, urlId: 1, fromVisitId: 1, openerVisitId: 1, transitionRaw: TYPED, visitDurationMs: 1500 })
    expect(last?.visitTime.getTime()).toBe(NOW * 1000)
    const numbers = [last?.id, last?.urlId, last?.fromVisitId, last?.openerVisitId, last?.transitionRaw, last?.visitDurationMs, last?.visitTimeUnix]
    expect(numbers.every((n) => typeof n === 'number')).toBe(true)

    for (const e of h.getRedirectChain(2)) {
      expect(typeof e.visitId).toBe('number')
      expect(typeof e.depth).toBe('number')
    }
    expect(h.getRecentVisits().every((x) => typeof x.id === 'number')).toBe(true)
    expect(typeof h.getUrlInfo(1)?.visitCount).toBe('number')
  })
})

describe('8468f7b1 AC port-fixes [port-fixes.3] [fs-169] session cookies', () => {
  let fx: Fixture
  beforeEach(() => {
    fx = makeProfile()
    const d = fx.db('Cookies', [`CREATE TABLE cookies (name TEXT, value TEXT, host_key TEXT, path TEXT,
      creation_utc INTEGER, last_access_utc INTEGER, has_expires INTEGER, expires_utc INTEGER,
      is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, priority INTEGER)`])
    const ins = d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    ins.run('session', 's', 'a.test', '/', chromeMicros(1000), chromeMicros(3000), 0, 0, 0, 0, 0, 1)
    ins.run('persistent', 'p', 'a.test', '/', chromeMicros(1000), chromeMicros(2000), 1, chromeMicros(9000), 0, 0, 0, 1)
    d.close()
  })
  afterEach(() => fx.cleanup())

  it('session cookies report a null expiry', () => {
    const byName = new Map(new CookieClient(fx.root).getCookies().map((c) => [c.name, c]))
    expect(byName.get('session')?.expiresUtc).toBeNull()
    expect(byName.get('session')?.hasExpires).toBe(false)
    expect(byName.get('persistent')?.expiresUtc?.getTime()).toBe(9_000_000)
  })
})

describe('8468f7b1 AC port-fixes [port-fixes.4] [fs-178] cdpCall waits for the socket to open', () => {
  class OpeningSocket {
    static last: OpeningSocket | null = null
    readyState = 0
    sentWhileConnecting = 0
    sent: string[] = []
    private l = new Map<string, Array<(e: { data: string }) => void>>()
    constructor(public readonly url: string) {
      OpeningSocket.last = this
      setTimeout(() => { this.readyState = 1; this.emit('open', { data: '' }) }, 10)
    }
    addEventListener(t: string, fn: (e: { data: string }) => void) { this.l.set(t, [...(this.l.get(t) ?? []), fn]) }
    removeEventListener(t: string, fn: (e: { data: string }) => void) { this.l.set(t, (this.l.get(t) ?? []).filter((x) => x !== fn)) }
    send(raw: string) {
      if (this.readyState !== 1) { this.sentWhileConnecting++; throw new Error('not open') }
      this.sent.push(raw)
      const { id } = JSON.parse(raw) as { id: number }
      queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id, result: { ok: true } }) }))
    }
    close() { this.readyState = 3 }
    private emit(t: string, e: { data: string }) { (this.l.get(t) ?? []).forEach((f) => f(e)) }
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/browser/x' }) }))
    vi.stubGlobal('WebSocket', OpeningSocket)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('waits for the socket to open before sending', async () => {
    const out = await cdpCall<{ ok: boolean }>('h:1', 'Browser.getVersion')
    expect(out).toEqual({ ok: true })
    expect(OpeningSocket.last?.sentWhileConnecting).toBe(0)
    expect(OpeningSocket.last?.sent).toHaveLength(1)
  })
})
