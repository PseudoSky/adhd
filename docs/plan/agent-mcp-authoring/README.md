# agent-mcp Authoring & Discovery — registry-backed composition over MCP (agent-mcp@2.0.0)

An orchestrating agent composes a NEW agent from registry components over MCP only — prompt_types_list → component_search (auto-ranked) → component_read → tool_list/model_list/policy_list → agent_define/component_define (declarative idempotent upserts with auto-enrichment) → agent → task — without reading any agent file or store internals, while the 11-tool runtime hot path and agent-mcp byte-back-out guarantee both hold.

## Consumer

<who walks through the change, and in what role>

## Value delta

<the observable before → after change the consumer experiences>

## Definition of Done

- `[dod.1]` **An agent authors a component over MCP with content only; the registry auto-files it (summary, use-cases, weights) — GOAL §Shared Components/Single Authorship + §Maintainability-Authoring. (behavioral)** — An agent authors a component over MCP with content only; the registry auto-files it (summary, use-cases, weights) — GOAL §Shared Components/Single Authorship + §Maintainability-Authoring..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `component_define MCP tool ({name,type,content,shared})`
  - observable: `returns {summary (non-empty, auto-derived), use_cases:[{name,weight>0}], version} with NO agent-supplied weights/use-cases; a second identical define returns changed:false and does NOT churn the index (deterministic enrichment)`
  - negative-control: `stubbing the enrichment to skip embedding makes the use_cases array empty → the assertion fails`
  - delivered-by: `enrichment-pipeline, component-define`
