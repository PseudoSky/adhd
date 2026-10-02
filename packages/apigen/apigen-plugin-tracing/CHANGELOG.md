# @adhd/apigen-plugin-tracing

## 0.2.0 (2026-10-01)

### ⚠️  Breaking Changes

- **apigen-plugin-tracing:** `makeTracingPlugin(opts)` / `makeTraceLayer(opts)` now REQUIRE
  `opts.serviceName` (previously the options object defaulted to `{}` with an implicit `'apigen'`
  namespace). Reserved span attribute and event keys changed from `apigen.op` / `apigen.transport` /
  `apigen.op.error` to `<serviceName>.op` / `<serviceName>.transport` / `<serviceName>.op.error`.
  Every consumer must now pass an explicit `serviceName` (adhd products pass `'adhd'`) and read the
  namespaced keys. 0.x breaking ⇒ minor.

### ❤️  Thank You

- pseudosky

## 0.1.0

### Minor Changes

- Initial release. A `Layer` capability that emits one OTel span per dispatched operation
  (operation id, transport, outcome, duration) to the `@adhd/sox-telemetry` JSONL sink, correlated
  by `trace_id`. Declares an empty `target` capability for interface parity (`--type tracing` is a
  valid no-op).

### Patch Changes

- The span's `apigen.transport` is now supplied by the engine from the operation plan's own
  transport rather than inferred, so every transport — `http`, `grpc`, `mcp`, `cli` — reports
  its own transport, never `undefined`. Reserved span keys (`apigen.op`, `apigen.transport`,
  `trace_id`) can no longer be shadowed by an `envelopeAttrs` key of the same name; the reserved keys
  always win. Streaming operations are quarantined to a unary span (see README): per-chunk records
  with a chunk count are no longer emitted under the current `Next` contract.
