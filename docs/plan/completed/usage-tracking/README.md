# Plan: usage-tracking

Production-quality token usage tracking for agent-mcp, implemented as a middleware
extension via the Plugin/HookRegistry pattern.

## Plan files

| File | Purpose |
|---|---|
| `dag.json` | Dependency graph: nodes, phases, guards, artifacts |
| `state.json` | Runtime: current state, status per slug, transition + amendment logs |
| `state-machine.md` | Visual graph + target-state invariants |
| `references.json` | Reference pattern catalog (anchor → rule) |
| `contexts/_shared.md` | Shared definitions cited by work state contexts |
| `contexts/<slug>.md` | Per-state work orders |
| `scripts/audit_usage_tracking.py` | Phase-scoped audit script |

## Definition of Done

- `[dod.1]` After every task completes, a `task_usage` row exists with accurate `input_tokens`, `output_tokens`, `model_calls`, `tool_call_count`, and `latency_ms`. `root_task_id` links sub-tasks to their delegation root (null for root tasks). claudecli tasks produce a row with zeros — no error.
- `[dod.2]` Token usage appears in the MCP response body on both the synchronous `task` result and the `result` tool: a `usage` object with `direct` (this task's own token counts) and `subtree` (this task + all sub-tasks aggregated via `root_task_id`) reported separately. Consistent across all providers — claudecli reports zeros.
- `[dod.3]` A `usage_query` MCP tool exists for historical analysis, supporting filters: `task_id`, `root_task_id`, `agent_name`, `since`, `include_incomplete`, and `limit`. The existing `usage` guide tool is renamed `guide`.
- `[dod.4]` Token rows are written incrementally — an UPSERT fires on each `post:model_response` so data survives a process crash between model calls and the terminal event.
- `[dod.5]` All existing `agent-mcp` tests pass after every state (no regressions).
- `[dod.6]` Package docs updated: GAPS.md item #4 marked implemented; ROADMAP.md Phase 1 item #2 ("Token usage tracking") marked complete; INSTALL.md and README.md include `task_usage` in tool reference and permissions list.
- `[dod.7]` Code reviewer agent runs against all implementation changes; all findings addressed and committed before publish.
- `[dod.8]` Package published to npm (`@adhd/agent-mcp`); `npm view @adhd/agent-mcp dist-tags.latest` returns the new version.
- `[dod.9]` A subagent with zero prior context is dispatched from the production `@adhd/agent-mcp` npm package with a prompt that does not mention where to find usage data. The subagent runs a multilevel recursive task (≥2 delegation hops) against the local LLM and independently reports both its own direct token usage **and** its total delegated subtree token usage. The planner verifies both numbers against the SQLite DB. Numbers match.

## Non-goals

`@adhd/metrics-plugin`, streaming, priority queue, and per-agent concurrency limits are out of scope for this plan.

## How to execute a state

1. Read `state.json` → identify `current_state`.
2. Read `dag.json` → find the node for that slug → read its `context` file.
3. Read `contexts/_shared.md` for referenced `[def:]`/`[inv:]`/`[shape:]` entries.
4. Do the work within the declared file reservations.
5. Run the guard until it exits 0.
6. Update `state.json`: set `status: "completed"`, fill `completed_at`, append `transition_log` entry, set `current_state` to the next unblocked pending state.
7. Commit every plan write (R1). Honor the context's Commit points (R2).
8. Stop at the state boundary — do not begin the next state in the same session.

## Amendment protocol

See `state-machine.md` — Amendment protocol section.

## Dispatch prompt

```
Resume the state-machine plan at docs/plan/usage-tracking/. Read state.json + dag.json, take current_state, read its context file (and contexts/_shared.md for referenced definitions), do the work within the declared file reservations, run the guard until it exits 0, update state.json (status, timestamps, transition_log), commit every plan write (R1) and honor the context's Commit points, then stop at the state boundary. Never skip the guard.
```
