/**
 * Runtime streaming primitive — SPEC §11 (full streaming).
 *
 * Provides `ApiStream<T>`, the canonical per-chunk async iterable that the
 * Layer harness wraps.  Design invariants:
 *
 *   - Consumer-pull backpressure: the producer is only invoked when the
 *     consumer calls `next()` via `for await`.
 *   - AbortSignal cancellation: when `signal` fires the iteration terminates
 *     cleanly and each Layer's **end** path runs (not error — §11).
 *   - Error-after-first-chunk: a stream that already emitted at least one
 *     chunk still delivers a terminal error via the normal AsyncIterator
 *     protocol (the `throw` method / a rejection from `next()`), matching
 *     Connect's streaming-error semantics.  Callers that need to distinguish
 *     the phase use `StreamingErrorCarrier` from `@adhd/apigen-errors`.
 *
 * Layer wrappers follow the §11 generator pattern:
 *
 * ```ts
 * layer: async function* (call, next) {
 *   const upstream = await next()                  // start
 *   try {
 *     for await (const chunk of upstream as ApiStream<unknown>) {
 *       yield transform(chunk)                      // each-chunk
 *     }
 *                                                   // end
 *   } catch (e) { throw toApiError(e) }             // error (in-band if already flushed)
 * }
 * ```
 */

import { ApiError, toStreamingError } from '@adhd/apigen-errors'
import type { AfterFirstChunkError, BeforeFirstChunkError } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A strongly-typed async iterable chunk stream (§11 consumer-pull). */
export type ApiStream<T = unknown> = AsyncIterable<T>

/**
 * Options for {@link createStream}.
 *
 * @template T - the chunk type yielded by the producer
 */
export interface CreateStreamOptions<T = unknown> {
  /**
   * The producer: an async generator that yields chunks.
   * It receives the AbortSignal so it can honour cancellation directly;
   * the harness also terminates iteration externally when the signal fires.
   */
  produce: (signal: AbortSignal) => AsyncGenerator<T>
  /**
   * Optional cancellation signal (§11).
   * When aborted, iteration terminates after the current `yield` without
   * surfacing an error — each Layer's **end** path runs.
   */
  signal?: AbortSignal
}

// ---------------------------------------------------------------------------
// createStream — the runtime streaming primitive
// ---------------------------------------------------------------------------

/**
 * Wrap an async generator producer in a stream-lifecycle–aware `ApiStream`.
 *
 * The returned `AsyncIterable` is **consumer-pull**: the producer is driven
 * one chunk at a time by the consumer's `for await`.  Backpressure is
 * natural — the producer only runs when the consumer is ready for the next
 * value.
 *
 * Cancellation: when `options.signal` fires, the next `next()` call returns
 * `{ done: true }` cleanly.  Any pending `await` inside the producer is
 * interrupted by the same signal (the producer must honour it).
 *
 * Error-after-first-chunk: if the producer throws after yielding at least
 * one chunk, the `ApiStream` propagates the error as a normal iterator
 * rejection (the consumer's `for await` body receives a thrown `ApiError`
 * or plain error).  Transport adapters catch this and deliver it in-band
 * per the §11 carrier table.
 *
 * @example
 * ```ts
 * const stream = createStream({
 *   produce: async function* (signal) {
 *     for (const item of items) {
 *       if (signal.aborted) return
 *       yield item
 *     }
 *   },
 *   signal: call.signal,
 * })
 * for await (const chunk of stream) { ... }
 * ```
 */
export function createStream<T = unknown>(options: CreateStreamOptions<T>): ApiStream<T> {
  const { produce, signal } = options

  // Provide a no-op signal if none supplied so the producer always gets one.
  const effectiveSignal = signal ?? new AbortController().signal

  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      const gen = produce(effectiveSignal)

      return {
        async next(): Promise<IteratorResult<T>> {
          // Honour cancellation before pulling the next chunk.
          if (effectiveSignal.aborted) {
            // Clean termination — end path, not error path (§11).
            await gen.return(undefined)
            return { done: true, value: undefined as unknown as T }
          }
          // Pull the next chunk; any producer error propagates naturally.
          return gen.next()
        },

        async return(value?: unknown): Promise<IteratorResult<T>> {
          // Triggered by early `break` or cancel — clean end path (§11).
          await gen.return(value)
          return { done: true, value: undefined as unknown as T }
        },

        async throw(err?: unknown): Promise<IteratorResult<T>> {
          // Triggered by consumer throwing into the iterator.
          await gen.throw(err)
          return { done: true, value: undefined as unknown as T }
        },
      }
    },
  }
}

// ---------------------------------------------------------------------------
// drainStream — exhaust an ApiStream into an array (useful in tests / CLI)
// ---------------------------------------------------------------------------

/**
 * Collect all chunks from an `ApiStream` into an array.
 *
 * Used by CLI adapters and test helpers.  Surfaces error-after-first-chunk
 * as a thrown `ApiError` / plain error — callers wrap with try/catch.
 */
export async function drainStream<T>(stream: ApiStream<T>): Promise<T[]> {
  const chunks: T[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}

// ---------------------------------------------------------------------------
// collectWithPhase — drain, tracking the StreamingErrorCarrier phase (§11)
// ---------------------------------------------------------------------------

/** Result returned by {@link collectWithPhase}. */
export type CollectResult<T> =
  | { ok: true; chunks: T[] }
  | { ok: false; carrier: BeforeFirstChunkError | AfterFirstChunkError }

/**
 * Drain `stream`, tracking whether any chunks were emitted before an error.
 *
 * Returns a discriminated result:
 * - `{ ok: true, chunks }` — stream completed cleanly.
 * - `{ ok: false, carrier }` — stream threw; `carrier.phase` indicates
 *   whether the error was before or after the first chunk was produced.
 *
 * Transport adapters use this to select the correct §11 in-band carrier.
 */
export async function collectWithPhase<T>(stream: ApiStream<T>): Promise<CollectResult<T>> {
  const chunks: T[] = []
  try {
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    return { ok: true, chunks }
  } catch (err) {
    const apiError =
      err instanceof ApiError
        ? err
        : new ApiError('internal', err instanceof Error ? err.message : String(err))

    if (chunks.length === 0) {
      return { ok: false, carrier: toStreamingError('before-first-chunk', apiError) }
    }
    return {
      ok: false,
      carrier: toStreamingError('after-first-chunk', apiError, chunks.length),
    }
  }
}

// ---------------------------------------------------------------------------
// isApiStream — type guard
// ---------------------------------------------------------------------------

/**
 * Returns true when `value` is an `AsyncIterable` (i.e. an `ApiStream`).
 *
 * Used by Layer harness dispatch to distinguish streaming from scalar results.
 */
export function isApiStream(value: unknown): value is ApiStream<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  )
}
