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
| `agent.task.startup`         | instantaneous, `task:startup`: where a task's start-up time went |
| `agent.dispatch`             | instantaneous, `dispatch:completed`: a `task` / `tasks_batch` / agent-task call finished handing work to child tasks |
| `agent.background.delivered` | instantaneous, `background:delivered`: a background child's result reached its parent (the mapping ships; no engine emitter yet) |

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

### Wall-time attribution signals (R10)

These attributes let a reader attribute a run's wall clock from the trace alone, with no hand
analysis: group by `agent.root_task_id` / `agent.task_id` / `agent.parent_task_id` /
`agent.recursion_depth`, and compute the critical path from span start/end (there is deliberately no
`critical_path_ms`). An optional hook field the emitter did not supply leaves its attribute
**absent**; a missing measurement is never recorded as 0.

| record | attribute | meaning |
| --- | --- | --- |
| `agent.tool_call.start` | `agent.tool.concurrency_class` | `safe` / `barrier` / `unordered`, as scheduled |
| | `agent.tool.turn_index` | zero-based model turn whose response requested the call |
| | `agent.tool.group_index` | ordered execution group the call ran in |
| | `agent.tool.queued_ms` | ms the call waited for a slot / an earlier group before it started (barrier waits) |
| `agent.tool_call.finish` / `.error` | `agent.tool.error_class` | `none` / `policy_rejected` / `arg_mismatch` / `arg_coerced` / `exit_nonzero` / `tool_error` |
| | `agent.tool.result_bytes` | model-visible bytes of the result |
| | `agent.tool.note_appended` | the host appended a guidance note to the result |
| `agent.model_call.finish` | `agent.model_call.ttfb_ms` | provider request start to first streamed byte (only where the provider measures it) |
| | `agent.model_call.thinking_config` | `none` / `adaptive` / `disabled` |
| | `agent.model_call.thinking_blocks` | thinking blocks in the response (a count, never their text) |
| | `agent.model_call.tool_result_bytes_in` | bytes of tool-result content sent to the model in this request |
| | `agent.model_call.turn_index` | zero-based model call within its task |
| `agent.task.startup.finish` | `agent.startup.mcp_connect_ms.<server>` | one attribute per MCP server key: connect + tool listing ms |
| | `agent.startup.tools_ready_ms` | task start until the full tool list was ready |
| | `agent.startup.queue_wait_ms`, `agent.startup.session_ms` | enqueue to run start; session resolution (present only when the engine measured them) |
| | `agent.startup.tools` | tools advertised to the model |
| `agent.dispatch.finish` | `agent.dispatch.mode` | `sync` (parent waited for the children) / `background` |
| | `agent.dispatch.kind` | `task` / `tasks_batch` / `agent_task` |
| | `agent.dispatch.children`, `agent.dispatch.child_task_ids` | count and comma-joined ids; the children's records carry the same ids in `agent.task_id` |
| | `agent.dispatch.parent_blocked_ms` | sync: wall time the parent spent inside the tool call; background: 0 |
| | `agent.dispatch.wait_ms` | ms spent waiting for children, when the emitter reports it |
| | `agent.dispatch.call_id` | the dispatching `agent.tool.call_id`, stamped only when exactly one dispatch tool call is open on the parent (concurrent dispatch calls are ambiguous: join on `child_task_ids`) |
| `agent.background.delivered.finish` | `agent.background.child_task_id`, `.latency_ms`, `.consumed_via` | child terminal to delivered; `delivery` / `result` |
| `agent.task.finish` | `agent.task.model_ms` | time inside the task's own model calls |
| | `agent.task.tool_ms` | wall time with at least one tool call in flight (parallel calls counted once); a sync dispatch counts as tool time |
| | `agent.task.idle_ms` | wall time covered by neither (engine overhead, queueing, persistence) |

The `agent.dispatch` record sits on the **parent** task; the worker's `agent.task`, `agent.model_call`
and `agent.tool_call` records carry the worker's task id (one of `child_task_ids`),
`agent.parent_task_id` = the dispatching task, and the delegation tree's `trace_id`. Because the
`parent_blocked_ms` clock starts when the dispatch tool begins and `agent.tool_call` starts a moment
earlier, `worker task duration <= parent_blocked_ms <= dispatching tool_call duration`.

**Provider rule.** The plugin never invents a model-call figure. `ttfb_ms`, `thinking_config`,
`thinking_blocks` and `tool_result_bytes_in` appear only when the provider adapter supplied them: an
OpenAI-compatible adapter (OpenAI, DeepSeek, any Chat Completions endpoint) has no thinking blocks,
no first-byte probe and no cache fields, so those attributes are absent from its records, never `null`,
`NaN` or `0`. An explicit `null` / `NaN` / `Infinity` from a sloppy adapter is dropped the same way.
The provider-independent attributes (`stop_reason`, token counts, `compute_ms`, every tool-call signal,
startup, dispatch, the `agent.task` wall-time split) are identical across providers. Proven per
provider family (OpenAI Chat Completions and Anthropic Messages streaming, each through its real
adapter over loopback HTTP) in `src/lib/r10-dispatch-trace.test.ts`.

Content rule: no tool arguments, results, prompts or thinking text reach any attribute.
`agent.tool.args_sha256` stays the only argument identity (the verbatim `agent.tool.args` exists only
under the explicit `captureArgs` opt-in).

**For the parity instrument:** point the sink at the run's own trace directory through the normal
configuration cascade, `tracing.logDir` (env `ADHD_AGENT_TRACING_LOG_DIR`), for example
`OUT/runs/C1/logs/trace`; tracing is default-on, so no switch is involved. A mock-provider run through
the real plugin stack writes a record per span name above to that directory (S5-AC0 is proven by
`src/lib/r10-dispatch-trace.test.ts`), and every record is one JSON object per line with the
attributes as flat top-level keys.

### Metrics

Counters are exposed as the `agent_tracing` section of `metrics.snapshot`. A snapshot is requested at
task terminals but rate-limited: the first writes immediately, further terminals inside the window
(default 5 s, `TracingPluginOptions.snapshot.minIntervalMs`) coalesce into one trailing write that
`flushSnapshot()` / `dispose()` also drain, so the final counters are always persisted. Contents: sessions, tasks, model/tool calls, `by_tool`, tokens, permission
allow/ask/deny and ask outcomes, HITL suspend/resume, delegations, `delegation_depth_max`,
`tool_barrier_waits_total` (tool calls that waited, `queued_ms > 0`), `dispatch_sync_total` and
`dispatch_background_total` (completed dispatches by mode), and latency series. Rates are derived by the reader, never stored.

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
