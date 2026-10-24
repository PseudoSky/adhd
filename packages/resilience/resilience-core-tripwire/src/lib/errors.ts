/**
 * Typed errors. Every error carries a stable `code` from
 * {@link TRIPWIRE_ERROR_CODES} and the brand
 * `Symbol.for('adhd.tripwire.error')`, so `isTripwireError` and
 * `isTripwireTrippedError` recognise errors thrown by a duplicate copy of
 * this package (where `instanceof` would fail).
 */
import type { TripwireRecord } from './types.js';

/** The brand every tripwire error carries (a registry symbol). */
export const TRIPWIRE_ERROR_BRAND: unique symbol = Symbol.for(
  'adhd.tripwire.error',
);

/** The closed registry of error codes. */
export const TRIPWIRE_ERROR_CODES = [
  'TRIPWIRE_TRIPPED',
  'TRIPWIRE_CONFIRM_REQUIRED',
  'TRIPWIRE_INVALID_KEY',
  'TRIPWIRE_IO',
  'TRIPWIRE_ABORTED',
] as const;

/** The union of the stable tripwire error codes in `TRIPWIRE_ERROR_CODES`. */
export type TripwireErrorCode = (typeof TRIPWIRE_ERROR_CODES)[number];

const CODE_SET: ReadonlySet<string> = new Set(TRIPWIRE_ERROR_CODES);

/** Base class of every error this package throws. */
export class TripwireError extends Error {
  readonly code: TripwireErrorCode;
  readonly [TRIPWIRE_ERROR_BRAND]: true;

  constructor(code: TripwireErrorCode, message: string) {
    super(message);
    this.code = code;
    this[TRIPWIRE_ERROR_BRAND] = true;
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Extra in-memory fields `fromRecord` can attach. */
export interface TrippedErrorExtra {
  /** HTTP status of the response that tripped (memory only). */
  responseStatus?: number;
  /** Parsed body of the response that tripped (memory only). */
  responseBody?: unknown;
  /** Overrides the record's recovery hint. */
  recoveryHint?: string;
}

/** Fields of a {@link TripwireTrippedError}. */
export interface TrippedErrorInit {
  key: string;
  reason: string;
  trippedAt: Date;
  record?: TripwireRecord;
  recoveryHint?: string;
}

const GENERIC_HINT =
  'Investigate the cause, then clear the tripwire with the clear method ' +
  'of its policy.';

/** Thrown by `assertOpen` (and consumers) while a key is tripped. */
export class TripwireTrippedError extends TripwireError {
  readonly key: string;
  readonly reason: string;
  readonly trippedAt: Date;
  readonly record?: TripwireRecord;
  readonly recoveryHint: string;
  /** HTTP status of the response that tripped; never persisted. */
  declare responseStatus?: number;
  /** Response body that tripped; non-enumerable, never persisted. */
  declare responseBody?: unknown;

  constructor(init: TrippedErrorInit) {
    const hint = init.recoveryHint ?? GENERIC_HINT;
    const at = Number.isNaN(init.trippedAt.getTime()) ?
      String(init.trippedAt) :
      init.trippedAt.toISOString();
    super(
      'TRIPWIRE_TRIPPED',
      `Tripwire "${init.key}" is tripped (${init.reason}) since ${at}. ` +
        hint,
    );
    this.key = init.key;
    this.reason = init.reason;
    this.trippedAt = init.trippedAt;
    if (init.record) this.record = init.record;
    this.recoveryHint = hint;
  }

  /** Build the error from a record, attaching memory-only response data. */
  static fromRecord(
    record: TripwireRecord,
    extra: TrippedErrorExtra = {},
  ): TripwireTrippedError {
    const err = new TripwireTrippedError({
      key: record.key,
      reason: record.reason,
      trippedAt: new Date(record.trippedAt),
      record,
      recoveryHint: extra.recoveryHint ?? record.recoveryHint,
    });
    if (extra.responseStatus !== undefined) {
      err.responseStatus = extra.responseStatus;
    }
    if (extra.responseBody !== undefined) {
      Object.defineProperty(err, 'responseBody', {
        value: extra.responseBody,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    }
    return err;
  }

  /** JSON form: never includes `responseBody` or the record context. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      key: this.key,
      reason: this.reason,
      trippedAt: this.trippedAt,
      recoveryHint: this.recoveryHint,
      responseStatus: this.responseStatus,
    };
  }
}

/** A clear under the `confirm-token` policy lacked the right token. */
export class TripwireConfirmError extends TripwireError {
  readonly key: string;

  constructor(key: string, message?: string) {
    super(
      'TRIPWIRE_CONFIRM_REQUIRED',
      message ??
        `Clearing tripwire "${key}" requires the confirm token ` +
          `(policy confirm-token).`,
    );
    this.key = key;
  }
}

/** A key failed validation; thrown before any file-system access. */
export class TripwireKeyError extends TripwireError {
  readonly key: string;

  constructor(key: unknown) {
    const shown = JSON.stringify(String(key)).slice(0, 80);
    super(
      'TRIPWIRE_INVALID_KEY',
      `Invalid tripwire key ${shown}: expected ` +
        '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$',
    );
    this.key = String(key);
  }
}

/** A file-system operation failed where the caller must know. */
export class TripwireIoError extends TripwireError {
  readonly cause: unknown;
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super('TRIPWIRE_IO', `Tripwire ${operation} failed: ${detail}`);
    this.operation = operation;
    this.cause = cause;
  }
}

/** A human aborted an interactive gate (or no TTY was available). */
export class TripwireAbortedError extends TripwireError {
  readonly key?: string;

  constructor(message = 'HITL aborted by user', key?: string) {
    super('TRIPWIRE_ABORTED', message);
    if (key !== undefined) this.key = key;
  }
}

function branded(e: unknown): e is Record<PropertyKey, unknown> {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as Record<PropertyKey, unknown>)[TRIPWIRE_ERROR_BRAND] === true
  );
}

/**
 * True for any tripwire error, including one from a duplicate copy of the
 * package: checks the registry brand and a registry code, not `instanceof`.
 */
export function isTripwireError(e: unknown): e is TripwireError {
  return branded(e) && typeof e['code'] === 'string' && CODE_SET.has(e['code']);
}

/** True for a tripped error from any copy of the package. */
export function isTripwireTrippedError(
  e: unknown,
): e is TripwireTrippedError {
  return isTripwireError(e) && e.code === 'TRIPWIRE_TRIPPED';
}
