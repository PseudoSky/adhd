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

- `[dod.2]` **An agent discovers components for a task by intent, auto-ranked, one call per slot — GOAL §Maintainability-Discovery; replaces manual taxonomy navigation (SPEC §6.2). (behavioral)** — An agent discovers components for a task by intent, auto-ranked, one call per slot — GOAL §Maintainability-Discovery; replaces manual taxonomy navigation (SPEC §6.2)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `component_search MCP tool ({query,type?,shared?,limit?})`
  - observable: `returns ranked results [{name,type,summary,score,shared}] where a query semantically matching a seeded component ranks it above an unrelated one (score-ordered); restricting type fills exactly one grammar slot`
  - negative-control: `replacing the semantic ranker with insertion-order returns the unrelated component first → assertion fails`
  - delivered-by: `discovery-tools`

- `[dod.3]` **An agent composes a NEW agent from components in ONE declarative idempotent upsert — GOAL §Maintainability-Onboarding (compose without reading another agent's file); SPEC §5.2/§7. (behavioral)** — An agent composes a NEW agent from components in ONE declarative idempotent upsert — GOAL §Maintainability-Onboarding (compose without reading another agent's file); SPEC §5.2/§7..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `agent_define MCP tool ({name,model,components[],tools?,policy?})`
  - observable: `first call returns {version:1, compiled_preview (contains each component's content in position order), composed_prompt_id, changed:true}; identical re-define returns changed:false with no version bump; a changed component list bumps version and busts the composed_prompt cache`
  - negative-control: `removing the content-hash compare makes an identical re-define report changed:true / bump version → assertion fails`
  - delivered-by: `agent-define`

- `[dod.4]` **name is the only identity on the wire; slug never leaks through the MCP boundary — SPEC §3 (Decision E), the translation-seam refactor. (behavioral)** — name is the only identity on the wire; slug never leaks through the MCP boundary — SPEC §3 (Decision E), the translation-seam refactor..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `any authoring/discovery tool output (component_read, agent_read, component_search, agent_define)`
  - observable: `every tool response JSON contains a name field and NO slug key anywhere (recursive scan); passing a human 'Display Name' resolves to the same row as its slug form`
  - negative-control: `leaving a raw store object (with .slug) in any tool response → the recursive no-slug scan fails`
  - delivered-by: `name-slug-seam, discovery-tools, agent-define, component-define`

- `[dod.5]` **The full SPEC §7 task-packet→agent journey runs over the PUBLIC MCP surface only (zero internal/src imports), as a zero-context user would — the Cumulative Usability Gate (DEMO.md). (behavioral)** — The full SPEC §7 task-packet→agent journey runs over the PUBLIC MCP surface only (zero internal/src imports), as a zero-context user would — the Cumulative Usability Gate (DEMO.md)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `an MCP client driving prompt_types_list → component_search → component_read → tool_list/model_list/policy_list → component_define (for a missing slot) → agent_define → agent → task → result, against a real registry+agent-mcp server`
  - observable: `the test imports NO packages/ai/**/src/** path (only the MCP wire client + the compiler CLI bin); a freshly-composed agent runs a task and returns a result; the composed prompt contains the discovered components in order`
  - negative-control: `reintroducing a deep src import (e.g. buildHarness / factory.ts) is caught by a static import-scan assertion that fails the test`
  - delivered-by: `composition-journey-e2e`

- `[dod.6]` **A real model walks the composition journey end-to-end and emits the model-independent invariants — closes COVERAGE.md §B 'No live-model e2e tests' for the authoring lane (CLAUDE.md verification standard #5). (behavioral)** — A real model walks the composition journey end-to-end and emits the model-independent invariants — closes COVERAGE.md §B 'No live-model e2e tests' for the authoring lane (CLAUDE.md verification standard #5)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `AGENT_MCP_LIVE=1 driving a real model through component_search → agent_define → agent → task via the real ClaudeCliProvider/Orchestrator`
  - observable: `stopReason completed; the model actually issues an agent_define call the scripted provider couldn't fake; the run is skipped (not failed) when AGENT_MCP_LIVE is unset so CI stays offline`
  - negative-control: `an empty component registry makes agent_define raise COMPONENT_NOT_FOUND and the live run fails — proving the assertion drives real composition, not a canned reply`
  - delivered-by: `live-model-e2e`

- `[dod.7]` **The flat systemPrompt authoring path is a deprecated permanent compat shim, mutually exclusive with components; the 11-tool runtime hot path and required-arg counts are unchanged — SPEC §8/§9/§14-F (agent-mcp@2.0.0). (behavioral)** — The flat systemPrompt authoring path is a deprecated permanent compat shim, mutually exclusive with components; the 11-tool runtime hot path and required-arg counts are unchanged — SPEC §8/§9/§14-F (agent-mcp@2.0.0)..
  - given: <preconditions the consumer is in>
  - when: <the consumer performs the interaction>
  - then: <the consumer observes the result that proves success>
  - entrypoint: `agent_create({name,provider,systemPrompt}) compat shim + agent({name}) runtime tool + guide`
  - observable: `agent_create with systemPrompt wraps it as one private inline component and runs identically to 1.0.1; supplying BOTH systemPrompt and components raises VALIDATION_ERROR; agent({name}) === agent({name,platform:'claude_code',context:{}}); the delegation surface a sub-agent sees is exactly the 11 runtime tools (0 authoring/discovery tools); package.json is 2.0.0`
  - negative-control: `a test that counts delegation-surface tools fails if any *_define/*_list/*_search tool leaks into the runtime delegation set`
  - delivered-by: `compat-shim, versioning`

- `[dod.8]` **agent-mcp/agent-mcp-types source is modified ONLY under this plan's explicit opt-in states and the change is reversible; no modification occurs before the authoring-design gate records the modification scope — honors the owner's byte-identical back-out guarantee. (structural)** — agent-mcp/agent-mcp-types source is modified ONLY under this plan's explicit opt-in states and the change is reversible; no modification occurs before the authoring-design gate records the modification scope — honors the owner's byte-identical back-out guarantee..
