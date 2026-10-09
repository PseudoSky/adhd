# @adhd/agent-plugin-tracing

Durable traces and derived metrics for every agent operation in `@adhd/agent-mcp`, emitted into
[`@adhd/sox-telemetry`](https://www.npmjs.com/package/@adhd/sox-telemetry). Purely observational:
it subscribes to the hook registry, never alters a decision, and a failing telemetry sink can never
fail a task.

The package index also re-exports the sox-telemetry log-channel API (`createLogChannel`,
`createRedactor`, `identityRedactor`, `DEFAULT_REDACTION_RULES`, `BodyCapture`, `captureBody`,
`withLogContext`, `currentLogContext` and the types `LogChannel`, `LogChannelOptions`, `Redactor`,
`RedactionRule`, `RedactInput`, `CapturedBody`, `LogContext`).

Tracing is **default-on**. There is no enable/disable switch (no `ADHD_AGENT_TRACING_ENABLED`, no
`tracing.enabled`): a process that loads the plugin traces.

## Install

```ts
import createPlugin from '@adhd/agent-plugin-tracing'; // or { createPlugin }

const plugin = createPlugin({ db: null, config: {} }); // {} is valid: zero config
await plugin.install(hooks); // initialises telemetry, registers the snapshot section, subscribes
```

The module also exports `configSchema` (zod), so the agent-mcp plugin loader validates the
`config` block before calling the factory.

## Config

| key           | default                                | meaning                                           |
| ------------- | -------------------------------------- | ------------------------------------------------- |
| `service`     | `agent-mcp`                            | telemetry `service`; names the log directory      |
| `logSink`     | `file`                                 | `file` / `stderr` / `none`                        |
| `logDir`      | `~/.adhd/sox-ecosystem/<service>/logs` | file-sink directory                               |
| `captureArgs` | `false`                                | record truncated tool args (else sha256 digest)   |

## What it records

One span (`<name>.start` + `<name>.finish` | `<name>.error`, with `duration_ms`) per operation.
`.start` is durable before the operation ends, so a hung operation is visible.

| span                         | opened at → closed at                                  |
| ---------------------------- | ------------------------------------------------------ |
| `agent.session`              | `session:created` → `session:closed`                   |
| `agent.task`                 | `task:start` → `task:completed` / `failed` / `cancelled` |
| `agent.model_call`           | `pre:model_request` → `post:model_response`            |
| `agent.tool_call`            | `pre:tool_call` → `post:tool_call` (`.error` if `isError`) |
| `agent.permission.decision`  | instantaneous, at the permission gate verdict          |
| `agent.hitl.suspend`         | instantaneous, when a task parks awaiting a human      |
| `agent.hitl.resume`          | instantaneous, carries `agent.hitl.wait_ms`            |

All spans of a delegation tree share one `trace_id`; identity is carried in `agent.session_id`,
`agent.task_id`, `agent.root_task_id`, `agent.parent_task_id`, `agent.name`. Tool arguments are
recorded as `agent.tool.args_sha256` only (plus `agent.tool.args` under `captureArgs`).

A task that ends while a model/tool span is still open closes it with `agent.outcome: "unclosed"`.
`await plugin.dispose()` does the same for every still-open session, task, model and tool span and
releases all per-process state, so for a process that shuts down through `dispose()` every
`.start` has exactly one terminal record. The one exception is a process that dies without
disposing (crash, `kill -9`): its in-flight spans keep only their durable `.start`, which is the
hang-visible design, not a gap.

Events that arrive after their task already ended (a `post:tool_call`, `permission:decision` or
`hitl:resume` racing a cancel) are counted and recorded but never recreate per-task state; a
duplicate terminal for an ended task is dropped (the first outcome wins). A task first seen
mid-flight (began before install, no `task:start`) is counted but contributes no
`latency_ms.task` observation.

### Metrics

Counters are exposed as the `agent_tracing` section of `metrics.snapshot`. A snapshot is requested at
task terminals but rate-limited: the first writes immediately, further terminals inside the window
(default 5 s, `TracingPluginOptions.snapshot.minIntervalMs`) coalesce into one trailing write that
`flushSnapshot()` / `dispose()` also drain, so the final counters are always persisted. Contents: sessions, tasks, model/tool calls, `by_tool`, tokens, permission
allow/ask/deny and ask outcomes, HITL suspend/resume, delegations, `delegation_depth_max`, and
latency series. Rates are derived by the reader, never stored.

## Extending: new event families

The subscription table is data (`CORE_MAPPINGS`: one `EventMapping` per hook event). Supporting a
new event is one more row, never a new code path:

```ts
import { createPlugin, pointSpanMapping } from '@adhd/agent-plugin-tracing';

const extra = pointSpanMapping(
  'budget:block', // any HookEvent key
  'agent.budget.block', // span name
  (p) => ({ 'agent.budget.field': p.field }), // attributes
  (p) => p.executionContext
);
createPlugin(ctx, { extraMappings: [extra] });
```

`TracingPluginOptions.mappings` replaces the whole table (trace a subset). The planned
provider-failure family (`<domain>:attempt_failed|failed|tripped|recovered`) is added the same way:
one `pointSpanMapping` per member key.

## Default-loaded by agent-mcp

`@adhd/agent-mcp` loads this plugin by default (`defaultPluginEntries()` in its `src/config.ts`),
configured from its typed `tracing.*` config block (`ADHD_AGENT_TRACING_SERVICE`, `_LOG_SINK`,
`_LOG_DIR`, `_CAPTURE_ARGS` — values only, never a switch). An absent block loads the plugin with the
defaults above; an invalid block makes the host loader skip it and log the validation issues.

## One telemetry provider per process

`install()` never provisions a second provider. If the process has already initialised
`@adhd/sox-telemetry` (an embedding host, another plugin, apigen's tracing layer) the plugin
**adopts** it: `plugin.adoptedExistingTelemetry` is `true`, `service` / `logSink` / `logDir` from this
plugin's config do not apply, spans land in the host's sink, and `dispose()` leaves the host's
provider open. When it provisions its own, `dispose()` closes it, and a later `install()` provisions
afresh. `plugin.logFilePath()` reports where the process's sink writes either way.

## Verifying a sink

`python3 scripts/audit_tracing.py <sink-dir-or-file>...` (repo root) recomputes per-operation
sample counts and durations from the JSONL records and exits non-zero when an always-expected span path (session, task,
model_call) has zero samples (`--require-all` also demands the conditional provider-failure, budget, HITL
and permission paths) — the signal that the plugin silently stopped emitting for an operation.
