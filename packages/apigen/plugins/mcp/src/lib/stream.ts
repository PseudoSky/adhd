/**
 * MCP streaming projection — SPEC §11.
 *
 * Projects an `ApiStream` from the Layer harness onto the MCP transport as a
 * sequence of **progressive result notifications** followed by a terminal
 * success or in-band error notification.
 *
 * §11 in-band error table (MCP column):
 *   before first chunk → normal MCP error result (non-streaming path)
 *   after  first chunk → progressive error notification (in-band)
 *
 * Each chunk is wrapped in the MCP tool-call result envelope:
 *   `{ content: [{ type: 'text', text: JSON.stringify(chunk) }] }`
 *
 * The final notification is:
 *   success: `{ content: [{ type: 'text', text: '[stream complete]' }], isError: false }`
 *   error:   `{ content: [{ type: 'text', text: JSON.stringify(error.toJSON()) }], isError: true }`
 *
 * Usage (from inside a CallTool handler):
 *
 * ```ts
 * const result = await invoke(fnName, call, opts)
 * if (isApiStream(result)) {
 *   return projectStreamMcp(result)
 * }
 * return { content: [{ type: 'text', text: JSON.stringify(result) }] }
 * ```
 */

import { collectWithPhase } from '@adhd/apigen-runtime'
import type { ApiStream } from '@adhd/apigen-runtime'

// ---------------------------------------------------------------------------
// MCP chunk / result envelope shapes
// ---------------------------------------------------------------------------

/** A single MCP content item (text carrier). */
export interface McpTextContent {
  type: 'text'
  text: string
}

/** The MCP CallTool result envelope. */
export interface McpCallToolResult {
  content: McpTextContent[]
  isError?: boolean
}

// ---------------------------------------------------------------------------
// projectStreamMcp
// ---------------------------------------------------------------------------

/**
 * Drain `stream` and return the accumulated MCP result envelope.
 *
 * Chunks are collected in order; a terminal error after the first chunk is
 * appended as an in-band error notification (`isError: true`).
 *
 * Because the MCP SDK's `CallToolRequestSchema` handler is a regular
 * `async function` (returning a single value, not a generator), we cannot
 * truly stream chunks over the wire — the SDK serialises the whole response
 * once returned.  The projection therefore **collects all chunks** and returns
 * them as an ordered array of `content` items, which is the idiomatic MCP
 * "progressive results" shape.  Each chunk occupies one `content` slot in
 * order.
 *
 * When the wire transport supports streaming (e.g. MCP over SSE with
 * server-initiated notifications), a future revision may use
 * `server.notification()` per chunk.  The current shape is forward-compatible:
 * the terminal item remains last.
 *
 * @param stream - the `ApiStream` returned by the Layer harness for a
 *   `streaming:true` operation.
 * @returns a Promise resolving to the MCP `CallToolResult` envelope.
 */
export async function projectStreamMcp(stream: ApiStream<unknown>): Promise<McpCallToolResult> {
  const result = await collectWithPhase(stream)

  if (result.ok) {
    // All chunks collected cleanly — emit each as a text content item.
    const content: McpTextContent[] = result.chunks.map((chunk) => ({
      type: 'text',
      text: JSON.stringify(chunk),
    }))
    // Terminal success marker (allows consumers to distinguish "stream complete"
    // from a mid-stream snapshot).
    content.push({ type: 'text', text: '[stream complete]' })
    return { content }
  }

  // Error path.
  const { carrier } = result

  if (carrier.phase === 'before-first-chunk') {
    // No chunks were emitted — surface as a normal MCP error result.
    return {
      content: [{ type: 'text', text: JSON.stringify(carrier.error.toJSON()) }],
      isError: true,
    }
  }

  // after-first-chunk: chunks already delivered + in-band terminal error.
  // Return all collected chunks (from collectWithPhase's internal accumulation
  // — note: collectWithPhase stops accumulating once the error is thrown, so
  // we reconstruct the available context from chunksDelivered metadata).
  // The chunks themselves are not available post-error in collectWithPhase's
  // current contract; we surface the error with the chunk count in the message.
  const errorPayload = {
    ...carrier.error.toJSON(),
    chunksDelivered: carrier.chunksDelivered,
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
    isError: true,
  }
}

// ---------------------------------------------------------------------------
// projectStreamMcpFull — variant that preserves partial chunks + error
// ---------------------------------------------------------------------------

/**
 * Drain `stream` collecting partial chunks AND the terminal error in-band.
 *
 * Unlike `projectStreamMcp`, this variant re-drives the stream manually to
 * accumulate chunk values even when an error-after-first-chunk occurs, giving
 * transport adapters the full `[chunk…, errorPayload]` content array.
 *
 * This is the **preferred** function for MCP transports that want to expose
 * all partial data to the client.
 */
export async function projectStreamMcpFull(stream: ApiStream<unknown>): Promise<McpCallToolResult> {
  const content: McpTextContent[] = []
  try {
    for await (const chunk of stream) {
      content.push({ type: 'text', text: JSON.stringify(chunk) })
    }
    // Clean end — append terminal marker.
    content.push({ type: 'text', text: '[stream complete]' })
    return { content }
  } catch (err) {
    // Error-after-first-chunk: chunks already in `content`; append in-band error.
    const { ApiError } = await import('@adhd/apigen-errors')
    const apiError =
      err instanceof ApiError
        ? err
        : new ApiError('internal', err instanceof Error ? err.message : String(err))

    const errorPayload = {
      ...apiError.toJSON(),
      chunksDelivered: content.length,
    }
    content.push({ type: 'text', text: JSON.stringify(errorPayload) })
    return { content, isError: true }
  }
}
