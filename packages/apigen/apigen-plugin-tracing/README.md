# @adhd/apigen-plugin-tracing

> Layer plugin: one OTel span per dispatched operation, written as durable JSONL trace records.

## What it does

`@adhd/apigen-plugin-tracing` instruments **every operation dispatched through an apigen transport**
— `http`, `grpc`, `mcp`, and `cli` — because all transports converge on a single composed invoker.
For each dispatched operation it emits a span carrying the operation id, the transport, the outcome,
and the duration, correlated by a `trace_id` that ties every span of one logical request together.

Records are written through [`@adhd/sox-telemetry`](https://www.npmjs.com/package/@adhd/sox-telemetry)
to the process's durable JSONL sink (`<dir>/<service>.<role>-<date>.jsonl`), so a second process — or
the backlog graph — can reconstruct one request across transports.

It is implemented as a **`Layer` capability** (one layer instruments all three transports). A
`target` capability is declared for interface parity but emits nothing: `--type tracing` resolves to a
valid no-op rather than an error. This mirrors `apigen-plugin-logger`.

Tracing composes cleanly alongside the logger plugin — same seam, no coupling:

```ts
usePlugins: [tracingPlugin, loggerPlugin, batchPlugin];
```

## Install

```bash
pnpm add @adhd/apigen-plugin-tracing
```

## Usage

### CLI — bare slug

```bash
apigen run --source ./api.ts --type mcp --use tracing
```

Also usable through the v2 multi-use option:

```bash
apigen run --source ./api.ts --type mcp --use @adhd/apigen-plugin-tracing
# `--type tracing` is a valid no-op target (emits no files, throws no error)
apigen run --source ./api.ts --type tracing
```

### Programmatic

```ts
import { tracingPlugin, makeTracingPlugin, TraceHandle } from '@adhd/apigen-plugin-tracing';

// default plugin — span prefix `apigen` (zero-config)
run({ usePlugins: [tracingPlugin] });

// `makeTracingPlugin(...)` is the configured entry point — use it to set the span prefix and
// copy declared envelope headers onto every span.

// configured
run({
  usePlugins: [
    makeTracingPlugin({
      serviceName: 'checkout',
      envelopeAttrs: ['x-request-id'],
    }),
  ],
});
```

### Annotating the live span from domain code

The layer seeds a `TraceHandle` into `call.ctx`; read it back and add attributes to the live span:

```ts
import { TraceHandle } from '@adhd/apigen-plugin-tracing';

export async function placeOrder(call, ...args) {
  const trace = call.ctx.get(TraceHandle);
  trace?.annotate({ 'order.region': region });
  // …
}
```

`annotate` is a no-op when the operation is not currently inside a unary span (e.g. before the
downstream resolved, or for a streaming call, which is logged rather than spanned).

## Records

| Event | Level | Carries |
|---|---|---|
| `<serviceName>.<op>.start` | info | `apigen.op`, `apigen.transport`, `trace_id` |
| `<serviceName>.<op>.finish` | info | the above + `duration_ms` |
| `<serviceName>.<op>.error` | error | the above + `error` (the thrown message) |
| `apigen.op.error` | error | `apigen.op`, `apigen.transport`, `trace_id`, `span`, `duration_ms`, `err` |

Streaming operations are **quarantined**: under the current `Next` contract
(`() => Promise<LayerResult>`), an `AsyncIterable` can only be a *resolved* value, never an
unresolved one, so the layer spans a streaming op only up to the point the stream is obtained — as a
unary span. Per-chunk `.{start,finish,error}` records with a chunk count are **not** emitted. The
`traceStream` helper remains in the package (directly unit-tested) behind a quarantine banner for a
future reopen-span follow-up; `traceUnary` is the only layer path.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `serviceName` | `string` | `'apigen'` | Span / record name prefix. |
| `envelopeAttrs` | `string[]` | `[]` | Extra `call.envelope` keys copied verbatim onto each span. |

## Part of the apigen toolchain

See [`@adhd/apigen-cli`](https://www.npmjs.com/package/@adhd/apigen-cli) for the full
TypeScript-to-API system and the list of available plugins.
