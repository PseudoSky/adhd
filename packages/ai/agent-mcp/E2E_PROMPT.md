# agent-mcp E2E Test Suite

You are an automated E2E test runner for the agent-mcp server. Execute every scenario below
using the agent-mcp tools available to you. After each scenario record **PASS** or **FAIL**
and a one-line reason. At the end print a summary table.

The agents that must already exist before you begin: `test`, `test-orchestrator`.
Do not modify or delete those agents.

---

## Scenario 1 — agent_list baseline
Call `agent_list`. Verify the response is an array containing at least `test` and
`test-orchestrator`. Record the count of agents.
Expected: array length ≥ 2, both named agents present.

## Scenario 2 — agent_create
Create an agent with these exact values:
- name: `e2e-worker`
- provider: lmstudio, model `qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8`,
  apiKeyEnv `LMSTUDIO_API_KEY`, baseURL `http://192.168.1.59:1234/v1`, timeoutMs 180000
- systemPrompt: `"You are a test worker. When asked to say hello, reply with exactly: Hello from e2e-worker"`
- mcpServers: `{}`
- permissions: `{}`

Expected: response contains `name: "e2e-worker"`, `version: 1`.

## Scenario 3 — agent_read
Call `agent_read` for `e2e-worker`.
Expected: all fields match what was sent in Scenario 2.

## Scenario 4 — agent_update partial patch (Bug 3 regression)
Call `agent_update` on `e2e-worker` with patch containing **only** `systemPrompt`:
`"Updated system prompt — mcpServers must be preserved."`
Expected: `version` bumped to 2, `systemPrompt` changed, `mcpServers` is still `{}` (not
clobbered to a default). FAIL if `mcpServers` changed.

## Scenario 5 — session_list
Call `session_list` with no filters.
Expected: response is an array (may be empty or contain prior sessions). No error.

## Scenario 6 — session open and filtered list
Open a session on `e2e-worker` (call `agent` with name `e2e-worker`). Record the session_id.
Then call `session_list` with `agentName: "e2e-worker"` and `status: "active"`.
Expected: the new session_id appears in the filtered list.

## Scenario 7 — session_close
Close the session from Scenario 6.
Expected: response has `status: "closed"` and `closedAt` is set.

## Scenario 8 — task on closed session
Attempt to run a task on the session closed in Scenario 7.
Expected: error code `SESSION_CLOSED`.

## Scenario 9 — delete agent with active session
Open a new session on `e2e-worker`. Then immediately attempt `agent_delete` on `e2e-worker`.
Expected: error code `AGENT_HAS_ACTIVE_SESSIONS`.
Close the session after confirming the error.

## Scenario 10 — delete agent after session closed
After closing the session from Scenario 9, call `agent_delete` on `e2e-worker`.
Expected: `{ success: true }`.

## Scenario 11 — basic task on `test` agent
Open a session on `test`. Run a sync task with prompt `"Say hello."`.
Expected: `status: "completed"`, result contains a greeting.

## Scenario 12 — delegation: orchestrator → test (Bug 2 regression)
Open a session on `test-orchestrator`. Run a background task:
`"Say hello to me. Delegate to the test agent to do it."`
Poll `result` until status is `completed` or `failed` (allow up to 5 minutes).
Expected: `status: "completed"`, result text confirms the test agent replied.
FAIL if status is `failed` or the result doesn't mention delegation.

## Scenario 13 — task cancellation
Open a session on `test-orchestrator`. Fire a background task:
`"Delegate this to the test agent: what is the meaning of life, the universe, and everything?"`
Immediately call `task_cancel` with the returned task_id.
Expected: cancel returns `{ success: true }`.
Then call `result` and confirm `status: "cancelled"`.
FAIL if status is anything other than `cancelled`.

## Scenario 14 — timeout error message
Create an agent `e2e-timeout-test`:
- provider: lmstudio, model `qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8`,
  apiKeyEnv `LMSTUDIO_API_KEY`, baseURL `http://192.168.1.59:9999/v1`, timeoutMs 500
- systemPrompt: `"Timeout test."`
- mcpServers: `{}`, permissions: `{}`

Open a session on it. Run a sync task `"Say hello."`.
Expected: `status: "failed"`, error message contains `"timed out after 500ms"` and `"timeoutMs"`.
FAIL if the error says `"Request was aborted."` without the timeout context.

Clean up: close the session, delete `e2e-timeout-test`.

---

## Cleanup
Ensure `e2e-worker` and `e2e-timeout-test` are deleted (close any remaining sessions first).
Do not touch `test` or `test-orchestrator`.

---

## Final Report

Print a markdown table:

| # | Scenario | Result | Notes |
|---|----------|--------|-------|
| 1 | agent_list baseline | PASS/FAIL | ... |
| 2 | agent_create | PASS/FAIL | ... |
| 3 | agent_read | PASS/FAIL | ... |
| 4 | Partial update — Bug 3 regression | PASS/FAIL | ... |
| 5 | session_list | PASS/FAIL | ... |
| 6 | Session open + filtered list | PASS/FAIL | ... |
| 7 | session_close | PASS/FAIL | ... |
| 8 | Task on closed session | PASS/FAIL | ... |
| 9 | Delete with active session | PASS/FAIL | ... |
| 10 | Delete after session closed | PASS/FAIL | ... |
| 11 | Basic task on test | PASS/FAIL | ... |
| 12 | Delegation orchestrator→test — Bug 2 regression | PASS/FAIL | ... |
| 13 | Task cancellation | PASS/FAIL | ... |
| 14 | Timeout error message | PASS/FAIL | ... |

Then print: `PASSED: X/14` and `FAILED: Y/14`.
If any scenario failed, list the failure reasons below the table.
