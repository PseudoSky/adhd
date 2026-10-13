/**
 * @adhd/resilience-core-tripwire: a persistent kill-switch latch with a
 * lock-file protocol, fail-closed reads, an NDJSON audit trail and a
 * break-glass clear. Single entry point (no subpath exports).
 */
export { createTripwire, defaultRecoveryHint } from './lib/tripwire.js';
export { adhdDataDir } from './lib/paths.js';
export { CLEAR_METHODS, CONFIRM_TOKEN } from './lib/types.js';
export type {
  AuditEvent,
  AuditEventName,
  ClearMethod,
  ClearOptions,
  GateResult,
  JsonValue,
  KnownTripReason,
  PriorClear,
  Redactor,
  StatusOptions,
  TripContext,
  TripInput,
  TripResult,
  Tripwire,
  TripwireOptions,
  TripwireRecord,
  TripwireSnapshot,
  TripwireStatus,
  TripwireWarning,
} from './lib/types.js';
export { defaultRedactor } from './lib/redact.js';
export {
  TRIPWIRE_ERROR_BRAND,
  TRIPWIRE_ERROR_CODES,
  TripwireAbortedError,
  TripwireConfirmError,
  TripwireError,
  TripwireIoError,
  TripwireKeyError,
  TripwireTrippedError,
  isTripwireError,
  isTripwireTrippedError,
} from './lib/errors.js';
export type {
  TripwireErrorCode,
  TrippedErrorExtra,
  TrippedErrorInit,
} from './lib/errors.js';
export {
  TRIPWIRE_KEY_PATTERN,
  createFileStorage,
  createMemoryStorage,
  createNodeFs,
} from './lib/storage.js';
export type {
  FileStorageOptions,
  MemoryTripwireStorage,
  TripwireStorage,
} from './lib/storage.js';
export { createMemoryFs } from './lib/memory-fs.js';
export type {
  FsFailureRule,
  FsFileHandle,
  FsOpName,
  FsOpRecord,
  FsPort,
  FsStat,
  MemoryFs,
  MemoryFsOptions,
  SchedulePicker,
} from './lib/memory-fs.js';
export {
  AUDIT_LINE_MAX_BYTES,
  DEFAULT_MAX_AUDIT_BYTES,
  MIN_AUDIT_BYTES,
} from './lib/audit.js';
