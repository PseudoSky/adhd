/**
 * @adhd/resilience-core-tripwire: a persistent kill-switch latch with a
 * lock-file protocol, fail-closed reads, an NDJSON audit trail and a
 * break-glass clear. Single entry point (no subpath exports).
 *
 * The runtime surface is pinned by test/unit/api-surface.spec.ts: the
 * tripwire API of the package specification plus the storage, memory-fs
 * and Node adapters (`createFileStorage`, `createMemoryStorage`,
 * `createNodeFs`, `createMemoryFs`) a caller needs to run it on a real disk
 * or in a test.
 * The interactive and CLI surface (interactiveGate, confirmSolved,
 * runUnlockCli, renderStatusText, statusJsonLine) takes an injected
 * `TripwireIo`; nodeTripwireIo is the single Node adapter of it.
 */
export { createTripwire } from './lib/tripwire.js';
export { adhdDataDir } from './lib/paths.js';
export { CONFIRM_TOKEN } from './lib/types.js';
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
  createFileStorage,
  createMemoryStorage,
  createNodeFs,
} from './lib/storage.js';
export type {
  FileStorageOptions,
  MemoryTripwireStorage,
  TripwireStorage,
} from './lib/storage.js';
export type { TripwireIo } from './lib/io.js';
export { confirmSolved, interactiveGate } from './lib/interactive.js';
export type {
  ConfirmSolvedOptions,
  HitlInfo,
  InteractiveGateOptions,
  InteractiveOptions,
} from './lib/interactive.js';
export { runUnlockCli } from './lib/cli.js';
export type { UnlockCliOptions, UnlockExitCode } from './lib/cli.js';
export { renderStatusText, statusJsonLine } from './lib/render.js';
export { nodeTripwireIo } from './lib/node-io.js';
export type { NodeIoInput, NodeTripwireIoOptions } from './lib/node-io.js';
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
