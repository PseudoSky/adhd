/**
 * guards: runExtractorEmitJson never settles or never kills the child on timeout, or accepts an out-of-range timeoutMs
 * tier: S
 * cites: 5a59f9ec, 80c98734 (regression)
 *
 * Regression tests for `runExtractorEmitJson` timeout handling.
 *
 * Tier: S (unit lane). `node:child_process.spawn` is mocked with a fake child
 * EventEmitter and vitest fake timers drive the clock; no subprocess is spawned and
 * no wall-clock sleep is used.
 *
 * Items (commit shas; commit messages carry no uid):
 * - regression:5a59f9ec — the extractor run is bounded: on expiry the child is
 *   SIGKILLed and the promise rejects with an error naming the command.
 *   Expected red at its parent 78b1c1d6 (no kill, no timeout option).
 * - regression:80c98734 — the promise settles on 'close' (not 'exit'); timeoutMs above
 *   the setTimeout maximum (2147483647) is rejected before spawn; the
 *   non-finite/non-positive message is preserved; DEFAULT_EXTRACTOR_TIMEOUT_MS is
 *   exported from the package index. Expected red at its parent fcd20c30 for the
 *   close-settle, bound, and export tests. The non-finite guard test is green at
 *   fcd20c30 and is red only at 78b1c1d6 (it guards the existing message).
 *
 * - regression:5a59f9ec (settle-after-kill) — after the timeout SIGKILL the promise settles
 *   with the timeout error on whichever of 'exit' or 'close' fires first, exactly once, with
 *   the timer cleared and the child's stdout/stderr destroyed. A descendant that still holds
 *   the pipes means 'close' may never fire. Expected red at 5d46329d (the committed
 *   run-extractor.ts before the fix): 'exit' is not a settling event, so the promise stays
 *   pending and the `settled` assertions fail; stdout/stderr destroy is never called.
 * - regression:80c98734 (boundary) — timeoutMs = 2147483647 is accepted and spawns;
 *   2147483648 is rejected. The accept side is a guard (green at fcd20c30 and 5d46329d).
 *
 * red: pending (user hold) — the suite was not executed when these tests were authored.
 * Expected red: the settle-after-kill tests at 5d46329d; the pre-existing tests at the
 * parents named above.
 */
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runExtractorEmitJson } from '../lib/run-extractor'
import * as pkg from '../index'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

interface IFakePipe extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>
}

interface IFakeChild extends EventEmitter {
  stdout: IFakePipe
  stderr: IFakePipe
  kill: ReturnType<typeof vi.fn>
}

/** A child whose kill() does not emit anything; the test decides what the child reports. */
function createFakeChild(): IFakeChild {
  const child = new EventEmitter() as IFakeChild
  child.stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as IFakePipe
  child.stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() }) as IFakePipe
  child.kill = vi.fn(() => true)
  return child
}

const spawnMock = vi.mocked(spawn)
const flushMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

interface IObserved {
  settled: boolean
  count: number
  error: unknown
  value: unknown
}

/** Records whether and how many times a promise settled, without ever hanging the test. */
function observe(run: Promise<unknown>): IObserved {
  const state: IObserved = { settled: false, count: 0, error: undefined, value: undefined }
  run.then(
    (value) => {
      state.settled = true
      state.count += 1
      state.value = value
    },
    (error: unknown) => {
      state.settled = true
      state.count += 1
      state.error = error
    },
  )
  return state
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  spawnMock.mockReset()
  spawnMock.mockImplementation(() => createFakeChild() as unknown as ReturnType<typeof spawn>)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runExtractorEmitJson timeout (unit, mocked spawn)', () => {
  it('regression:5a59f9ec SIGKILLs the extractor at timeoutMs and rejects naming the command', async () => {
    // Failure mode: a hung extractor holds the promise and its pipes forever (CI stall).
    // Expected red at 78b1c1d6: the timeout option is ignored, so kill is never called.
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const run = runExtractorEmitJson('python3', '/pkg', '/mod.py', 'ns', 'py-flask', { timeoutMs: 5_000 })
    const outcome = run.then(
      () => null,
      (err: unknown) => err,
    )

    vi.advanceTimersByTime(4_999)
    expect(child.kill).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    // The fake child reports both events after being killed; the promise must reject
    // with the timeout error whichever of them settles it.
    child.emit('exit', null)
    child.emit('close', null)

    const err = await outcome
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toContain('py-flask')
    expect(message).toContain('timed out after 5000 ms')
    expect(message).toContain('python3 -m apigen_python.extractor /mod.py --namespace ns --emit-json')
  })
})

