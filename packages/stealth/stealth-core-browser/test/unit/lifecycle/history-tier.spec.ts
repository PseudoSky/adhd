/**
 * CL8 (F13) the history-recency tier, evaluated in the reaper host.
 * Ticket 8468f7b1 · [chrome-lifecycle.8]
 *
 * A visit within 2 minutes pins Chrome; `checkHistory: false` ignores history;
 * a history database error proceeds; the default is on; and the tier is on
 * when ANY connected client enables it (the `hello` message carries the flag).
 * guards: a visit within 2 minutes keeps Chrome (checkHistory default on)
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.8]
 */
import { describe, expect, it, vi } from 'vitest'
import { decideReap, historyTierEnabled, type ReapInput } from '../../../src/lib/lifecycle/reap-policy.js'
import { makeHost, resultOf } from '../../helpers/lifecycle/host-fixture.js'

const base: ReapInput = {
  now: 10_000_000,
  clients: [],
  idleTimeoutMs: 120_000,
  graceMs: 0,
  chromeUp: true,
  httpPageCount: 0,
  historyRecent: false,
  checkHistoryDefault: true,
  scope: 'port-occupant',
  ownerValid: false,
  lastPinAt: null,
}

describe('8468f7b1 [chrome-lifecycle.8] history tier through the host', () => {
  it('a visit within 2 minutes keeps Chrome (checkHistory default on)', async () => {
    const h = makeHost({}, { history: true })
    await h.join('A', 1) // hello without checkHistory: the default (true) applies
    expect(h.host.clients()[0].checkHistory).toBe(true)
    expect(resultOf(await h.call('A', 'reapIfIdle'))).toEqual({ action: 'keep', pinnedBy: 'history', reaped: false })
  })

  it('checkHistory: false ignores history (the database is not even read)', async () => {
    const h = makeHost({}, { history: true })
    await h.join('A', 1, false)
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')
    expect(h.world.historyReads).toBe(0)
  })

  it('a history database error proceeds', async () => {
    const h = makeHost({}, { history: new Error('database is locked') })
    await h.join('A', 1, true)
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')
    expect(h.world.historyReads).toBe(1)
  })

  it('the tier is on when ANY connected client enables it', async () => {
    const h = makeHost({}, { history: true })
    await h.join('A', 1, false)
    await h.join('B', 2, true)
    expect(resultOf(await h.call('A', 'reapIfIdle'))).toEqual({ action: 'keep', pinnedBy: 'history', reaped: false })
  })

  it('the tier is off when every connected client disables it', async () => {
    const h = makeHost({}, { history: true })
    await h.join('A', 1, false)
    await h.join('B', 2, false)
    expect(resultOf<{ action: string }>(await h.call('A', 'reapIfIdle')).action).toBe('reap')
  })

  it('with no client connected the reaper default (on) applies to the tick', async () => {
    const h = makeHost({ shutdownGraceMs: 0 }, { history: true })
    expect(await h.host.tick()).toEqual({ action: 'keep', pinnedBy: 'history', reaped: false })
  })

  it('a reaper configured with checkHistoryDefault false skips history when nobody is connected', async () => {
    const h = makeHost({ shutdownGraceMs: 0, checkHistoryDefault: false }, { history: true })
    expect((await h.host.tick()).action).toBe('reap')
  })
})

describe('8468f7b1 [chrome-lifecycle.8] history tier in decideReap', () => {
  it('historyTierEnabled: any client on, else the default', () => {
    const c = (checkHistory: boolean) => ({ id: String(checkHistory), pid: 1, checkHistory, lastActivityAt: null })
    expect(historyTierEnabled([], true)).toBe(true)
    expect(historyTierEnabled([], false)).toBe(false)
    expect(historyTierEnabled([c(false)], true)).toBe(false)
    expect(historyTierEnabled([c(false), c(true)], false)).toBe(true)
  })

  it("'unavailable' proceeds and true keeps", () => {
    expect(decideReap({ ...base, historyRecent: 'unavailable' }).action).toBe('reap')
    expect(decideReap({ ...base, historyRecent: true })).toEqual({ action: 'keep', pinnedBy: 'history' })
  })

  it('the default history probe is HistoryClient.isRecentlyUsed(2): a visit 119 s ago is recent, 121 s ago is not', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
      const { HistoryClient } = await import('../../../src/lib/storage/history.js')
      const recent = (agoMs: number) => {
        const hc = Object.create(HistoryClient.prototype) as InstanceType<typeof HistoryClient>
        hc.getLastVisit = () => ({ visitTime: new Date(Date.now() - agoMs) }) as ReturnType<typeof hc.getLastVisit>
        return hc.isRecentlyUsed(2)
      }
      expect(recent(119_000)).toBe(true)
      expect(recent(121_000)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
