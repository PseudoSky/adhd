/**
 * @adhd/stealth-browser — src/lib/recording/index.ts
 *
 * Barrel of the recording namespace (named exports only, ADR-0003).
 */
export { NetworkRecorder, decodeBody, mergeHeaders, EXTRA_INFO_BUFFER_MAX, EXTRA_INFO_BUFFER_TTL_MS } from './network-recorder.js'
export { CaptureError, CAPTURE_ERROR_CODES, captureError } from './errors.js'
export type { CaptureErrorCode, CaptureErrorInit } from './errors.js'
export { MemoryRecordingSink } from './memory-sink.js'
export { StoreRecordingSink, recordingDdl, envelopeParams, RECORDING_SCHEMA_VERSION, DEFAULT_RECORDING_TABLE } from './store-sink.js'
export type { RecordingStore, StoreRecordingSinkOptions, StoreOwnership } from './store-sink.js'
export { openStoreRecordingSink } from './open-store-sink.js'
export type { OpenStoreRecordingSinkOptions } from './open-store-sink.js'
export { redactHeaders, DEFAULT_REDACTED_HEADERS, REDACTED } from './redact.js'
export type {
  Headers,
  RecordedRequest,
  RecordedResponse,
  RedirectHop,
  RecordedFailure,
  ExchangeState,
  RecordedExchange,
  RecordingEnvelope,
  RecordingSink,
  RecorderOptions,
} from './types.js'
