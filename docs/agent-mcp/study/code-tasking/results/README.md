# results/ — authoritative server-side capture (responses + usage)

The `tests/*/mcp.jsonl` files are the **requests** we sent. This folder is the
**responses and telemetry**, pulled verbatim from the published server's own
SQLite database (`packages/ai/agent-mcp/data/agents-published.db`) — the same
persistence the ephemeral-observability feature writes. Nothing here is
hand-transcribed; it's a straight dump of the `tasks` and `task_usage` tables.

> Note: this capture was **back-filled from the server DB**, not streamed to disk
> as each run happened. It's authoritative because the server persists every
> task + usage row (including ephemeral tasks, which survive agent deletion), so
> the DB is the source of truth regardless of when it was exported.

## Files

| file | what |
|---|---|
| `runs.jsonl` | one line per task (34): `{task_id, agent_name, provider, model, status, is_ephemeral, recursion_depth, parent/root_task_id, created_at, prompt, result, usage}`. `result` is the model's full raw response text. |
| `usage.json` | the full `task_usage` table (30 rows): tokens, `tool_call_count`, `model_calls`, `latency_ms`, `stop_reason`, cache tokens. |
| `INDEX.md` | auto-generated chronological table (agent / provider / tc / mc / tokens / prompt-prefix). |

## How to join requests ↔ responses

Match on the **prompt text**: every `tests/test-*/mcp.jsonl` `task` request carries
`request.prompt`, which appears verbatim as `prompt` in `runs.jsonl`. The matching
`result` + `usage` is the outcome the LOG grades.

## What the telemetry independently proves

- **Every graded run is tool-less.** `tool_call_count = 0` for all single-shot
  worker runs, local and Anthropic (the only `tool_call_count > 0` rows are the
  `lead`/`at-delegator` orchestrators, which dispatch sub-agents — their leaves
  are still `0`). No worker could read the repo or the shipped fix.
- **The 5 Anthropic differential runs** (`provider = anthropic`,
  `model = claude-sonnet-4-6`) are present with full results and `tool_call_count = 0`.

## Regenerating

```bash
DB=packages/ai/agent-mcp/data/agents-published.db
sqlite3 "$DB" -json "SELECT * FROM task_usage ORDER BY created_at DESC;" > results/usage.json
# runs.jsonl: LEFT JOIN tasks ⨝ task_usage — see the study commit for the exact query
```
