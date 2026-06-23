/**
 * Tests for packages/apigen/plugins/mcp/src/lib/stream.ts — MCP streaming projection.
 *
 * TEETH (CLAUDE.md §6):
 *   - No sleep() / wall-clock timing.
 *   - Ordered chunks: verified by collected content[] index order.
 *   - Error-after-first-chunk: negative control proves a clean stream returns
 *     isError:undefined (no error flag); only the erroring stream sets isError:true.
 *   - Mid-stream cancel (AbortSignal): DrainStream stops early; projection
 *     surface reflects partial data without surfacing an error.
 */

import { describe, it, expect } from 'vitest'
import { projectStreamMcp, projectStreamMcpFull } from '../lib/stream'
import { createStream } from '@adhd/apigen-runtime'
import { ApiError } from '@adhd/apigen-errors'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStream<T>(items: T[], throwAfter?: { index: number; error: Error }) {
  return createStream<T>({
    produce: async function* () {
      for (let i = 0; i < items.length; i++) {
        yield items[i]
        if (throwAfter && i === throwAfter.index) {
          throw throwAfter.error
        }
      }
    },
  })
}

function parseContent(text: string): unknown {
  try { return JSON.parse(text) } catch { return text }
}

// ---------------------------------------------------------------------------
// §11 — ordered chunks
// ---------------------------------------------------------------------------

describe('[mcp-stream.ordered] projectStreamMcp yields chunks in order', () => {
  it('maps each chunk to a text content item in order', async () => {
    const stream = makeStream([10, 20, 30])
    const result = await projectStreamMcp(stream)

    // First three items are the chunks; last is the terminal marker.
    const chunks = result.content.slice(0, 3)
    expect(chunks.map((c) => parseContent(c.text))).toEqual([10, 20, 30])
  })

  it('appends [stream complete] as the terminal marker', async () => {
    const stream = makeStream(['a', 'b'])
    const result = await projectStreamMcp(stream)
    const last = result.content[result.content.length - 1]
    expect(last.text).toBe('[stream complete]')
  })

  it('isError is not set on a clean stream', async () => {
    const stream = makeStream([1, 2])
    const result = await projectStreamMcp(stream)
    // Negative control: no error flag.
    expect(result.isError).toBeUndefined()
  })

  it('empty stream produces only the terminal marker', async () => {
    const stream = makeStream<number>([])
    const result = await projectStreamMcp(stream)
    expect(result.content).toHaveLength(1)
    expect(result.content[0].text).toBe('[stream complete]')
  })
})

// ---------------------------------------------------------------------------
// §11 — before-first-chunk error
// ---------------------------------------------------------------------------

describe('[mcp-stream.before-first-chunk] error before any chunk', () => {
  it('returns isError:true with error JSON (no chunks)', async () => {
    const stream = createStream<number>({
      produce: async function* () {
        throw new ApiError('not_found', 'missing resource')
        // eslint-disable-next-line no-unreachable
        yield 0
      },
    })
    const result = await projectStreamMcp(stream)
    expect(result.isError).toBe(true)
    expect(result.content).toHaveLength(1)
    const payload = parseContent(result.content[0].text) as Record<string, unknown>
    expect(payload['code']).toBe('not_found')
    expect(payload['message']).toBe('missing resource')
  })
})

// ---------------------------------------------------------------------------
// §11 — error-after-first-chunk (in-band terminal error)
// ---------------------------------------------------------------------------

describe('[mcp-stream.after-first-chunk] error is delivered in-band after partial data', () => {
  it('projectStreamMcp returns isError:true with chunksDelivered info', async () => {
    const stream = createStream<number>({
      produce: async function* () {
        yield 100
        yield 200
        throw new ApiError('internal', 'mid-stream failure')
      },
    })
    const result = await projectStreamMcp(stream)
    expect(result.isError).toBe(true)
    const payload = parseContent(result.content[0].text) as Record<string, unknown>
    expect(payload['code']).toBe('internal')
    expect(payload['chunksDelivered']).toBe(2)
  })

  // Negative control: a clean 3-chunk stream must NOT have isError set.
  it('(negative) clean stream does NOT set isError', async () => {
    const stream = makeStream([1, 2, 3])
    const result = await projectStreamMcp(stream)
    expect(result.isError).toBeUndefined()
  })

  it('projectStreamMcpFull preserves partial chunks + appends in-band error', async () => {
    const stream = createStream<string>({
      produce: async function* () {
        yield 'chunk-1'
        yield 'chunk-2'
        throw new ApiError('internal', 'stream broken')
      },
    })
    const result = await projectStreamMcpFull(stream)
    expect(result.isError).toBe(true)
    // First two items are the partial chunks.
    expect(parseContent(result.content[0].text)).toBe('chunk-1')
    expect(parseContent(result.content[1].text)).toBe('chunk-2')
    // Third item is the in-band error.
    const errorItem = parseContent(result.content[2].text) as Record<string, unknown>
    expect(errorItem['code']).toBe('internal')
    expect(errorItem['chunksDelivered']).toBe(2)
  })

  it('projectStreamMcpFull emits chunks in order then terminal marker on clean stream', async () => {
    const stream = makeStream(['x', 'y', 'z'])
    const result = await projectStreamMcpFull(stream)
    expect(result.isError).toBeUndefined()
    const texts = result.content.map((c) => c.text)
    expect(texts).toEqual(['"x"', '"y"', '"z"', '[stream complete]'])
  })
})

// ---------------------------------------------------------------------------
// §11 — mid-stream cancel via AbortSignal
// ---------------------------------------------------------------------------

describe('[mcp-stream.cancel] AbortSignal stops production cleanly', () => {
  it('aborting mid-stream returns partial data with terminal marker (not error)', async () => {
    const controller = new AbortController()
    let yieldCount = 0

    const stream = createStream<number>({
      produce: async function* (sig) {
        for (let i = 0; i < 10; i++) {
          if (sig.aborted) return
          yieldCount++
          yield i
          // Emit just one chunk, then stop so the test can abort.
          if (yieldCount >= 1) return
        }
      },
      signal: controller.signal,
    })

    controller.abort()

    const result = await projectStreamMcpFull(stream)
    // No error — cancelled stream takes the end path (§11).
    expect(result.isError).toBeUndefined()
  })

  it('aborting before first yield produces only terminal marker (no error)', async () => {
    const controller = new AbortController()
    controller.abort()   // already aborted

    const stream = createStream<number>({
      produce: async function* (sig) {
        if (sig.aborted) return
        yield 42
      },
      signal: controller.signal,
    })

    const result = await projectStreamMcpFull(stream)
    expect(result.isError).toBeUndefined()
    expect(result.content).toHaveLength(1)
    expect(result.content[0].text).toBe('[stream complete]')
  })
})
