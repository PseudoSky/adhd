## 0.0.4 (2026-10-15)

This was a version bump only for agent-plugin-tracing to align it with other projects, there were no code changes.

## 0.0.3 (2026-10-09)

This was a version bump only for agent-plugin-tracing to align it with other projects, there were no code changes.

## Unreleased

### 🩹 Fixes

- **agent-plugin-tracing:** `agent.tool.queued_ms`, `agent.tool.group_index` and `tool_barrier_waits_total` carry the engine-final values. The `pre:tool_call` mapping read `queuedMs` / `groupIndex` the moment the event fired, but the engine completes both on that payload object only when the call starts, so `queued_ms` was never emitted, the barrier-wait counter stayed 0 and `group_index` was the planned index. The mapping now keeps the payload and reads them at `post:tool_call`; both attributes (and the counter) land with the finish / error record, and a claudecli-bridged call (no schedule) still carries neither. Proven with a real `Orchestrator.run` over the real Anthropic and OpenAI-compatible providers. (a2a9c6db AC1)

### 🚀 Features

- **agent-plugin-tracing:** `agent.dispatch.call_id` is taken from the hook's `toolCallId` when the engine supplies it, which is correct under concurrent dispatch calls on one parent; the "exactly one open call" inference stays as the fallback when none is supplied. `dispatch:completed` with `kind: 'result'` (a `result` wait) records `agent.dispatch` with `wait_ms` and is not counted as a sync dispatch. README table updated for the engine-populated model-call signals. (R10 S5b)
- **agent-plugin-tracing:** re-export the sox-telemetry log-channel API (createLogChannel, createRedactor, identityRedactor, DEFAULT_REDACTION_RULES, BodyCapture, captureBody, withLogContext, currentLogContext + types) (c536ce29 TRC-AC21)

## 0.0.2 (2026-10-07)

### 🚀 Features

- **agent-mcp:** default-load agent-plugin-tracing with typed tracing config, reuse existing telemetry provider, audit script + docs (0f760dcd, 5dff26e6) ([0891a3bc](https://github.com/PseudoSky/adhd/commit/0891a3bc))
- **agent-plugin-tracing:** scaffold and implement tracing plugin over sox-telemetry (6ae794fe TRACE-3) ([08129f4f](https://github.com/PseudoSky/adhd/commit/08129f4f))

### 🩹 Fixes

- **agent-plugin-tracing:** post-merge review fixes F1/F2/F3/F6/F7 + deterministic tests (6ae794fe) ([4c6dc6d4](https://github.com/PseudoSky/adhd/commit/4c6dc6d4))

### ❤️ Thank You

- pseudosky