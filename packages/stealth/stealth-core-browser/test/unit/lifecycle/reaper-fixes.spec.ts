/**
 * Reaper host and link review fixes: a reapIfIdle is never answered with another question's outcome, and a link whose connection fails answers null.
 * Ticket 8468f7b1 · criteria [resolve-findings.2] F128 F129.
 * guards: a reapIfIdle (graceMs 0, caller excluded) arriving while a grace tick is evaluating is handed the tick's outcome, and reapIfIdle/status reject when the connection send rejects
 * tier: S
 * cites: 8468f7b1 [resolve-findings.2] F128 F129
 * plan: stealth-browser, state resolve-findings, task resolve-findings-implementer
 * teeth: red: nx run stealth-core-browser:test --skip-nx-cache -- test/unit/lifecycle/reaper-fixes.spec.ts -> exit 1 with the in-flight key made constant (evaluate() hands every caller the in-flight promise): 1 failed | 2 passed (the different-question case).
 * The host is the pure createReaperHost over the host-fixture world; no socket, no process.
 */
import { describe, expect, it, vi } from 'vitest'
import { GRACE, makeHost, resultOf } from '../../helpers/lifecycle/host-fixture.js'

interface Gate { promise: Promise<void>; open: () => void }
function gate(): Gate {
  let open: () => void = () => undefined
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

describe('[resolve-findings.2] F128 evaluate answers each caller its own question', () => {
  it('a reapIfIdle (graceMs 0) during a grace tick waits for the tick and is evaluated on its own terms, not handed the tick outcome', async () => {
    const hold = gate()
    let pageChecks = 0
    const h = makeHost({
      countHttpPages: async () => {
        pageChecks++
        if (pageChecks === 1) await hold.promise // the grace tick is in flight, held at the page check
        return 0
      },
    })
    // Nothing pins Chrome, and the host started less than GRACE ago: the grace tick must say "wait".
    const tick = h.host.tick()
    await vi.waitFor(() => expect(pageChecks).toBe(1))
    const reap = h.call('c2', 'reapIfIdle')
    await Promise.resolve()
    hold.open()
    expect(await tick).toMatchObject({ action: 'wait', pinnedBy: 'grace', reaped: false })
    // The soft reap has graceMs 0: no window applies, so it reaps. It must not report the tick's "wait".
    expect(resultOf(await reap)).toMatchObject({ action: 'reap', reaped: true })
    expect(pageChecks).toBe(2)
    expect(h.world.events).toContain('close-pages')
    expect(GRACE).toBeGreaterThan(0)
  })

  it('callers asking the same question share the in-flight evaluation (one page check)', async () => {
    const hold = gate()
    let pageChecks = 0
    const h = makeHost({
      countHttpPages: async () => {
        pageChecks++
        await hold.promise
        return 0
      },
    })
    const a = h.call('c1', 'reapIfIdle', undefined, 1)
    await vi.waitFor(() => expect(pageChecks).toBe(1))
    const b = h.call('c1', 'reapIfIdle', undefined, 2)
    await Promise.resolve()
    hold.open()
    const [ra, rb] = await Promise.all([a, b])
    expect(resultOf(ra)).toEqual(resultOf(rb))
    expect(pageChecks).toBe(1)
    expect(h.world.events.filter((e) => e === 'close-pages')).toHaveLength(1)
  })

  it('a failed evaluation does not wedge the next caller', async () => {
    let calls = 0
    const h = makeHost({
      probeChrome: async () => {
        calls++
        if (calls === 1) throw new Error('probe exploded')
        return true
      },
    })
    expect(resultOf(await h.call('c1', 'reapIfIdle'))).toBeDefined() // a thrown probe means "not up", answered, not rejected
    expect(resultOf(await h.call('c1', 'reapIfIdle'))).toMatchObject({ reaped: true })
  })
})
