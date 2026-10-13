/**
 * Harness spec for src/test/support/fake-proc.ts.
 * Ticket 8468f7b1 · [cdp-test-harness.6]
 * Real use: a manager decides whether a recorded Chrome is still the process it
 * launched (pidAlive + procStart), terminates its whole process group, and
 * launches a replacement through spawn. Nothing real is signalled.
 */
import { describe, expect, it } from 'vitest'
import { FakeProc } from '../../support/fake-proc.js'

describe('8468f7b1 [cdp-test-harness.6] FakeProc pidAlive / procStart', () => {
  it('pidAlive is true for a registered process, false for unknown pids and after death', () => {
    const p = new FakeProc()
    const e = p.addProcess()
    expect(p.pidAlive(e.pid)).toBe(true)
    expect(p.pidAlive(999_999)).toBe(false)
    p.die(e.pid)
    expect(p.pidAlive(e.pid)).toBe(false)
  })

  it('procStart distinguishes a recycled pid from the original process', () => {
    const p = new FakeProc()
    const e = p.addProcess({ pid: 777 })
    const original = p.procStart(777)
    expect(original).toBe(e.start)
    p.die(777)
    expect(p.procStart(777)).toBeNull()
    p.recycle(777)
    expect(p.pidAlive(777)).toBe(true)
    expect(p.procStart(777)).not.toBe(original)
  })
})

describe('8468f7b1 [cdp-test-harness.6] FakeProc kill', () => {
  it('kill(pid, SIGTERM) logs the call and kills only that pid', () => {
    const p = new FakeProc()
    const a = p.addProcess({ pid: 10 })
    const b = p.addProcess({ pid: 11, pgid: 10 })
    p.kill(10, 'SIGTERM')
    expect(p.killLog).toEqual([{ target: 10, signal: 'SIGTERM' }])
    expect(p.pidAlive(a.pid)).toBe(false)
    expect(p.pidAlive(b.pid)).toBe(true)
  })

  it('kill(-pgid) takes down every live member of the group (Chrome and its helpers)', () => {
    const p = new FakeProc()
    p.addProcess({ pid: 20 })
    p.addProcess({ pid: 21, pgid: 20 })
    p.addProcess({ pid: 22, pgid: 20 })
    const other = p.addProcess({ pid: 30 })
    p.kill(-20, 'SIGKILL')
    expect([20, 21, 22].map((x) => p.pidAlive(x))).toEqual([false, false, false])
    expect(p.pidAlive(other.pid)).toBe(true)
    expect(p.killLog).toEqual([{ target: -20, signal: 'SIGKILL' }])
  })

  it('signal 0 only probes; a dead target throws ESRCH and is still logged', () => {
    const p = new FakeProc()
    p.addProcess({ pid: 40 })
    expect(p.kill(40, 0)).toBe(true)
    expect(p.pidAlive(40)).toBe(true)
    p.die(40)
    let code: string | undefined
    try {
      p.kill(40, 0)
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code
    }
    expect(code).toBe('ESRCH')
    expect(p.killLog).toHaveLength(2)
  })
})

describe('8468f7b1 [cdp-test-harness.6] FakeProc spawn', () => {
  it('spawn records command, args and options, returns a live pid that leads its own group', () => {
    const p = new FakeProc(5000)
    const child = p.spawn('chrome', ['--remote-debugging-port=9222'], { detached: true })
    expect(child.pid).toBe(5000)
    expect(p.spawnLog).toEqual([{ command: 'chrome', args: ['--remote-debugging-port=9222'], opts: { detached: true }, pid: 5000 }])
    expect(p.pidAlive(5000)).toBe(true)
    p.kill(-5000, 'SIGTERM')
    expect(p.pidAlive(5000)).toBe(false)
    expect(p.spawn('chrome').pid).toBe(5001)
  })
})
