/**
 * Public types of the tripwire latch.
 *
 * A tripwire is a persistent kill-switch: the first `trip` of a key writes
 * a human-readable lock file; every later `gate` on that key is closed
 * until a human (or an instance with the `open` clear policy) clears it.
 * It never half-opens on its own (unlike a circuit breaker).
 */
import type { FsPort } from './memory-fs.js';
import type { TripwireStorage } from './storage.js';

/** A JSON-serialisable value (what a lock record may carry). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

/** Consumer forensic fields stored in a record (redacted before writing). */
export type TripContext = Record<string, JsonValue>;

/** The literal a `confirm-token` instance requires to clear. */
export const CONFIRM_TOKEN = 'I-UNDERSTAND-THE-RISK' as const;

/** How a tripwire was cleared (recorded on the audit and the marker). */
export type ClearMethod =
  | 'unlock-cli-tty'
  | 'unlock-cli-env'
  | 'programmatic-confirm'
  | 'hitl-clear'
  | 'hitl-retry'
  | 'mcp-clear'
  | 'resolved'
  | 'expired';

/** Every clear method, for runtime validation. */
export const CLEAR_METHODS: readonly ClearMethod[] = [
  'unlock-cli-tty',
  'unlock-cli-env',
  'programmatic-confirm',
  'hitl-clear',
  'hitl-retry',
  'mcp-clear',
  'resolved',
  'expired',
];

/** State of a present lock. `unreadable` counts as tripped. */
export type TripwireStatus = 'tripped' | 'expired' | 'unreadable';

/**
 * Trip reasons seen in the consumers (documentation only: `reason` is any
 * string). `unreadable-lock` is synthesized for a corrupt lock.
 */
export type KnownTripReason =
  | 'http-4xx'
  | 'captcha'
  | 'banned'
  | 'rate_limited'
  | 'login_required'
  | 'unreadable-lock';

/** Annotation of the clear that preceded a trip (from the marker). */
export interface PriorClear {
  clearedAt: string;
  method: ClearMethod;
  actor?: string;
}

/** The forensic record of a trip (the lock file content). */
export interface TripwireRecord<C extends TripContext = TripContext> {
  schema: 1;
  key: string;
  /** Owner of the latch, e.g. `request-builder` or `agent-search`. */
  namespace: string;
  reason: string;
  /** ISO timestamp of the trip. */
  trippedAt: string;
  trippedBy: { pid: number; sessionId?: string; actor?: string };
  /** Legacy in-record count plus the `.blocked` sidecar size. */
  blockedCount: number;
  /** Time of the latest counted block (sidecar mtime). */
  lastBlockedAt?: string;
  /**
   * Random id of this trip (24 hex characters). It scopes the block count,
   * so blocks counted for one trip of a key never leak into the next one.
   * Absent on legacy locks.
   */
  generation?: string;
  priorClear?: PriorClear;
  recoveryHint?: string;
  /** Consumer forensic fields (redacted). */
  context: C;
}

/** Result of `read`. `record` is null only when `status` is `clear`. */
export interface TripwireSnapshot<C extends TripContext = TripContext> {
  status: TripwireStatus | 'clear';
  record: TripwireRecord<C> | null;
  expired: boolean;
}

/** Transforms a context before it is persisted. Must be pure. */
export type Redactor = (context: TripContext) => TripContext;

/** A non-fatal problem (IO failure on a best-effort path). */
export interface TripwireWarning {
  code: 'TRIPWIRE_IO';
  /** The operation that failed, e.g. `trip.persist` or `audit.append`. */
  operation: string;
  message: string;
  key?: string;
  cause?: unknown;
}

