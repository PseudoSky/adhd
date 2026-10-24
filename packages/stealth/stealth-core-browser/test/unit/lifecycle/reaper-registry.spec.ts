/**
 * CL16 (N3, gap G4) the connection registry of the reaper host.
 * Ticket 8468f7b1 · [chrome-lifecycle.16]
 *
 * Against `createReaperHost` called directly (no socket): `hello` registers a
 * client under its `ctx.connectionId`, `activity` stamps only that client
 * (host clock), a disconnect (`onClientDisconnect`) or `release` removes it,
 * malformed input answers a JSON-RPC error without touching the registry, and
 * after a host restart the next `activity` re-registers the client. The
 * registry lives in memory only: the host has no file dependency at all.
 * guards: hello registers the client under its connectionId with pid and checkHistory, without stamping activity
 * tier: S
 * cites: 8468f7b1 [chrome-lifecycle.16]
 */
import { describe, expect, it } from 'vitest'
import { createReaperHost } from '../../../src/lib/lifecycle/reaper-host.js'
import { makeHost, resultOf } from '../../helpers/lifecycle/host-fixture.js'

describe('8468f7b1 [chrome-lifecycle.16] hello / activity / release / disconnect', () => {
  it('hello registers the client under its connectionId with pid and checkHistory, without stamping activity', async () => {
    const h = makeHost()
    h.host.onClientConnect('c1')
    expect(resultOf(await h.call('c1', 'hello', { pid: 4242, checkHistory: false }))).toEqual({ registered: true })
    expect(h.host.clients()).toEqual([{ id: 'c1', pid: 4242, checkHistory: false, lastActivityAt: null }])
  })

  it('a connection that never said hello is not a client', async () => {
    const h = makeHost()
    h.host.onClientConnect('c1')
    expect(h.host.clients()).toEqual([])
  })

  it('activity updates only that client lastActivityAt, stamped with the host clock', async () => {
    const h = makeHost()
    await h.join('c1', 1)
    await h.join('c2', 2)
    h.world.now = 5_000_000
    expect(await h.notify('c1', 'activity')).toBeUndefined() // a notification has no response
    const byId = Object.fromEntries(h.host.clients().map((c) => [c.id, c.lastActivityAt]))
    expect(byId).toEqual({ c1: 5_000_000, c2: null })
    expect(h.world.activityTouches).toBe(1)
  })

  it('activity sent as a request (with an id) is acknowledged', async () => {
    const h = makeHost()
    await h.join('c1', 1)
    expect(resultOf(await h.call('c1', 'activity'))).toEqual({ ok: true })
  })

  it('release removes the client; the connection may live on', async () => {
    const h = makeHost()
    await h.join('c1', 1)
    await h.join('c2', 2)
    expect(resultOf(await h.call('c1', 'release'))).toEqual({ released: true })
    expect(h.host.clients().map((c) => c.id)).toEqual(['c2'])
  })

  it('onClientDisconnect removes the client for every disconnect reason', async () => {
    const h = makeHost()
    await h.join('c1', 1)
    await h.join('c2', 2)
    await h.join('c3', 3)
    h.host.onClientDisconnect('c1', 'end')
    h.host.onClientDisconnect('c2', 'error')
    h.host.onClientDisconnect('c3', 'closed-by-backend')
    expect(h.host.clients()).toEqual([])
  })

  it('a second hello on the same connection updates the registration and keeps its activity stamp', async () => {
    const h = makeHost()
    await h.join('c1', 1, true)
    await h.notify('c1', 'activity')
    const stamped = h.host.clients()[0].lastActivityAt
    await h.call('c1', 'hello', { pid: 1, checkHistory: false })
    expect(h.host.clients()).toEqual([{ id: 'c1', pid: 1, checkHistory: false, lastActivityAt: stamped }])
  })
})

describe('8468f7b1 [chrome-lifecycle.16] malformed input never changes the registry', () => {
  it('an unknown method answers -32601 and changes nothing', async () => {
    const h = makeHost()
    await h.join('c1', 1)
    const before = h.host.clients()
    const r = await h.call('c1', 'nope')
    expect(r?.error?.code).toBe(-32601)
    expect(h.host.clients()).toEqual(before)
  })

  it.each([
    ['a string', 'x'],
    ['an array', [1]],
    ['a negative pid', { pid: -1 }],
    ['a fractional pid', { pid: 1.5 }],
    ['a string pid', { pid: '7' }],
    ['a non-boolean checkHistory', { pid: 7, checkHistory: 'yes' }],
    ['no params', undefined],
  ])('hello with %s answers -32602 and registers nothing', async (_label, params) => {
    const h = makeHost()
    h.host.onClientConnect('c9')
    const r = await h.call('c9', 'hello', params)
    expect(r?.error?.code).toBe(-32602)
    expect(h.host.clients()).toEqual([])
  })

  it('an unknown notification is ignored silently (no response, no change)', async () => {
    const h = makeHost()
    await h.join('c1', 1)
    const before = h.host.clients()
    expect(await h.notify('c1', 'bogus', { x: 1 })).toBeUndefined()
    expect(h.host.clients()).toEqual(before)
  })

  it('a non-object request answers an invalid-request error', async () => {
    const h = makeHost()
    const r = await h.host.handler(null as never, { connectionId: 'c1' })
    expect(r?.error?.code).toBe(-32600)
    expect(h.host.clients()).toEqual([])
  })
})

describe('8468f7b1 [chrome-lifecycle.16] host restart', () => {
  it('after a host restart the next activity re-registers the client', async () => {
    const first = makeHost()
    await first.join('c1', 1)
    // The reaper host process is gone; a fresh host starts with an empty in-memory registry.
    const restarted = createReaperHost(first.deps)
    expect(restarted.clients()).toEqual([])
    await restarted.handler({ jsonrpc: '2.0', method: 'activity' }, { connectionId: 'c7' })
    expect(restarted.clients()).toEqual([{ id: 'c7', pid: null, checkHistory: true, lastActivityAt: first.world.now }])
  })

  it('the host depends on no file: its deps carry no path, dir or fs', () => {
    const h = makeHost()
    const keys = Object.keys(h.deps)
    expect(keys.filter((k) => /path|dir|fs|file/i.test(k))).toEqual([])
  })
})
