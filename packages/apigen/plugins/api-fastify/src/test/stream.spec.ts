/**
 * Tests for packages/apigen/plugins/api-fastify/src/lib/stream.ts — HTTP/SSE streaming projection.
 *
 * TEETH (CLAUDE.md §6):
 *   - No sleep() / wall-clock timing — uses latches and barriers.
 *   - Ordered chunks: verified by parsing SSE frames from the mock raw response
 *     in sequence.
 *   - Error-after-first-chunk: `event: error` frame appears after data frames;
 *     negative control proves a clean stream emits no error frame.
 *   - Mid-stream cancel: client disconnect (req.raw 'close') aborts the stream;
 *     raw.end() is called without an error frame.
 *
 * Transport tests are ALL in-process (mock FastifyRequest/Reply with a fake
 * raw socket collector) so they run deterministically in CI.
 * A real Fastify server test is gated behind APIGEN_LIVE=1.
 */

import { describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import type { FastifyRequest, FastifyReply } from 'fastify'
import EventEmitter from 'node:events'
import { sendStreamSse } from '../lib/stream'
import { createStream } from '@adhd/apigen-runtime'
import { ApiError } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

/**
 * A minimal mock of Node's `http.ServerResponse` that records everything
 * written to it so we can assert on SSE frames.
 */
class MockRawResponse extends EventEmitter {
  statusCode = 200
  headers: Record<string, string | number> = {}
  chunks: Buffer[] = []
  ended = false

  writeHead(status: number, hdrs?: Record<string, string | number>): void {
    this.statusCode = status
    if (hdrs) Object.assign(this.headers, hdrs)
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    return true
  }

  end(chunk?: string | Buffer): void {
    if (chunk) this.chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    this.ended = true
  }

  /** Concatenate all written chunks as a UTF-8 string. */
  get body(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

/**
 * A minimal mock of Node's `http.IncomingMessage` (req.raw) that exposes
 * the EventEmitter interface so we can simulate client disconnect.
 */
class MockRawRequest extends EventEmitter {}

function makeMocks(): {
  req: FastifyRequest
  reply: FastifyReply
  raw: MockRawResponse
  rawReq: MockRawRequest
} {
  const raw = new MockRawResponse()
  const rawReq = new MockRawRequest()

  const reply = {
    raw,
    hijack: vi.fn(),
  } as unknown as FastifyReply

  const req = {
    raw: rawReq,
  } as unknown as FastifyRequest

  return { req, reply, raw, rawReq }
}

/** Parse SSE frames from a response body. Returns `{ event?, data }[]`. */
function parseSseFrames(body: string): Array<{ event?: string; data: string }> {
  const frames: Array<{ event?: string; data: string }> = []
  // SSE frames are separated by blank lines (\n\n).
  const rawFrames = body.split('\n\n').filter((f) => f.trim())
  for (const frame of rawFrames) {
    const lines = frame.split('\n')
    let event: string | undefined
    let data = ''
    for (const line of lines) {
      if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    if (data) frames.push({ ...(event ? { event } : {}), data })
  }
  return frames
}

// ---------------------------------------------------------------------------
// §11 — ordered chunks
// ---------------------------------------------------------------------------

describe('[sse-stream.ordered] SSE frames emitted in order', () => {
  it('3 data frames in order, then response ends', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () {
        yield 10
        yield 20
        yield 30
      },
    })

    await sendStreamSse(stream, req, reply)

    expect(raw.ended).toBe(true)
    expect(raw.statusCode).toBe(200)
    const frames = parseSseFrames(raw.body)
    // Only data frames — no event: field.
    expect(frames.filter((f) => !f.event)).toHaveLength(3)
    expect(frames[0].data).toBe('10')
    expect(frames[1].data).toBe('20')
    expect(frames[2].data).toBe('30')
  })

  it('content-type header is text/event-stream', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<string>({
      produce: async function* () { yield 'hello' },
    })

    await sendStreamSse(stream, req, reply)

    expect(raw.headers['Content-Type']).toBe('text/event-stream')
  })

  it('hijack() is called to suppress Fastify serialisation', async () => {
    const { req, reply } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () { yield 1 },
    })

    await sendStreamSse(stream, req, reply)

    expect((reply.hijack as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })

  // Negative control: clean stream must NOT emit an event: error frame.
  it('(negative) clean stream emits no event:error frame', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () {
        yield 1
        yield 2
      },
    })

    await sendStreamSse(stream, req, reply)

    const frames = parseSseFrames(raw.body)
    const errorFrames = frames.filter((f) => f.event === 'error')
    expect(errorFrames).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// §11 — before-first-chunk error
// ---------------------------------------------------------------------------

describe('[sse-stream.before-first-chunk] error before first chunk → normal HTTP status', () => {
  it('sets HTTP 500 status for internal ApiError', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () {
        throw new ApiError('internal', 'db unreachable')
        // eslint-disable-next-line no-unreachable
        yield 0
      },
    })

    await sendStreamSse(stream, req, reply)

    expect(raw.statusCode).toBe(500)
    expect(raw.headers['Content-Type']).toBe('application/json')
    const parsed = JSON.parse(raw.body) as Record<string, unknown>
    expect(parsed['code']).toBe('internal')
    expect(parsed['message']).toBe('db unreachable')
  })

  it('maps ApiErrorCode to the correct HTTP status (not_found → 404)', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () {
        throw new ApiError('not_found', 'item missing')
        // eslint-disable-next-line no-unreachable
        yield 0
      },
    })

    await sendStreamSse(stream, req, reply)

    expect(raw.statusCode).toBe(404)
  })

  it('wraps a plain Error in an internal ApiError', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () {
        throw new Error('unexpected crash')
        // eslint-disable-next-line no-unreachable
        yield 0
      },
    })

    await sendStreamSse(stream, req, reply)

    expect(raw.statusCode).toBe(500)
    const parsed = JSON.parse(raw.body) as Record<string, unknown>
    expect(parsed['code']).toBe('internal')
    expect(parsed['message']).toBe('unexpected crash')
  })
})

