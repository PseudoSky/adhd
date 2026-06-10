# State Machine: usage-tracking

## Phases

```
foundation
  provider-token-signal ──→ hook-token-payload ──→ audit-foundation
                                                          │
plugin                                                    ▼
  audit-foundation ──→ usage-schema ──→ usage-plugin ──→ usage-query-tool
                                                                │
convergence                                                     ▼
                                                         audit-final
                                                                │
release                                                         ▼
                                                          code-review ──→ docs-and-publish ──→ acceptance-test
```

## Node summary

| Slug | Phase | Kind | Depends on |
|---|---|---|---|
| `provider-token-signal` | foundation | work | — |
| `hook-token-payload` | foundation | work | provider-token-signal |
| `audit-foundation` | foundation | audit | provider-token-signal, hook-token-payload |
| `usage-schema` | plugin | work | audit-foundation |
| `usage-plugin` | plugin | work | usage-schema, audit-foundation |
| `usage-query-tool` | plugin | work | usage-plugin |
| `audit-final` | convergence | audit | usage-query-tool |
| `code-review` | release | work | audit-final |
| `docs-and-publish` | release | work | code-review |
| `acceptance-test` | release | work | docs-and-publish |

## Target state

When `audit-final` passes:

1. Every call to `provider.chat()` (OpenAI, Anthropic, LMStudio) returns token counts in `ProviderChatResponse.usage`. claudecli returns undefined — handled as zeros throughout.
2. `PostModelResponsePayload` carries `tokenUsage?` populated from the provider response, forwarded by the orchestrator on each `post:model_response` emit.
3. `UsagePlugin` UPSERTs to `task_usage` on every `post:model_response` (incremental crash-durable writes) and finalizes `latency_ms`, `root_task_id`, and `is_complete=1` at the terminal event.
4. `task_usage` rows include `root_task_id` linking sub-tasks to their delegation root. `latency_ms` tracks wall-clock task duration.
5. The `result` tool and sync `task` tool responses include a `usage` field with `direct` (this task's own token counts) and `subtree` (this task + all sub-tasks via `root_task_id`) reported separately.
6. MCP tool `task_usage` allows callers to query per-task and per-agent token costs with `root_task_id`, `agent_name`, `since`, and `include_incomplete` filters.
7. All existing `agent-mcp` tests continue to pass.
8. GAPS.md item #4 is updated to `implemented`.

## Amendment protocol

Any change that does **not** alter the dependency graph, target state invariants, or audit coverage is an **executor-class amendment**: expand `dag.json` artifacts, add a criterion (+ matching audit check ID), or fix a wrong guard. Update `dag.json`, `state.json`, `state-machine.md`, and the context file, append to `amendment_log`, commit.

Any change that **does** alter the dependency graph or target state is a **planner-class amendment**: stop, record the reason in `amendment_log`, and escalate.
