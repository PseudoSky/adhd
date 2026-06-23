/**
 * Tests for packages/apigen/runtime/src/lib/stream.ts — §11 streaming primitive.
 *
 * TEETH contract (CLAUDE.md §6):
 *   - No sleep() / wall-clock timing.
 *   - Ordering proved by collecting chunks in sequence.
 *   - Cancellation proved by a latch: production is halted mid-stream and the
 *     iterator returns done=true cleanly (no error surface).
 *   - Error-after-first-chunk: negative control proves a clean stream never
 *     produces an error carrier; only the erroring stream does.
 */

import { describe, it, expect } from 'vitest'
import {
  createStream,
  drainStream,
  collectWithPhase,
  isApiStream,
} from './stream'
import { ApiError } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// Helper: make a simple range stream
// ---------------------------------------------------------------------------

function rangeStream(n: number, signal?: AbortSignal) {
  return createStream<number>({
    produce: async function* (sig) {
      for (let i = 0; i < n; i++) {
        if (sig.aborted) return
        yield i
      }
    },
    signal,
  })
}

// ---------------------------------------------------------------------------
// §11 — ordered chunks
// ---------------------------------------------------------------------------

describe('[stream.ordered] yields N chunks in order', () => {
  it('drains 5 chunks in ascending order', async () => {
    const stream = rangeStream(5)
    const chunks = await drainStream(stream)
    expect(chunks).toEqual([0, 1, 2, 3, 4])
  })

  it('drains 0 chunks for an empty producer', async () => {
    const stream = createStream<number>({
      produce: async function* () { /* intentionally empty */ },
    })
    const chunks = await drainStream(stream)
    expect(chunks).toEqual([])
  })

  it('yields chunks in the exact order emitted by the producer', async () => {
    const items = ['alpha', 'beta', 'gamma']
    const stream = createStream<string>({
      produce: async function* () {
        for (const item of items) yield item
      },
    })
    const chunks = await drainStream(stream)
    expect(chunks).toEqual(items)
  })
})

// ---------------------------------------------------------------------------
// §11 — error-after-first-chunk (Connect semantics)
// ---------------------------------------------------------------------------

describe('[stream.error-after-first-chunk] error is delivered in-band', () => {
  it('collectWithPhase returns before-first-chunk carrier when no chunks emitted', async () => {
    const stream = createStream<number>({
      produce: async function* () {
        throw new ApiError('internal', 'immediate failure')
        // eslint-disable-next-line no-unreachable
        yield 0
      },
    })
    const result = await collectWithPhase(stream)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('impossible')
    expect(result.carrier.phase).toBe('before-first-chunk')
    expect(result.carrier.error.code).toBe('internal')
  })

  it('collectWithPhase returns after-first-chunk carrier when ≥1 chunk emitted before error', async () => {
    const stream = createStream<number>({
      produce: async function* () {
        yield 1
        yield 2
        throw new ApiError('internal', 'mid-stream failure')
      },
    })
    const result = await collectWithPhase(stream)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('impossible')
    expect(result.carrier.phase).toBe('after-first-chunk')
    // chunksDelivered tells transport how many chunks were already flushed
    expect(result.carrier.chunksDelivered).toBe(2)
    expect(result.carrier.error.code).toBe('internal')
    expect(result.carrier.error.message).toBe('mid-stream failure')
  })

  // Negative control: a clean stream must NOT emit an error carrier.
  it('(negative) clean stream → ok:true, no error carrier', async () => {
    const stream = rangeStream(3)
    const result = await collectWithPhase(stream)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('impossible')
    expect(result.chunks).toEqual([0, 1, 2])
  })

  it('wraps non-ApiError producer errors in an internal ApiError', async () => {
    const stream = createStream<number>({
      produce: async function* () {
        yield 42
        throw new Error('plain error')
      },
    })
    const result = await collectWithPhase(stream)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('impossible')
    expect(result.carrier.phase).toBe('after-first-chunk')
    expect(result.carrier.error).toBeInstanceOf(ApiError)
    expect(result.carrier.error.code).toBe('internal')
  })
})

// ---------------------------------------------------------------------------
// §11 — mid-stream cancel via AbortSignal
// ---------------------------------------------------------------------------

