/**
 * Out-of-process reaper failsafes, proven through the reaper host (the
 * replacement of the detached `node -e` killer script and the pid registry
 * file of the source runner). The FEATURE of each row is unchanged.
 * Ticket 8468f7b1 · [chrome-lifecycle.12] [chrome-lifecycle.16] [chrome-lifecycle.18] ·
 * inventory [fs-207] [fs-208] [fs-209]
 */
import { describe, expect, it } from 'vitest'
import { createReaperHost } from '../../../lib/lifecycle/reaper-host.js'
import { GRACE, IDLE, makeHost, PORT, resultOf } from './host-fixture.js'

describe('8468f7b1 [chrome-lifecycle.12] the reaper closes Chrome', () => {
  it('the reaper signals the port occupant', async () => {
    // [fs-207] no owner record + scope port-occupant: the host reap kills the TCP listener of the CDP port.
    const h = makeHost()
    h.advance(IDLE + GRACE)
    const out = await h.host.tick()
    expect(out).toMatchObject({ action: 'reap', reaped: true })
    expect(h.world.events).toContain(`kill-port:${PORT}`)
  })
})

describe('8468f7b1 [chrome-lifecycle.18] sibling diagnostic', () => {
  it('warns about many sibling instances without killing', async () => {
    // [fs-208] at the threshold (default 4 connected clients) status says so; nothing is ever signalled for it.
    const h = makeHost()
    for (const [i, id] of ['a', 'b', 'c'].entries()) await h.join(id, 100 + i)
    expect(resultOf<{ siblingWarning: boolean; clients: number }>(await h.call('a', 'status'))).toMatchObject({ clients: 3, siblingWarning: false })
    await h.join('d', 104)
    const s = resultOf<{ siblingWarning: boolean; clients: number; siblingThreshold: number }>(await h.call('a', 'status'))
    expect(s).toMatchObject({ clients: 4, siblingWarning: true, siblingThreshold: 4 })
    expect(h.world.events).toEqual([])
  })
})

describe('8468f7b1 [chrome-lifecycle.16] live instance registry', () => {
  it('maintains the live instance registry', async () => {
    // [fs-209] hello adds the live process, disconnect and release drop it, and after a host
    // restart the next activity re-registers it. In memory only.
    const h = makeHost()
    await h.join('c1', 1)
    await h.join('c2', 2)
    await h.join('c3', 3)
    h.host.onClientDisconnect('c1', 'end') // the process died
    await h.call('c2', 'release') // the process left on exit
    expect(h.host.clients().map((c) => c.id)).toEqual(['c3'])
    const restarted = createReaperHost(h.deps)
    await restarted.handler({ jsonrpc: '2.0', method: 'activity' }, { connectionId: 'c3' })
    expect(restarted.clients().map((c) => c.id)).toEqual(['c3'])
  })
})
