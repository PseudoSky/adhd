/**
 * guards: more than maxConcurrent searches run at once, the queue is not FIFO, or a slot is never handed over
 * tier: S
 * cites: ticket 8468f7b1 [search-port-guards.2]
 * Per-process concurrency cap (inventory row [I-20]): maxConcurrent default 2, a FIFO queue,
 * <= 0 disables, slots are handed over so the cap is never overshot.
 * Ticket 8468f7b1 · [search-port-guards.2]
 */
import { describe, expect, it } from 'vitest'
import { makeEnv } from '../../helpers/guards/guards-harness.js'

function gate() {
  let open: () => void = () => undefined
  const p = new Promise<void>((r) => { open = r })
  return { p, open: () => open() }
}

const tick = () => new Promise<void>((r) => setImmediate(r))

describe('search concurrency cap [search-port-guards.2] [I-20]', () => {
  it('FIFO queue honours the limit', async () => {
    const env = makeEnv()
    expect(env.guard.searchConcurrencyInfo()).toEqual({ active: 0, queued: 0, max: 2 })
    const log: string[] = []
    const [ga, gb, gc, gd] = [gate(), gate(), gate(), gate()] as const
    const gates = [ga, gb, gc, gd]
    const run = (i: number, id: string) => env.guard.withSearchConcurrency(async () => {
      log.push(`start ${id}`)
      await gates[i]?.p
      log.push(`end ${id}`)
      return id
    })
    const results = [run(0, 'a'), run(1, 'b'), run(2, 'c'), run(3, 'd')]
    await tick()
    // three/four concurrent callers: only two run, the others wait
    expect(log).toEqual(['start a', 'start b'])
    expect(env.guard.searchConcurrencyInfo()).toEqual({ active: 2, queued: 2, max: 2 })
    gb.open()
    await tick()
    // FIFO release order: c (queued first) starts before d
    expect(log).toEqual(['start a', 'start b', 'end b', 'start c'])
    ga.open()
    await tick()
    expect(log.slice(-2)).toEqual(['end a', 'start d'])
    gc.open()
    gd.open()
    expect(await Promise.all(results)).toEqual(['a', 'b', 'c', 'd'])
    expect(env.guard.searchConcurrencyInfo()).toEqual({ active: 0, queued: 0, max: 2 })
  })

  it('never overshoots maxConcurrent when a newcomer arrives as a slot is released', async () => {
    const env = makeEnv({ maxConcurrent: 1 })
    let inFlight = 0
    let peak = 0
    const g = gate()
    const body = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await g.p
      inFlight--
    }
    const first = env.guard.withSearchConcurrency(body)
    const waiter = env.guard.withSearchConcurrency(body)
    await tick()
    g.open()
    // a newcomer while the slot is being handed to the waiter
    const newcomer = env.guard.withSearchConcurrency(body)
    await Promise.all([first, waiter, newcomer])
    expect(peak).toBe(1)
  })

  it('releases the slot when the call throws and passes the rejection through', async () => {
    const env = makeEnv({ maxConcurrent: 1 })
    await expect(env.guard.withSearchConcurrency(async () => { throw new RangeError('boom') })).rejects.toThrow('boom')
    expect(env.guard.searchConcurrencyInfo().active).toBe(0)
    expect(await env.guard.withSearchConcurrency(async () => 'ok')).toBe('ok')
  })

  it.each([0, -1])('maxConcurrent %i disables the cap', async (max) => {
    const env = makeEnv({ maxConcurrent: max })
    const g = gate()
    let running = 0
    const runs = Array.from({ length: 5 }, () => env.guard.withSearchConcurrency(async () => { running++; await g.p }))
    await tick()
    expect(running).toBe(5)
    expect(env.guard.searchConcurrencyInfo().queued).toBe(0)
    g.open()
    await Promise.all(runs)
  })
})
