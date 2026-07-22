# State: acceptance-test

**Phase:** release
**Kind:** work
**Depends on:** docs-and-publish

## Goal

Verify the complete feature end-to-end using only the production npm package. A subagent with zero prior context must independently discover and report sub-task token usage from a multilevel recursive call. The planner verifies the reported numbers against the raw SQLite DB.

## Semantic distillation

This is the human-verified acceptance gate for `[dod.9]`. Two independent signals must match for **two distinct numbers**:

1. **Subagent-reported:** The subagent reads usage from the MCP response body or the `task_usage` tool — without being told which to use or that it exists. It must report **both**:
   - Its own direct token usage (the top-level task it ran)
   - Its total delegated subtree token usage (the full delegation tree including all sub-tasks)
2. **DB-verified:** The planner queries the DB directly and confirms both numbers appear correctly in `task_usage` rows.

The subagent prompt must not mention: "usage", "token", "task_usage", "result", or any other hint about where data lives. The task is purely operational — run something and tell me about it.

**Setup required:**
- LM Studio running at `$LMSTUDIO_BASE_URL` with a loaded model
- `.mcp.json` `agent-mcp-published` entry connected (`/mcp` in Claude Code)
- A fresh `DATABASE_PATH` for the published server (use a separate file from the dev DB)

**Multilevel recursive task structure:**
Minimum 2 delegation hops so `root_task_id` is exercised:
- Agent A (e.g. claudecli or LMStudio orchestrator) → delegates to Agent B (LMStudio) → which itself runs a model call

The subagent is dispatched by the planner (me) using whatever transport gives it access to the production `agent-mcp-published` MCP server. The subagent has no other context.

## Subagent prompt (template)

```
You have access to the agent-mcp MCP server. Do the following:

1. Create two LM Studio agents: one called "delegator" that instructs the worker to answer, and one called "worker" that answers directly.
2. Open a session with "delegator" and ask it: "What is the capital of France?"
3. The delegator should use the task tool to delegate this to "worker", get the answer, and return it.
4. Once the task is complete, tell me everything you can learn about what just ran — what agents were involved, what tasks were created, and anything you can find out about the resources used.
```

The prompt asks the subagent to report "everything it can learn" and "resources used" — it must discover the `usage` data on its own.

## Reservations

```text
read_only:  []
mutates:    ["docs/plan/usage-tracking/acceptance-evidence.md"]
```

Note: the acceptance-test executor creates agents and tasks on the production DB — those are external side effects, not plan artifacts.

## Contract promise

**Added:** `docs/plan/usage-tracking/acceptance-evidence.md` — records the subagent's reported token count, the planner's DB-verified count, and the match verdict.

## Acceptance criteria

```bash
# [acceptance-test.1] Acceptance evidence file exists
test -f docs/plan/usage-tracking/acceptance-evidence.md

# [acceptance-test.2] Evidence records a verified match
grep -q 'VERIFIED_MATCH' docs/plan/usage-tracking/acceptance-evidence.md
```

## Commit points

**R1:** After writing acceptance-evidence.md:
```
chore(agent-mcp): acceptance-test passed — zero-knowledge token usage verified [dod.9]
```

## Notes

**Dispatching the subagent:** Use the Agent tool with `subagent_type: "general-purpose"` or `claude`. Give the subagent access to the `agent-mcp-published` MCP server tools. Do not give it any prior context about this plan or the token usage feature.

**Verifying from DB:**
```bash
DB=<your-published-agents-db-path>
sqlite3 $DB "SELECT task_id, agent_name, input_tokens, output_tokens, model_calls, root_task_id FROM task_usage ORDER BY created_at;"
```
Cross-reference the task_id the subagent reports against the DB row. If the counts match: VERIFIED_MATCH. If they differ: MISMATCH (block — fix before DONE).

**Write acceptance-evidence.md with this structure:**
```markdown
# Acceptance Evidence — dod.9

Date: <ISO-8601>
Package version tested: @adhd/agent-mcp@0.0.5
LM Studio model: <model-id>

## Subagent report

How the subagent found the data: <e.g. "read usage.direct/subtree from task result" or "called task_usage tool">

Direct (top-level task only):
  Task ID: <task_id>
  input=<N>, output=<N>, model_calls=<N>

Subtree (full delegation tree):
  input=<N>, output=<N>, model_calls=<N>, task_count=<N>

## DB verification

Direct — sqlite3 row for task_id <task_id>:
  input_tokens=<N>, output_tokens=<N>, model_calls=<N>

Subtree — sqlite3 aggregate for task_id=<id> OR root_task_id=<id>:
  input_tokens=<N>, output_tokens=<N>, task rows=<N>

## Verdict

VERIFIED_MATCH  ← write this only if reported direct == DB direct AND reported subtree == DB subtree
```
