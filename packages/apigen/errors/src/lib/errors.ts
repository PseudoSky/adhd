/**
 * @adhd/apigen-errors
 *
 * Canonical error taxonomy for apigen — §9.1 of the apigen SPEC.
 *
 * Exports:
 *  - `ApiErrorCode`   — the gRPC-style canonical code set (string union + const object)
 *  - `ApiError`       — the thrown error class carrying code + message + details
 *  - `HTTP_STATUS`    — code → HTTP status code map
 *  - `GRPC_CODE`      — code → gRPC status code name map
 *  - `CLI_EXIT_CODE`  — code → CLI process exit code map
 *  - `MCP_ERROR_KIND` — code → MCP error shape indicator ('error')
 *  - `statusMaps`     — convenience bundle of all four maps
 *  - `StreamingPhase` — 'before-first-chunk' | 'after-first-chunk' discriminant
 *  - `StreamingErrorCarrier` — discriminated union: how an in-flight stream delivers a terminal error
 *  - `toStreamingError` — factory that wraps an ApiError into the correct carrier for the phase
 */

// ---------------------------------------------------------------------------
// §9 — Canonical error code set (gRPC-style)
// ---------------------------------------------------------------------------

/** The five gRPC-style canonical error codes recognised by apigen. */
export const ERROR_CODES = [
  'invalid_argument',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'internal',
] as const;

/** String-union type for the canonical error codes. */
export type ApiErrorCode = (typeof ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// §9.1 — Per-transport status maps  (normative — must mirror the SPEC table)
// ---------------------------------------------------------------------------

/** Maps each canonical code to its HTTP status code. */
export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  internal: 500,
} as const;

/** Maps each canonical code to its gRPC status name. */
export const GRPC_CODE: Record<ApiErrorCode, string> = {
  invalid_argument: 'INVALID_ARGUMENT',
  unauthenticated: 'UNAUTHENTICATED',
  permission_denied: 'PERMISSION_DENIED',
  not_found: 'NOT_FOUND',
  internal: 'INTERNAL',
} as const;

/** Maps each canonical code to its CLI process exit code. */
export const CLI_EXIT_CODE: Record<ApiErrorCode, number> = {
  invalid_argument: 2,
  unauthenticated: 3,
  permission_denied: 3,
  not_found: 4,
  internal: 1,
} as const;

/**
 * MCP surfaces all apigen errors as the MCP `error` result kind.
 * Maps each canonical code to the MCP error shape indicator.
 */
export const MCP_ERROR_KIND: Record<ApiErrorCode, 'error'> = {
  invalid_argument: 'error',
  unauthenticated: 'error',
  permission_denied: 'error',
  not_found: 'error',
  internal: 'error',
} as const;

/** Convenience bundle: all four transport maps keyed by transport name. */
export const statusMaps = {
  http: HTTP_STATUS,
  grpc: GRPC_CODE,
  cli: CLI_EXIT_CODE,
  mcp: MCP_ERROR_KIND,
} as const;

// ---------------------------------------------------------------------------
// ApiError — the thrown error class
// ---------------------------------------------------------------------------

/**
 * The canonical apigen error.  Every transport adapter catches this and maps
 * `code` to the native status using the tables above.
 */
export class ApiError extends Error {
  /** gRPC-style canonical error code. */
  readonly code: ApiErrorCode;
  /** Optional structured details (passed through to MCP / HTTP body). */
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
    // Maintain correct prototype chain when transpiling to ES5.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** Serialise to a plain object suitable for JSON transport. */
  toJSON(): { code: ApiErrorCode; message: string; details?: unknown } {
    const out: { code: ApiErrorCode; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

// ---------------------------------------------------------------------------
// §11 — Streaming error-after-first-chunk carrier
// ---------------------------------------------------------------------------

/**
 * Discriminant that records whether the first chunk was already flushed.
 * Determines the carrier shape used to deliver a terminal stream error.
 */
export type StreamingPhase = 'before-first-chunk' | 'after-first-chunk';

/**
 * Carrier for a terminal streaming error **before** the first chunk was sent.
 * Adapters handle this identically to a normal (non-streaming) §9 error.
 */
export interface BeforeFirstChunkError {
  readonly phase: 'before-first-chunk';
  /** The underlying canonical error. */
  readonly error: ApiError;
}

/**
 * Carrier for a terminal streaming error **after** the first chunk was flushed.
 * The status line is already gone; error must be delivered in-band per transport:
 *
 * | Transport        | Mechanism                                            |
 * |------------------|------------------------------------------------------|
 * | HTTP SSE/chunked | terminal `event: error` frame carrying the ApiError  |
 * | gRPC             | trailing status (native gRPC trailers)                |
 * | MCP              | progressive error notification                       |
 * | CLI              | flush partial stdout, write ApiError to stderr, exit |
 */
export interface AfterFirstChunkError {
  readonly phase: 'after-first-chunk';
  /** The underlying canonical error, to be delivered in-band. */
  readonly error: ApiError;
  /**
   * The number of chunks successfully delivered before the error occurred.
   * Informational — lets CLI adapters decide whether stdout has content.
   */
  readonly chunksDelivered: number;
}

/** Discriminated union of the two streaming error carrier shapes. */
export type StreamingErrorCarrier = BeforeFirstChunkError | AfterFirstChunkError;

/**
 * Factory: wrap an `ApiError` in the appropriate streaming carrier.
 *
 * @param phase           - whether the first chunk was already flushed
 * @param error           - the terminal error
 * @param chunksDelivered - (after-first-chunk only) chunks sent before failure
 */
export function toStreamingError(
  phase: 'before-first-chunk',
  error: ApiError,
): BeforeFirstChunkError;
export function toStreamingError(
  phase: 'after-first-chunk',
  error: ApiError,
  chunksDelivered: number,
): AfterFirstChunkError;
export function toStreamingError(
  phase: StreamingPhase,
  error: ApiError,
  chunksDelivered = 0,
): StreamingErrorCarrier {
  if (phase === 'before-first-chunk') {
    return { phase, error } satisfies BeforeFirstChunkError;
  }
  return { phase, error, chunksDelivered } satisfies AfterFirstChunkError;
}

/**
 * Type guard: narrows a `StreamingErrorCarrier` to `BeforeFirstChunkError`.
 */
export function isBeforeFirstChunk(c: StreamingErrorCarrier): c is BeforeFirstChunkError {
  return c.phase === 'before-first-chunk';
}

/**
 * Type guard: narrows a `StreamingErrorCarrier` to `AfterFirstChunkError`.
 */
export function isAfterFirstChunk(c: StreamingErrorCarrier): c is AfterFirstChunkError {
  return c.phase === 'after-first-chunk';
}
