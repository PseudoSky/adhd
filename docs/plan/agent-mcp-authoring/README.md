# agent-mcp Authoring & Discovery — registry-backed composition over MCP (agent-mcp@2.0.0)

An orchestrating agent composes a NEW agent from registry components over MCP only — prompt_types_list → component_search (auto-ranked) → component_read → tool_list/model_list/policy_list → agent_define/component_define (declarative idempotent upserts with auto-enrichment) → agent → task — without reading any agent file or store internals, while the 11-tool runtime hot path and agent-mcp byte-back-out guarantee both hold.

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

_No DoD clauses yet — author them with `plan-scaffold.js add-dod`._
