import { createPlugin } from './lib/plugin.js';

export { createPlugin, TracingPlugin, PLUGIN_NAME, SNAPSHOT_SECTION } from './lib/plugin.js';
export type { TracingPluginOptions } from './lib/plugin.js';
export { SnapshotThrottle, DEFAULT_SNAPSHOT_MIN_INTERVAL_MS } from './lib/snapshot-throttle.js';
export type { SnapshotThrottleDeps } from './lib/snapshot-throttle.js';
export { configSchema } from './lib/config.js';
export type { TracingConfig, TracingConfigInput } from './lib/config.js';
export { CORE_MAPPINGS, defineMapping, pointSpanMapping, subscribe } from './lib/mappings.js';
export type { AnyEventMapping, EventMapping } from './lib/mappings.js';
export { TracingCounters } from './lib/counters.js';
export type { TracingSnapshot, LatencySeries } from './lib/counters.js';

// c536ce29 TRC-AC21: the improved (unpublished) @adhd/sox-telemetry log-channel API, re-exported
// so agent-mcp consumes it through this package only. RELEASE-BLOCKED until sox-telemetry 0.5.0
// is published; see README "Release status".
export {
  createLogChannel,
  createRedactor,
  identityRedactor,
  DEFAULT_REDACTION_RULES,
  BodyCapture,
  captureBody,
  withLogContext,
  currentLogContext,
} from '@adhd/sox-telemetry';
export type {
  LogChannel,
  LogChannelOptions,
  Redactor,
  RedactionRule,
  RedactInput,
  CapturedBody,
  LogContext,
} from '@adhd/sox-telemetry';

export default createPlugin;