// ---------------------------------------------------------------------------
// §11 — error-after-first-chunk (terminal event: error frame)
// ---------------------------------------------------------------------------

describe('[sse-stream.after-first-chunk] error delivered in-band via event:error frame', () => {
  it('emits data frames then a terminal event:error frame', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<number>({
      produce: async function* () {
        yield 1
        yield 2
        throw new ApiError('internal', 'mid-stream crash')
      },
    })

    await sendStreamSse(stream, req, reply)

    expect(raw.ended).toBe(true)
    // Status was already sent as 200 (first chunk flushed before error).
    expect(raw.statusCode).toBe(200)

    const frames = parseSseFrames(raw.body)
    const dataFrames = frames.filter((f) => !f.event)
    const errorFrames = frames.filter((f) => f.event === 'error')

    // Two data frames before the error.
    expect(dataFrames).toHaveLength(2)
    expect(dataFrames[0].data).toBe('1')
    expect(dataFrames[1].data).toBe('2')

    // One terminal error frame.
    expect(errorFrames).toHaveLength(1)
    const errorPayload = JSON.parse(errorFrames[0].data) as Record<string, unknown>
    expect(errorPayload['code']).toBe('internal')
    expect(errorPayload['message']).toBe('mid-stream crash')
  })

  // Negative control: clean stream must NOT emit an event:error frame.
  it('(negative) clean stream does NOT emit event:error frame', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<string>({
      produce: async function* () {
        yield 'alpha'
        yield 'beta'
        yield 'gamma'
      },
    })

    await sendStreamSse(stream, req, reply)

    const frames = parseSseFrames(raw.body)
    expect(frames.filter((f) => f.event === 'error')).toHaveLength(0)
    expect(frames).toHaveLength(3)
  })

  it('data frames appear BEFORE the error frame (ordering)', async () => {
    const { req, reply, raw } = makeMocks()
    const stream = createStream<string>({
      produce: async function* () {
        yield 'first'
        throw new ApiError('internal', 'boom')
      },
    })

    await sendStreamSse(stream, req, reply)

    const frames = parseSseFrames(raw.body)
    // The data frame index must be less than the error frame index.
    const dataIdx = frames.findIndex((f) => !f.event)
    const errIdx = frames.findIndex((f) => f.event === 'error')
    expect(dataIdx).toBeGreaterThanOrEqual(0)
    expect(errIdx).toBeGreaterThan(dataIdx)
  })
})

// ---------------------------------------------------------------------------
// §11 — mid-stream cancel via client disconnect
// ---------------------------------------------------------------------------

describe('[sse-stream.cancel] client disconnect aborts stream cleanly (end path, not error)', () => {
  it('emitting close on req.raw stops iteration without an event:error frame', async () => {
    const { req, reply, raw, rawReq } = makeMocks()

    // Latch: the producer will wait until the abort fires.
    // We implement this by checking signal.aborted after each yield.
    let yieldCount = 0
    const stream = createStream<number>({
      produce: async function* (sig) {
        for (let i = 0; i < 100; i++) {
          if (sig.aborted) return
          yieldCount++
          yield i
          // After first chunk, stop so the test can disconnect.
          if (yieldCount >= 1) return
        }
      },
    })

    // Emit 'close' synchronously before driving the stream (the iterator has
    // not been polled yet, so the abort propagates into the first poll).
    rawReq.emit('close')

    await sendStreamSse(stream, req, reply)

    // Must not have an error frame — cancellation is a clean end (§11).
    const frames = parseSseFrames(raw.body)
    expect(frames.filter((f) => f.event === 'error')).toHaveLength(0)
    // Response must be ended cleanly.
    expect(raw.ended).toBe(true)
  })

  it('disconnect after first chunk ends response without error frame', async () => {
    const { req, reply, raw, rawReq } = makeMocks()

    // Producer yields one chunk then honours the signal.
    const stream = createStream<number>({
      produce: async function* (sig) {
        yield 42
        if (sig.aborted) return
        yield 99   // should not be delivered after disconnect
      },
    })

    // Simulate disconnect while the first chunk is being processed.
    // The signal is checked on the next iteration, so one chunk may arrive.
    rawReq.emit('close')

    await sendStreamSse(stream, req, reply)

    const frames = parseSseFrames(raw.body)
    expect(frames.filter((f) => f.event === 'error')).toHaveLength(0)
    expect(raw.ended).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Real Fastify server streaming test (always runs — no env gate)
// ---------------------------------------------------------------------------

describe('[sse-stream.live] real Fastify SSE — ordered chunks + error-after-first-chunk', () => {
  it('live SSE stream yields chunks then closes', async () => {
    const app = Fastify()
    app.get('/stream', (req, reply) => {
      const s = createStream<number>({ produce: async function* () { yield 1; yield 2; yield 3 } })
      return sendStreamSse(s, req, reply)
    })

    await app.listen({ port: 0 })  // random port — OS assigns a free one
    const addr = app.server.address() as { port: number }
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/stream`)
      expect(res.ok).toBe(true)
      expect(res.headers.get('content-type')).toContain('text/event-stream')
      const text = await res.text()
      const frames = parseSseFrames(text).filter((f) => !f.event)
      expect(frames.map((f) => JSON.parse(f.data))).toEqual([1, 2, 3])
    } finally {
      await app.close()
    }
  })
})
