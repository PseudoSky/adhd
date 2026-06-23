/**
 * @adhd/apigen-errors — test suite (§9.1 transport status maps + §11 streaming carrier)
 *
 * Guard: `npx nx test apigen-errors`
 *
 * Every mapping assertion is written so that a wrong value in the source table
 * causes a RED test.  Negative-control comments mark the value that would slip
 * past a trivially-wrong assertion.
 */

import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  HTTP_STATUS,
  GRPC_CODE,
  CLI_EXIT_CODE,
  MCP_ERROR_KIND,
  statusMaps,
  ApiError,
  toStreamingError,
  isBeforeFirstChunk,
  isAfterFirstChunk,
} from './errors';

// ---------------------------------------------------------------------------
// §9.1 — canonical code set
// ---------------------------------------------------------------------------

describe('ERROR_CODES', () => {
  it('contains exactly the five SPEC-mandated codes', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'internal',
        'invalid_argument',
        'not_found',
        'permission_denied',
        'unauthenticated',
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// §9.1 — HTTP status map
// ---------------------------------------------------------------------------

describe('HTTP_STATUS', () => {
  /**
   * SPEC §9.1 table (normative):
   * invalid_argument → 400, unauthenticated → 401, permission_denied → 403,
   * not_found → 404, internal → 500
   *
   * Negative controls documented inline — any swap causes red.
   */

  it('maps invalid_argument → 400 (not 422, not 500)', () => {
    expect(HTTP_STATUS['invalid_argument']).toBe(400);
  });

  it('maps unauthenticated → 401 (not 403, not 400)', () => {
    expect(HTTP_STATUS['unauthenticated']).toBe(401);
  });

  it('maps permission_denied → 403 (not 401, not 404)', () => {
    expect(HTTP_STATUS['permission_denied']).toBe(403);
  });

  it('maps not_found → 404 (not 400, not 410)', () => {
    expect(HTTP_STATUS['not_found']).toBe(404);
  });

  it('maps internal → 500 (not 502, not 503)', () => {
    expect(HTTP_STATUS['internal']).toBe(500);
  });

  it('covers every code in ERROR_CODES — no missing key', () => {
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS).toHaveProperty(code);
      expect(typeof HTTP_STATUS[code]).toBe('number');
    }
  });

  it('wrong mapping would fail — negative control sanity check', () => {
    // permission_denied must NOT be 401 (that is unauthenticated)
    expect(HTTP_STATUS['permission_denied']).not.toBe(401);
    // unauthenticated must NOT be 403
    expect(HTTP_STATUS['unauthenticated']).not.toBe(403);
  });
});

// ---------------------------------------------------------------------------
// §9.1 — gRPC code map
// ---------------------------------------------------------------------------

describe('GRPC_CODE', () => {
  it('maps invalid_argument → INVALID_ARGUMENT (not INTERNAL)', () => {
    expect(GRPC_CODE['invalid_argument']).toBe('INVALID_ARGUMENT');
  });

  it('maps unauthenticated → UNAUTHENTICATED (not PERMISSION_DENIED)', () => {
    expect(GRPC_CODE['unauthenticated']).toBe('UNAUTHENTICATED');
  });

  it('maps permission_denied → PERMISSION_DENIED (not UNAUTHENTICATED)', () => {
    expect(GRPC_CODE['permission_denied']).toBe('PERMISSION_DENIED');
  });

  it('maps not_found → NOT_FOUND (not UNAVAILABLE)', () => {
    expect(GRPC_CODE['not_found']).toBe('NOT_FOUND');
  });

  it('maps internal → INTERNAL (not UNKNOWN)', () => {
    expect(GRPC_CODE['internal']).toBe('INTERNAL');
  });

  it('covers every code in ERROR_CODES — no missing key', () => {
    for (const code of ERROR_CODES) {
      expect(GRPC_CODE).toHaveProperty(code);
      expect(typeof GRPC_CODE[code]).toBe('string');
    }
  });

  it('wrong mapping would fail — negative control sanity check', () => {
    // internal must NOT be INVALID_ARGUMENT
    expect(GRPC_CODE['internal']).not.toBe('INVALID_ARGUMENT');
    // not_found must NOT be INTERNAL
    expect(GRPC_CODE['not_found']).not.toBe('INTERNAL');
  });
});

// ---------------------------------------------------------------------------
// §9.1 — CLI exit code map
// ---------------------------------------------------------------------------

describe('CLI_EXIT_CODE', () => {
  /**
   * SPEC §9.1 table:
   * invalid_argument → 2, unauthenticated → 3, permission_denied → 3,
   * not_found → 4, internal → 1
   */

  it('maps invalid_argument → 2 (not 1, not 3)', () => {
    expect(CLI_EXIT_CODE['invalid_argument']).toBe(2);
  });

  it('maps unauthenticated → 3 (not 1, not 2)', () => {
    expect(CLI_EXIT_CODE['unauthenticated']).toBe(3);
  });

  it('maps permission_denied → 3 (not 1, not 4) — same exit as unauthenticated', () => {
    expect(CLI_EXIT_CODE['permission_denied']).toBe(3);
  });

  it('maps not_found → 4 (not 2, not 1)', () => {
    expect(CLI_EXIT_CODE['not_found']).toBe(4);
  });

  it('maps internal → 1 (not 2, not 0)', () => {
    expect(CLI_EXIT_CODE['internal']).toBe(1);
  });

  it('covers every code in ERROR_CODES — no missing key', () => {
    for (const code of ERROR_CODES) {
      expect(CLI_EXIT_CODE).toHaveProperty(code);
      expect(typeof CLI_EXIT_CODE[code]).toBe('number');
    }
  });

  it('no code maps to 0 (zero exit = success, never an error)', () => {
    for (const code of ERROR_CODES) {
      expect(CLI_EXIT_CODE[code]).not.toBe(0);
    }
  });

  it('wrong mapping would fail — negative control sanity check', () => {
    // internal must NOT be 2 (that is invalid_argument)
    expect(CLI_EXIT_CODE['internal']).not.toBe(2);
    // not_found must NOT be 3
    expect(CLI_EXIT_CODE['not_found']).not.toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §9.1 — MCP error kind map
// ---------------------------------------------------------------------------

describe('MCP_ERROR_KIND', () => {
  it('every code maps to the MCP "error" kind', () => {
    for (const code of ERROR_CODES) {
      expect(MCP_ERROR_KIND[code]).toBe('error');
    }
  });

  it('covers every code in ERROR_CODES — no missing key', () => {
    for (const code of ERROR_CODES) {
      expect(MCP_ERROR_KIND).toHaveProperty(code);
    }
  });
});

// ---------------------------------------------------------------------------
// statusMaps convenience bundle
// ---------------------------------------------------------------------------

describe('statusMaps', () => {
  it('bundles http, grpc, cli, mcp maps under the correct keys', () => {
    expect(statusMaps.http).toBe(HTTP_STATUS);
    expect(statusMaps.grpc).toBe(GRPC_CODE);
    expect(statusMaps.cli).toBe(CLI_EXIT_CODE);
    expect(statusMaps.mcp).toBe(MCP_ERROR_KIND);
  });
});

// ---------------------------------------------------------------------------
// ApiError class
// ---------------------------------------------------------------------------

describe('ApiError', () => {
  it('is an instance of Error', () => {
    const err = new ApiError('not_found', 'resource missing');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
  });

  it('carries code and message', () => {
    const err = new ApiError('invalid_argument', 'bad input');
    expect(err.code).toBe('invalid_argument');
    expect(err.message).toBe('bad input');
  });

  it('carries optional details when provided', () => {
    const details = { field: 'userId', reason: 'required' };
    const err = new ApiError('invalid_argument', 'bad input', details);
    expect(err.details).toEqual(details);
  });

  it('details is undefined when not provided', () => {
    const err = new ApiError('internal', 'whoops');
    expect(err.details).toBeUndefined();
  });

  it('name is "ApiError"', () => {
    expect(new ApiError('internal', 'x').name).toBe('ApiError');
  });

  it('toJSON omits details when absent', () => {
    const json = new ApiError('not_found', 'missing').toJSON();
    expect(json).toEqual({ code: 'not_found', message: 'missing' });
    expect('details' in json).toBe(false);
  });

  it('toJSON includes details when present', () => {
    const json = new ApiError('internal', 'fail', { trace: 'abc' }).toJSON();
    expect(json).toEqual({ code: 'internal', message: 'fail', details: { trace: 'abc' } });
  });

  it('toJSON code is the canonical code — wrong code would fail', () => {
    const json = new ApiError('unauthenticated', 'no auth').toJSON();
    expect(json.code).toBe('unauthenticated');
    expect(json.code).not.toBe('permission_denied');
  });
});

// ---------------------------------------------------------------------------
// §11 — Streaming error carrier
// ---------------------------------------------------------------------------

describe('toStreamingError / streaming carrier', () => {
  const err = new ApiError('internal', 'stream blew up');

  describe('before-first-chunk', () => {
    it('returns a carrier with phase "before-first-chunk"', () => {
      const carrier = toStreamingError('before-first-chunk', err);
      expect(carrier.phase).toBe('before-first-chunk');
    });

    it('round-trips the ApiError reference', () => {
      const carrier = toStreamingError('before-first-chunk', err);
      expect(carrier.error).toBe(err);
    });

    it('isBeforeFirstChunk returns true', () => {
      expect(isBeforeFirstChunk(toStreamingError('before-first-chunk', err))).toBe(true);
    });

    it('isAfterFirstChunk returns false', () => {
      expect(isAfterFirstChunk(toStreamingError('before-first-chunk', err))).toBe(false);
    });

    it('does NOT have chunksDelivered (wrong phase would fail)', () => {
      const carrier = toStreamingError('before-first-chunk', err);
      // before-first-chunk does not carry chunksDelivered
      expect('chunksDelivered' in carrier).toBe(false);
    });
  });

  describe('after-first-chunk', () => {
    it('returns a carrier with phase "after-first-chunk"', () => {
      const carrier = toStreamingError('after-first-chunk', err, 7);
      expect(carrier.phase).toBe('after-first-chunk');
    });

    it('round-trips the ApiError reference', () => {
      const carrier = toStreamingError('after-first-chunk', err, 3);
      expect(carrier.error).toBe(err);
    });

    it('round-trips chunksDelivered', () => {
      const carrier = toStreamingError('after-first-chunk', err, 42);
      expect(carrier.chunksDelivered).toBe(42);
    });

    it('isAfterFirstChunk returns true', () => {
      expect(isAfterFirstChunk(toStreamingError('after-first-chunk', err, 1))).toBe(true);
    });

    it('isBeforeFirstChunk returns false', () => {
      expect(isBeforeFirstChunk(toStreamingError('after-first-chunk', err, 1))).toBe(false);
    });

    it('wrong chunksDelivered would fail — negative control', () => {
      const carrier = toStreamingError('after-first-chunk', err, 5);
      // if chunksDelivered were 0 instead of 5 this would fail
      expect(carrier.chunksDelivered).not.toBe(0);
      expect(carrier.chunksDelivered).toBe(5);
    });
  });

  describe('phase discriminant is exclusive', () => {
    it('before carrier is not after, after carrier is not before', () => {
      const before = toStreamingError('before-first-chunk', err);
      const after = toStreamingError('after-first-chunk', err, 0);
      expect(before.phase).not.toBe(after.phase);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-transport consistency check
// ---------------------------------------------------------------------------

describe('cross-transport consistency — all codes covered in every map', () => {
  it('every ERROR_CODE has an entry in all four maps', () => {
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS).toHaveProperty(code);
      expect(GRPC_CODE).toHaveProperty(code);
      expect(CLI_EXIT_CODE).toHaveProperty(code);
      expect(MCP_ERROR_KIND).toHaveProperty(code);
    }
  });

  it('HTTP statuses are standard 4xx/5xx (no 2xx slipping in)', () => {
    for (const code of ERROR_CODES) {
      expect(HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(HTTP_STATUS[code]).toBeLessThan(600);
    }
  });

  it('gRPC codes are upper-snake-case strings', () => {
    for (const code of ERROR_CODES) {
      expect(GRPC_CODE[code]).toMatch(/^[A-Z_]+$/);
    }
  });

  it('CLI exit codes are positive integers (no zero, no negative)', () => {
    for (const code of ERROR_CODES) {
      const exit = CLI_EXIT_CODE[code];
      expect(Number.isInteger(exit)).toBe(true);
      expect(exit).toBeGreaterThan(0);
    }
  });
});