describe('runExtractorEmitJson settle after kill (unit, mocked spawn)', () => {
  const startRun = (child: IFakeChild): IObserved => {
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    const run = runExtractorEmitJson('python3', '/pkg', '/mod.py', 'ns', 'py-flask', { timeoutMs: 5_000 })
    return observe(run)
  }

  it('regression:5a59f9ec rejects with the timeout error when only exit fires after the kill (close never fires)', async () => {
    // Failure mode: a descendant of the killed extractor holds the stdout/stderr pipes, so
    // 'close' never fires; a promise that waits only for 'close' hangs the caller forever.
    // Expected red at 5d46329d: 'exit' does not settle, so `settled` stays false.
    const child = createFakeChild()
    const state = startRun(child)

    vi.advanceTimersByTime(5_000)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')

    child.emit('exit', null, 'SIGKILL')
    await flushMicrotasks()

    expect(state.settled).toBe(true)
    expect(state.error).toBeInstanceOf(Error)
    expect((state.error as Error).message).toContain('timed out after 5000 ms')
    expect((state.error as Error).message).toContain('py-flask')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('regression:5a59f9ec rejects at expiry when the child already exited and close never fires', async () => {
    // Failure mode: the child exits but a grandchild keeps the pipes open, so 'close' never
    // arrives; the timeout must still reject. Expected red at 5d46329d: the timer path does
    // not settle on an already-seen 'exit', so `settled` stays false.
    const child = createFakeChild()
    const state = startRun(child)

    vi.advanceTimersByTime(1_000)
    child.emit('exit', 0, null)
    await flushMicrotasks()
    expect(state.settled).toBe(false)

    vi.advanceTimersByTime(4_000)
    await flushMicrotasks()

    expect(state.settled).toBe(true)
    expect((state.error as Error).message).toContain('timed out after 5000 ms')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('regression:5a59f9ec settles exactly once with the timeout error when exit and then close both fire', async () => {
    // Failure mode: a second settling event rewrites the outcome (a late close with code 137
    // turning the timeout into a generic exit-code error) or settles twice.
    // Expected red at 5d46329d: the exit-driven settle is absent, so the outcome depends on
    // close alone and the pipe-destroy side effects are missing (see the destroy test).
    const child = createFakeChild()
    const state = startRun(child)

    vi.advanceTimersByTime(5_000)
    child.emit('exit', null, 'SIGKILL')
    child.emit('close', 137, 'SIGKILL')
    await flushMicrotasks()

    expect(state.count).toBe(1)
    expect((state.error as Error).message).toContain('timed out after 5000 ms')
    expect((state.error as Error).message).not.toContain('exited with code')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('regression:5a59f9ec destroys the child stdout and stderr after the kill so a pipe-holding descendant cannot pin the process', () => {
    // Failure mode: pipes stay open after SIGKILL, keeping the event loop alive.
    // Expected red at 5d46329d: destroy is never called.
    const child = createFakeChild()
    startRun(child)

    vi.advanceTimersByTime(5_000)

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(child.stdout.destroy).toHaveBeenCalledTimes(1)
    expect(child.stderr.destroy).toHaveBeenCalledTimes(1)
  })

  it('regression:5a59f9ec clears the timer when the run completes normally so no stray kill fires later', async () => {
    // Failure mode: a leaked timer kills a healthy, already-finished extractor's pid.
    // Guard test: green at 5d46329d as well; red if the timer is left armed on completion.
    const child = createFakeChild()
    const state = startRun(child)

    child.stdout.emit('data', Buffer.from('[]', 'utf8'))
    child.emit('exit', 0, null)
    child.emit('close', 0, null)
    await flushMicrotasks()

    expect(state.value).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(10_000)
    expect(child.kill).not.toHaveBeenCalled()
  })
})

describe('runExtractorEmitJson settle and bound (unit, mocked spawn)', () => {
  it('regression:80c98734 does not settle on exit alone and settles on close with the drained stdout', async () => {
    // Failure mode: settling on 'exit' resolves before stdout is drained, so a valid
    // payload is parsed as '' and the run fails spuriously. Expected red at fcd20c30:
    // the promise settles on 'exit', so the `settled` assertion fails.
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const run = runExtractorEmitJson('python3', '/pkg', '/mod.py', 'ns', 'py-flask')
    let settled = false
    run.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    child.emit('exit', 0)
    child.stdout.emit('data', Buffer.from('[]', 'utf8'))
    await flushMicrotasks()
    expect(settled).toBe(false)

    child.emit('close', 0)
    await expect(run).resolves.toEqual([])
  })

  it('regression:80c98734 accepts timeoutMs exactly at the setTimeout maximum (2147483647) and spawns', async () => {
    // Boundary guard paired with the 2147483648 rejection below: the bound is inclusive.
    // Green at fcd20c30 and 5d46329d; red if the check becomes `>=`.
    const child = createFakeChild()
    spawnMock.mockReturnValue(child as unknown as ReturnType<typeof spawn>)

    const run = runExtractorEmitJson('python3', '/pkg', '/mod.py', 'ns', 'py-flask', {
      timeoutMs: 2_147_483_647,
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    child.stdout.emit('data', Buffer.from('[]', 'utf8'))
    child.emit('close', 0, null)
    await expect(run).resolves.toEqual([])
  })

  it('regression:80c98734 rejects timeoutMs above the setTimeout maximum before spawning', async () => {
    // Failure mode: setTimeout overflows a delay above 2^31-1 and fires at 1 ms, killing
    // a healthy extractor. Expected red at fcd20c30: no upper bound, so spawn runs and
    // the promise does not reject with a RangeError.
    const run = runExtractorEmitJson('python3', '/pkg', '/mod.py', 'ns', 'py-grpc', {
      timeoutMs: 2_147_483_648,
    })
    run.catch(() => undefined)

    expect(spawnMock).not.toHaveBeenCalled()
    await expect(run).rejects.toBeInstanceOf(RangeError)
    await expect(run).rejects.toThrow(/py-grpc[\s\S]*2147483647/)
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['0', 0],
    ['-1', -1],
  ])(
    'regression:80c98734 (guard) keeps the existing message for timeoutMs %s and does not spawn',
    async (_label, timeoutMs) => {
      // Guard test: the existing non-finite/non-positive message must survive the
      // upper-bound change. Green at fcd20c30; red at 78b1c1d6, which has no check at all.
      const run = runExtractorEmitJson('python3', '/pkg', '/mod.py', 'ns', 'py-flask', { timeoutMs })
      run.catch(() => undefined)

      expect(spawnMock).not.toHaveBeenCalled()
      await expect(run).rejects.toBeInstanceOf(RangeError)
      await expect(run).rejects.toThrow(/py-flask: extractor timeoutMs must be a positive finite number, got /)
    },
  )

  it('regression:80c98734 exports DEFAULT_EXTRACTOR_TIMEOUT_MS from the package index', () => {
    // Failure mode: callers cannot read or reference the default budget. Expected red at
    // fcd20c30: the index does not export the constant, so the property is absent.
    expect(pkg).toHaveProperty('DEFAULT_EXTRACTOR_TIMEOUT_MS', 120_000)
  })
})
