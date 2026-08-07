/**
 * HTTP/SSE streaming projection — SPEC §11.
 *
 * Projects an `ApiStream` from the Layer harness onto an HTTP response using
 * Server-Sent Events (SSE).
 *
 * §11 in-band error table (HTTP SSE column):
 *   before first chunk → normal §9 HTTP status (e.g. 400 / 500)
 *   after  first chunk → terminal `event: error` frame carrying the ApiError
 *
 * SSE frame format (per WHATWG EventSource spec):
 *   ```
 *   event: data\n
 *   data: <JSON>\n
 *   \n
 *   ```
 *   (the `event:` field is omitted for ordinary data frames per SSE convention,
 *   but included for the terminal `event: error` frame so clients can distinguish)
 *
 * Cancellation: when the client disconnects, Fastify fires `request.raw`'s
 * `'close'` event.  We honour this via an `AbortController` that signals the
 * Layer harness stream to stop production cleanly (end path, not error — §11).
 *
 * serve-core migration (fastify-adapter): `sendStreamSse` is now WIRED LIVE —
 * the `FastifyTransportAdapter.writeResult` (`./run.ts`) calls it whenever a
 * dispatched op resolves to an `ApiStream` (`isApiStream(result)`), projecting
 * a `streaming:true` op to SSE ([fix:streaming-wired], DEBT-APIGEN-SERVE-CORE-
 * 002 fastify half). Before the migration this function had ZERO call sites and
 * a streaming result was mis-serialized through `JSON.stringify`.
 *
 * Consumer path (in `run.ts`'s `writeResult`):
 *
 * ```ts
 * if (isApiStream(result)) {
 *   await sendStreamSse(result as ApiStream<unknown>, req, reply)
 *   return
 * }
 * ```
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { ApiError, isApiError } from '@adhd/apigen-base-errors';
import type { ApiStream } from '@adhd/apigen-engine-runtime';

// ---------------------------------------------------------------------------
// SSE frame helpers
// ---------------------------------------------------------------------------

/** Formats a single SSE data frame (no event: label — plain chunk). */
function sseDataFrame(json: string): string {
  return `data: ${json}\n\n`;
}

/** Formats a terminal `event: error` SSE frame (§11 after-first-chunk carrier). */
function sseErrorFrame(json: string): string {
  return `event: error\ndata: ${json}\n\n`;
}

// ---------------------------------------------------------------------------
// sendStreamSse — the SSE projection entry-point
// ---------------------------------------------------------------------------

/**
 * Stream `apiStream` to the HTTP response as SSE.
 *
 * Sets `Content-Type: text/event-stream` and `Transfer-Encoding: chunked`.
 * Each chunk is serialised as a `data: <JSON>\n\n` SSE frame.
 *
 * Error handling:
 * - before first chunk: the reply status is set to the `ApiError` HTTP status
 *   (or 500) and the body is the `ApiError` JSON (normal §9 path).
 * - after first chunk: a terminal `event: error\ndata: <JSON>\n\n` frame is
 *   flushed and the response is ended (Connect semantics).
 *
 * Cancellation: when the client disconnects (`req.raw` emits `'close'`), the
 * in-flight stream is aborted via an internal `AbortController`.  The stream
 * terminates cleanly (end path — §11).
 *
 * @param stream  - the `ApiStream` from the harness
 * @param req     - the Fastify request (used for client-disconnect detection)
 * @param reply   - the Fastify reply (raw `res` is used for direct writes)
 */
export async function sendStreamSse(
  stream: ApiStream<unknown>,
  req: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Internal cancellation controller: fired on client disconnect.
  const ac = new AbortController();

  // Listen for client disconnect and abort the stream.
  req.raw.once('close', () => ac.abort());

  const raw = reply.raw;
  let firstChunkSent = false;

  try {
    for await (const chunk of stream) {
      if (ac.signal.aborted) break; // client disconnected — clean end

      if (!firstChunkSent) {
        // Send SSE headers before the first chunk.
        raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Transfer-Encoding': 'chunked',
        });
        firstChunkSent = true;
      }

      raw.write(sseDataFrame(JSON.stringify(chunk)));
    }

    if (firstChunkSent) {
      // Stream ended cleanly — close the response.
      raw.end();
    } else {
      // No chunks emitted and no error: empty stream.  Send an empty 200 SSE.
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      raw.end();
    }
  } catch (err) {
    // Duck-type, not `instanceof ApiError` (BUG-APIGEN-STREAM-ERROR-CODE-
    // MISCLASSIFY-001) — see `isApiError`'s doc comment in apigen-base-errors.
    // An ApiError thrown across the runtime's bundled-dist boundary is a
    // distinct class instance, so `instanceof` collapses its real code (e.g.
    // `not_found`) to the `internal` fallback below.
    const apiError = isApiError(err)
      ? err
      : new ApiError(
          'internal',
          err instanceof Error ? err.message : String(err)
        );

    if (!firstChunkSent) {
      // Before first chunk: normal §9 HTTP error status.
      const httpStatus = _httpStatusForCode(apiError.code);
      raw.writeHead(httpStatus, { 'Content-Type': 'application/json' });
      raw.end(JSON.stringify(apiError.toJSON()));
    } else {
      // After first chunk: in-band terminal `event: error` SSE frame (§11).
      raw.write(sseErrorFrame(JSON.stringify(apiError.toJSON())));
      raw.end();
    }
  }

  // Tell Fastify the reply has been handled via raw writes — suppress its
  // own serialisation.
  reply.hijack();
}

// ---------------------------------------------------------------------------
// Internal: map ApiErrorCode to HTTP status (mirrors @adhd/apigen-base-errors HTTP_STATUS)
// ---------------------------------------------------------------------------

const _STATUS_MAP: Record<string, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  internal: 500,
};

function _httpStatusForCode(code: string): number {
  return _STATUS_MAP[code] ?? 500;
}