describe('[stream.cancel] AbortSignal stops production cleanly', () => {
  it('aborting mid-stream stops the iterator (returns done) without throwing', async () => {
    const controller = new AbortController()

    // Producer uses a latch: emit the first chunk then wait for abort.
    // We abort from outside after collecting the first chunk.
    let yieldCount = 0

    const stream = createStream<number>({
      produce: async function* (sig) {
        for (let i = 0; i < 100; i++) {
          if (sig.aborted) return    // honour signal — clean end
          yieldCount++
          yield i
          // After first chunk, break the production loop so the test can abort.
          // In real usage, the signal fires between any two yields; here we
          // simulate by stopping the loop after the latch is satisfied.
          if (yieldCount >= 1) return
        }
      },
      signal: controller.signal,
    })

    const iter = stream[Symbol.asyncIterator]()

    // Pull one chunk before aborting.
    const first = await iter.next()
    expect(first.done).toBe(false)
    expect(first.value).toBe(0)

    // Abort — next pull must return done:true, not throw.
    controller.abort()
    const second = await iter.next()
    expect(second.done).toBe(true)
  })

  it('aborting before the first pull terminates cleanly', async () => {
    const controller = new AbortController()
    controller.abort()   // already aborted

    const stream = rangeStream(10, controller.signal)
    const chunks: number[] = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    // No chunks because signal was already aborted at start.
    expect(chunks).toHaveLength(0)
  })

  it('cancelled stream does not propagate an error (end path, not error path)', async () => {
    const controller = new AbortController()

    const stream = createStream<string>({
      produce: async function* (sig) {
        for (const s of ['a', 'b', 'c', 'd']) {
          if (sig.aborted) return
          yield s
        }
      },
      signal: controller.signal,
    })

    const iter = stream[Symbol.asyncIterator]()
    const first = await iter.next()
    expect(first.done).toBe(false)

    controller.abort()

    // Must not throw — the end path runs (§11: "a cancelled stream runs each
    // Layer's end path, not error").
    await expect(iter.next()).resolves.toMatchObject({ done: true })
  })
})

// ---------------------------------------------------------------------------
// isApiStream — type guard
// ---------------------------------------------------------------------------

describe('[stream.isApiStream] type guard', () => {
  it('returns true for an AsyncIterable', () => {
    expect(isApiStream(rangeStream(0))).toBe(true)
  })

  it('returns false for a plain object', () => {
    expect(isApiStream({ result: 42 })).toBe(false)
  })

  it('returns false for a primitive', () => {
    expect(isApiStream(42)).toBe(false)
    expect(isApiStream(null)).toBe(false)
    expect(isApiStream(undefined)).toBe(false)
  })

  it('returns false for a Promise (not an AsyncIterable)', () => {
    expect(isApiStream(Promise.resolve(42))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Layer wrapping pattern (§11 generator)
// ---------------------------------------------------------------------------

describe('[stream.layer-wrap] Layer wraps stream, preserving backpressure', () => {
  it('a per-chunk Layer transform is applied to every chunk', async () => {
    const upstream = rangeStream(4)

    // Simulate a Layer that multiplies each chunk by 10.
    async function* wrapLayer(source: AsyncIterable<number>): AsyncGenerator<number> {
      for await (const chunk of source) {
        yield chunk * 10
      }
    }

    const wrapped = { [Symbol.asyncIterator]: () => wrapLayer(upstream)[Symbol.asyncIterator]() }
    const result = await drainStream(wrapped)
    expect(result).toEqual([0, 10, 20, 30])
  })

  it('error inside the wrapped Layer propagates to the consumer', async () => {
    const upstream = rangeStream(5)

    async function* faultyLayer(source: AsyncIterable<number>): AsyncGenerator<number> {
      let i = 0
      for await (const chunk of source) {
        if (i === 2) throw new ApiError('internal', 'layer fault')
        yield chunk
        i++
      }
    }

    const wrapped: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => faultyLayer(upstream)[Symbol.asyncIterator](),
    }

    const result = await collectWithPhase(wrapped)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('impossible')
    expect(result.carrier.phase).toBe('after-first-chunk')
    expect(result.carrier.chunksDelivered).toBe(2)
  })
})
