# Acceptance Evidence — dod.9

Date: 2026-06-10T03:50:00Z
Package version tested: @adhd/agent-mcp@0.0.5
LM Studio model: qwen2.5-14b-instruct

## Setup

- Published server (`npx -y @adhd/agent-mcp@latest`) with fresh DB at `packages/ai/agent-mcp/data/agents-published.db`
- Two agents created on published server:
  - `at-delegator` (qwen2.5-14b-instruct, mcpServers wired to published server, allowedAgents: ["at-worker"])
  - `at-worker` (qwen2.5-14b-instruct, no mcpServers, leaf agent)
- Zero-knowledge subagent dispatched with prompt: "Use the task tool with agent_name 'at-delegator' and prompt: 'What is the capital of France?' ... tell me everything you can learn about what just ran ... including any nested objects in the task result."
- Subagent had no prior context about token usage tracking or the plan.

## Subagent report

How the subagent found the data: read `usage.direct` and `usage.subtree` from the task result
(then called `usage_query` to get per-row breakdown — independently discovered both paths)

Direct (top-level task — at-delegator):
  Task ID: ef9f2246-017d-419e-9e73-f7f33299803c
  input=6598, output=305, modelCalls=3, toolCallCount=3, latencyMs=20322

Subtree (full delegation tree — at-delegator + at-worker):
  input=6637, output=313, modelCalls=4, toolCallCount=3, taskCount=2

Child task (at-worker, persisted):
  Task ID: a5707594-b930-4c44-a83e-2a6c43e8392e
  sessionId: ad463bda-1b9a-49fe-96d4-f5aa65695042
  parentTaskId: ef9f2246-017d-419e-9e73-f7f33299803c
  input=39, output=8, modelCalls=1, toolCallCount=0, latencyMs=562

## DB verification

Raw `SELECT * FROM task_usage ORDER BY created_at` on agents-published.db:

```
ef9f2246-017d-419e-9e73-f7f33299803c | at-delegator | 6598 | 305 | 3 | 3 | NULL (root) | is_complete=1
a5707594-b930-4c44-a83e-2a6c43e8392e | at-worker    |   39 |   8 | 0 | 1 | ef9f2246... | is_complete=1
```

Subtree aggregate (`task_id = ? OR root_task_id = ?` for root ef9f2246):
  input_tokens=6637, output_tokens=313, model_calls=4, task_rows=2

## Match table

| Metric                  | Subagent reported | DB direct query | Match |
|-------------------------|-------------------|-----------------|-------|
| direct.inputTokens      | 6598              | 6598            | ✓     |
| direct.outputTokens     | 305               | 305             | ✓     |
| direct.modelCalls       | 3                 | 3               | ✓     |
| subtree.inputTokens     | 6637              | 6637            | ✓     |
| subtree.outputTokens    | 313               | 313             | ✓     |
| subtree.modelCalls      | 4                 | 4               | ✓     |
| taskCount               | 2                 | 2               | ✓     |

## Verdict

VERIFIED_MATCH
