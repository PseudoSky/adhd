# @adhd/apigen-plugin-tracing

## 0.1.0

### Minor Changes

- Initial release. A `Layer` capability that emits one OTel span per dispatched operation
  (operation id, transport, outcome, duration) to the `@adhd/sox-telemetry` JSONL sink, correlated
  by `trace_id`. Declares an empty `target` capability for interface parity (`--type tracing` is a
  valid no-op).