/** Options of {@link createTripwire}. */
export interface TripwireOptions {
  /** Owner name written into records and audit lines. */
  namespace: string;
  /** Locks live at `<stateDir>/tripwire/<key>.lock`. */
  stateDir: string;
  /** Audit log path; default `<stateDir>/audit.log`. */
  auditPath?: string;
  /** Audit cap in bytes; default 5 MiB, minimum 100000. */
  maxAuditBytes?: number;
  /** Absent = a lock never expires (the safe default). */
  expiry?: { ttlMs: number };
  /** Default `confirm-token`: clearing needs {@link CONFIRM_TOKEN}. */
  clearPolicy?: 'confirm-token' | 'open';
  /** Correlation id recorded as `trippedBy.sessionId` and on audits. */
  sessionId?: () => string | undefined;
  /** Default actor of trips and clears; default the OS user name. */
  actor?: string;
  /** Composed after the default redactor. */
  redact?: Redactor;
  /** Storage seam; default `createFileStorage` over `fs`. */
  storage?: TripwireStorage;
  /** File-system port; default the Node fs. */
  fs?: FsPort;
  /** Milliseconds since the epoch; default `Date.now`. */
  clock?: () => number;
  /** Receives best-effort failures (never throws into the caller). */
  onWarning?: (w: TripwireWarning) => void;
}

/** Input of `trip`. */
export interface TripInput<C extends TripContext> {
  reason: string;
  context: C;
  recoveryHint?: string;
}

/**
 * Result of `trip`. `created` is false when the key was already tripped
 * (the first record is kept); `persisted` is false when the lock could not
 * be written (the in-memory latch still blocks this process).
 */
export interface TripResult<C extends TripContext> {
  record: TripwireRecord<C>;
  created: boolean;
  persisted: boolean;
}

/** Result of `gate`. */
export interface GateResult<C extends TripContext> {
  open: boolean;
  snapshot: TripwireSnapshot<C>;
}

/** Options of `clear`. */
export interface ClearOptions {
  method: ClearMethod;
  /** Must equal {@link CONFIRM_TOKEN} under the `confirm-token` policy. */
  confirm?: string;
  actor?: string;
  /** The human re-verified the upstream before clearing. */
  reverified?: boolean;
}

/** Options of `status`. */
export interface StatusOptions {
  keys?: readonly string[];
  includeExpired?: boolean;
}

/** The latch. Every method validates the key before any IO. */
export interface Tripwire<C extends TripContext = TripContext> {
  /** Current state; no side effects. */
  read(key: string): Promise<TripwireSnapshot<C>>;
  /** Open or closed; counts and audits a block; removes an expired lock. */
  gate(key: string): Promise<GateResult<C>>;
  /** `gate`, throwing {@link TripwireTrippedError} when closed. */
  assertOpen(key: string): Promise<void>;
  /** Latch the key. Never throws on IO. */
  trip(key: string, input: TripInput<C>): Promise<TripResult<C>>;
  /** Clear under the instance policy. */
  clear(key: string, opts: ClearOptions): Promise<{ cleared: boolean }>;
  /** Success path: audit `tripwire-resolved`, then clear (any policy). */
  resolve(key: string, opts?: { actor?: string }): Promise<void>;
  /** Sparse map of tripped keys (expired hidden unless asked). */
  status(opts?: StatusOptions): Promise<Record<string, TripwireRecord<C>>>;
}

/** Audit event names. */
export type AuditEventName =
  | 'tripwire-fired'
  | 'tripwire-gate-blocked'
  | 'tripwire-cleared'
  | 'tripwire-resolved'
  | 'tripwire-expired'
  | 'tripwire-retripped';

/** One audit line (NDJSON). `context` is never audited. */
export interface AuditEvent {
  ts: string;
  event: AuditEventName;
  key: string;
  namespace: string;
  sessionId?: string;
  actor?: string;
  reason?: string;
  /** On `tripwire-expired`: the reason the lock was originally tripped for (`reason` there is `ttl-expired`). */
  tripReason?: string;
  method?: ClearMethod;
  blockedCount?: number;
  /** Origin and path only: query and fragment are never audited. */
  pageUrl?: string;
  trippedAt?: string;
  durationMs?: number;
  reverified?: boolean;
  priorClear?: PriorClear;
  /** Set when optional fields were dropped to stay under 4 KB. */
  truncated?: boolean;
}
