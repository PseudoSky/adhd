# live-e2e — STATE_NAME

**Phase:** tests · **Kind:** work · **Depends on:** cli-audit, orch-audit · **Guard:** `npx --yes nx test dispatch-cli`

---

## Goal

The dispatcher is proven end-to-end against a REAL model: `dispatch run --no-dry-run` spawns `npx -y @adhd/agent-mcp`, a real deepseek-chat provider completes a cycle, and a real `dispatch_log` result + model call are persisted. A default-running structural test (real subprocess spawn + MCP stdio handshake, no paid call) runs unflagged in CI; the paid live assertion is env-gated behind AGENT_MCP_LIVE=1.

---

## Acceptance criteria

<!-- Author criteria with `plan-scaffold.js add-criterion`. Each writes a
     matching audit check ID so Check 3's ID-mirror holds. Do not hand-add
     bare [slug.N] tokens here without a matching audit check. -->

- [live-e2e.1] default-running structural: real agent-mcp subprocess spawn + MCP stdio handshake (initialize + tools/list), no paid call

- [live-e2e.2] env-gated paid live: dispatch run --no-dry-run drives real deepseek (self-skips with a visible warning when AGENT_MCP_LIVE unset)
---

## Reservations

```text
read_only:  []
mutates:    ["entrypoint/dispatch-cli/src/test/integration/real-e2e.ts"]
```

---

## Notes for executor

Codifies the path a separate executor is proving now (fixing the stale `real-e2e.ts` + a live deepseek dispatch) as a PERMANENT DoD gate (dod.14). NO mock may stand in for the thing under test ([inv:teeth]). Two tests: (1) `live-e2e.1` default structural — real agent-mcp spawn + `initialize`+`tools/list` handshake, runs by default, FAILS LOUDLY if the agent-mcp artifact/`python3` prereq is missing (never a silent skip). (2) `live-e2e.2` env-gated paid live — drives `run --no-dry-run` → deepseek and asserts a real completion (new deepseek task in agent-mcp usage; dispatch_log result with tokens>0); self-skips with a VISIBLE warning when AGENT_MCP_LIVE unset (the one legitimate gate — a paid third-party model, per CLAUDE.md "Live testing is mandatory"). Human-blocker `deepseek-api-key` provisions the key at hand-off. Document the gate (owner: human-dispatcher) in the dispatch-cli README + the test-file header. This is a test/integration state — it does not modify shipped source beyond the harness.
