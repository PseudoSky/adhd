/**
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
 * Red run: pending. The unit suite was not executed when these tests were authored;
 * the red record is owed before merge.
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

interface IFakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

/** A child whose kill() does not emit anything; the test decides what the child reports. */
function createFakeChild(): IFakeChild {
  const child = new EventEmitter() as IFakeChild
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.kill = vi.fn(() => true)
  return child
}

const spawnMock = vi.mocked(spawn)
const flushMicrotasks = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

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
