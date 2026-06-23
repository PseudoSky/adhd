// Streaming end-to-end (dod.14) — drives the REAL runtime streaming primitive
// (`@adhd/apigen-runtime`'s `createStream`) projected onto a REAL transport
// (`@adhd/apigen-plugin-api-fastify`'s SSE projection `sendStreamSse`) over a
// live Fastify server. We assert the CONSUMER-VISIBLE wire:
//
//   1. Ordered chunks       — the SSE `data:` frames arrive in producer order.
//   2. Error-after-first-chunk — the producer throws AFTER chunk #1; the consumer
//      receives the earlier chunk(s) THEN a terminal in-band `event: error`
//      frame (Connect/§11 semantics), never a silently dropped stream.
//   3. Negative control     — a CLEAN stream (no throw) emits NO `event: error`
//      frame. Swallowing the post-first-chunk error would make the erroring
//      stream look like this clean one → the error assertion goes red.
//   4. Mid-stream cancel     — aborting mid-stream terminates cleanly via the
//      stream's END path (a `return()` on the producer), NOT the error path.
//
// Determinism (CLAUDE.md §6): chunk ordering is proved by sequence, not timing.
// The post-first-chunk error is gated on a deterministic counter (throw on the
// 3rd pull), not a clock. Cancel is proved by a latch the producer records into
// (its `finally`/return path runs) — no sleeps. The server is always closed in
// afterEach (no orphans).

import { describe, it, expect, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { createStream } from '@adhd/apigen-runtime'
// Deep relative import of the REAL SSE projection (it is not re-exported from the
// plugin index; this reaches the actual component under test, not a copy).
import { sendStreamSse } from '../../../../plugins/api-fastify/src/lib/stream'
import { ApiError } from '@adhd/apigen-errors'

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/** Parse a raw SSE body into ordered frames: { event, data }. */
function parseSse(raw: string): Array<{ event: string; data: string }> {
  const frames: Array<{ event: string; data: string }> = []
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed) continue
    let event = 'message'
    const dataLines: string[] = []
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

// ---------------------------------------------------------------------------
// (1) Ordered chunks + (2) error-after-first-chunk + (3) negative control
// ---------------------------------------------------------------------------

describe('streaming: SSE projection end-to-end', () => {
  it('delivers ordered chunks then an in-band error AFTER the first chunk', async () => {
    const port = 47571
    app = Fastify()

    // CLEAN streaming route — emits 3 ordered chunks, no error (negative control).
    app.get('/clean', (req, reply) => {
      const stream = createStream<{ n: number }>({
        produce: async function* () {
          yield { n: 0 }
          yield { n: 1 }
          yield { n: 2 }
        },
      })
      return sendStreamSse(stream, req, reply)
    })

    // ERRORING route — emits chunk #0 and #1, THEN throws on the 3rd pull.
    // Deterministic: gated on a pull counter, not a clock.
    app.get('/boom', (req, reply) => {
      const stream = createStream<{ n: number }>({
        produce: async function* () {
          yield { n: 0 }
          yield { n: 1 }
          throw new ApiError('internal', 'producer exploded after first chunk')
        },
      })
      return sendStreamSse(stream, req, reply)
    })

    await app.listen({ port, host: '127.0.0.1' })

    // ── Negative control: the CLEAN stream emits NO error frame ──────────────
    const cleanRes = await fetch(`http://127.0.0.1:${port}/clean`)
    const cleanFrames = parseSse(await cleanRes.text())
    const cleanData = cleanFrames.filter((f) => f.event === 'message')
    expect(cleanData.map((f) => JSON.parse(f.data))).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }])
    // No terminal error frame on a clean stream.
    expect(cleanFrames.some((f) => f.event === 'error')).toBe(false)

    // ── Error-after-first-chunk: chunk(s) THEN a terminal in-band error ──────
    const boomRes = await fetch(`http://127.0.0.1:${port}/boom`)
    const boomFrames = parseSse(await boomRes.text())
    const boomData = boomFrames.filter((f) => f.event === 'message')
    // The earlier chunks arrived (ordered), proving the error is AFTER the first.
    expect(boomData.map((f) => JSON.parse(f.data))).toEqual([{ n: 0 }, { n: 1 }])
    // A terminal in-band error frame is present (NOT a dropped stream).
    const errorFrame = boomFrames.find((f) => f.event === 'error')
    expect(errorFrame).toBeDefined()
    const errPayload = JSON.parse(errorFrame!.data) as { code: string; message: string }
    expect(errPayload.code).toBe('internal')
    expect(errPayload.message).toContain('after first chunk')
  })

  // ── (4) Mid-stream cancel runs the END path (clean), not the error path ────
  it('mid-stream cancel terminates via the END path (producer return), not error', async () => {
    // Latch the producer records its termination kind into. Cancel must drive the
    // generator's `return()` (finally block) — NOT a thrown error.
    let endedVia: 'return' | 'throw' | 'exhausted' = 'exhausted'
    const cancel = new AbortController()
    let produced = 0

    const stream = createStream<number>({
      produce: async function* (sig) {
        try {
          for (let i = 0; ; i++) {
            if (sig.aborted) return
            produced++
            yield i
          }
        } catch {
          endedVia = 'throw'
          throw new Error('should not happen on cancel')
        } finally {
          // Reached on generator.return() (clean end) — NOT on a throw path.
          if (endedVia !== 'throw') endedVia = 'return'
        }
      },
      signal: cancel.signal,
    })

    // Pull two chunks, then cancel, then pull once more — must be done cleanly.
    const it = stream[Symbol.asyncIterator]()
    const a = await it.next()
    const b = await it.next()
    expect(a).toEqual({ done: false, value: 0 })
    expect(b).toEqual({ done: false, value: 1 })

    cancel.abort()
    const after = await it.next()
    // Clean termination: done=true, no error thrown to the consumer.
    expect(after.done).toBe(true)
    // The producer's END path ran (return/finally), not the error path.
    expect(endedVia).toBe('return')
    // We pulled exactly 2 values before cancel.
    expect(produced).toBe(2)
  })
})
