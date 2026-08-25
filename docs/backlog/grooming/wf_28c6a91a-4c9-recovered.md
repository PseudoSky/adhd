# Grooming run wf_28c6a91a-4c9 — recovered residue

Run killed mid-flight (session limit, then an adopt failure).
19,327,571 output tokens / 3,689 tool calls across 518 agents.

Item-scoped analysis was excavated from the run journal and written into the backlog
graph as notes: **307 items** (172 open + 135 closed/other-status), verified by
re-reading from a fresh process. This file holds what could NOT attach to any item.

## Why the triage half is untrustworthy

191 of 234 triage clusters (82%) reported that no `mcp__backlog__*` tool was in their
toolset — the MCP server was down. They could not fall back to the `backlog` CLI
either: `agentType: 'product-manager'` has no Bash, and the prompt never named the CLI
as an alternative. So they answered from data inlined in their prompt.

The debugger lane (`agentType: 'debugger'`, which has Bash) was unaffected — its
verdicts carry real `git merge-base` / `git log` output and are reproducible.

## Fabricated ids (22)

Plausible pattern-completions, not noise:

| invented | reality |
|---|---|
| `FEAT-APIGEN-SERVE-CORE-001` | family has `-000` and `-005`..`-009`, never `-001` |
| `NB-003` | real item is `NB-3` (no zero-padding) |
| `RISK-001` | real item is `RISK-SERVE-CORE-PLAN-001` |

Full list:

```
BUG-GITNEXUS-CONCURRENCY-001, BUILD-CONSIST-001, DEBT-APIGEN-013, DEBT-APIGEN-SERVE-CORE-002, DEBT-APIGEN-SERVE-CORE-003, DEBT-BACKLOG-RENDER-VERIFY-ARCHIVED-MISMATCH-001, DEBT-MCP-HOME-EXPAND-001, ENV-CLI-001, ENV-SEC-001, ENV-SEC-002, FEAT-APIGEN-BATCH-001, FEAT-APIGEN-SERVE-CORE-001, FEAT-APIGEN-SERVE-CORE-002, FEAT-APIGEN-SERVE-CORE-003, FEAT-APIGEN-SERVE-CORE-004, FEAT-DISPATCH-SESSION-002, FEAT-DISPATCH-TOOLS-002, NB-001, NB-002, NB-003, RISK-001, X
```

## Cluster-level notes (234)

Mostly agents documenting their own tool starvation. Raw text in the sibling JSON.

## Handbacks (33)

Items a lane judged mis-routed. Never re-dispatched — the reroute phase died with the run.
