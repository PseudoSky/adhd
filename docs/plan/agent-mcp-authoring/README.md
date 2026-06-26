# agent-mcp Authoring & Discovery — registry-backed composition over MCP (agent-mcp@2.0.0)

An orchestrating agent composes a NEW agent from registry components over MCP
only — `prompt_types_list` → `component_search` (auto-ranked) → `component_read`
→ `tool_list`/`model_list`/`policy_list` → `agent_define`/`component_define`
(declarative idempotent upserts with auto-enrichment) → `agent` → `task` —
without reading any agent file or store internals, while the 11-tool runtime hot
path and the agent-mcp byte-back-out guarantee both hold.

> **Plan set & ordering.** This is **Plan 8 of 9** for the Agent Registry
> initiative (source spec: `docs/plan/agent-registry/SPEC_AGENT_MCP_TOOL_INTERFACE.md`,
> ratified — supersedes the api-designer stab on the points in its §13). It
> **DEPENDS ON Plan 6 (`agent-mcp-refactor`)**, which makes the runtime
> registry-backed (system prompt resolved via `compileAgent` + a `composed_prompts`
> cache at session start). This plan adds the **definition lane** on top of that
> runtime. It overlaps **Plan 7 (`agent-registry-migration`)** — corpus import —
> but does not depend on it. See `docs/plan/plan-index.json` and the initiative
> sequencing README at `docs/plan/agent-registry/CLOSEOUT.md`.
>
> **Cross-plan dependency.** `dag.json` declares `depends_on_plans:
> ["agent-mcp-refactor"]`. `compileAgent`, the `composed_prompts` cache, and the
> registry-backed session-start path are Plan 6 deliverables consumed here; they
> are `assumed_baseline` and must be present (packages built + tsconfig paths)
> before `discovery-tools`/`agent-define` can go green.
>
> **Anchor-vocabulary linkage to Plan 7 (explicit).** `component_define`'s
> enrichment (SPEC §5.3 step 2 / §10.2) resolves component content against a
> **use-case anchor vocabulary**. This plan ships a small **SEED** anchor set in
> `embedding-substrate` so discovery/composition prove on fixtures here and now.
> **Plan 7 (`agent-registry-migration`) is the ANCHOR backfill**: its
> sonnet-consolidation state produces the canonical corpus-derived use-case
> vocabulary, and its dataset-build state writes those use-cases + anchor embeddings
> (via this plan's substrate) into the registry. The enrichment seam is identical;
> only the anchor SET grows seed → corpus. The two plans therefore do **not** depend
> on each other in `dag.json` (Plan 8 proves on seed anchors; Plan 7 backfills the
> real ones) — the dependency is a documented sequencing relationship, recorded in
> `CLOSEOUT.md` §sequencing, not a `depends_on_plans` edge.
>
> **HARD CONSTRAINT — agent-mcp back-out guarantee.** `packages/ai/agent-mcp/`
> and `packages/ai/agent-mcp-types/` work today and the owner retains the right
> to back them out. This plan is the FIRST sanctioned modifier and only under the
> opt-in, reversible **modification manifest** recorded in `decisions.md`
> (`def:agent-mcp-modification-manifest`). Every state touching agent-mcp src
> carries the non-regression guard (`nx test agent-mcp` green); `[dod.8]` proves
> no src file changes outside the manifest and the change set reverts to the
> baseline ref byte-for-byte.

## Consumer

An **orchestrating agent** (or an operator) that receives a *task packet* and
must instantiate a sub-agent using only what is in the registry — without reading
another agent's file, without touching a store API, and without knowing the
schema. Its only surface is the agent-mcp MCP tool set. Today such an agent can
only *run* an already-defined agent (`agent` → `task` → `result`) or author one
flat-`systemPrompt` blob via `agent_create`; it cannot *compose* an agent from
shared, typed components, and it cannot *discover* what components exist. After
this plan it composes declaratively from the registry over MCP.

A secondary consumer is the **agent-mcp maintainer**, who must be able to back
out the whole definition lane and restore agent-mcp to its pre-plan bytes.

## Value delta

- **Before:** the only agent-facing write path is `agent_create({systemPrompt})`
  — a flat blob with no shared components, no typed slots, no discovery. There is
  no way over MCP to ask "what role/rule/capability components exist for this
  task," to author a reusable component, or to compose an agent from components.
  The registry (Plans 1–5) is reachable only via the `agent-registry compile` CLI
  and direct store imports — invisible to a composing agent. The registry stores
  speak `slug`; there is no `name↔slug` seam, so a slug would leak on any wire.
- **After:** an agent composes a new agent in one declarative `agent_define`
  upsert over discovered components, authoring any missing component with
  `component_define` (content only — the registry auto-files summary, use-cases,
  and weights via a deterministic enrichment pipeline). Eleven read-only discovery
  tools expose the full vocabulary (`component_search` semantic, `prompt_types_list`,
  `tool_list`, `model_list`, `policy_list`, …). `name` is the only identity on the
  wire; `slug` never leaks. The 11-tool runtime hot path is byte-for-byte
  unchanged — a small model running a task still sees exactly 11 tools, 0 of them
  authoring/discovery. `agent_create({systemPrompt})` survives as a deprecated,
  permanent compat shim. Version is `agent-mcp@2.0.0`.

## Glossary

> Consumer-owned vocabulary for THIS plan (the agent-mcp authoring/discovery
> surface and its registry contract). These names appear in DoD outcome text
> deliberately.

- **component** — a typed, named, versioned unit of prompt content (`role`,
  `rule`, `capability`, `process`, …) in the registry. Authored content-only via
  `component_define`; the registry files its summary/use-cases/weights.
- **agent_define / component_define** — the two declarative, idempotent,
  name-keyed upsert MCP tools that mutate registry state (create-or-replace,
  version-bumped, idempotent on no-change).
- **component_search** — the semantic discovery MCP tool: `query → use-cases →
  components`, auto-ranked, returning summaries (not full bodies).
- **enrichment pipeline** — the deterministic write-path that, on
  `component_define`, embeds content, resolves weighted use-case links against
  use-case anchor embeddings, and derives an extractive summary. No agent
  hand-assigns weights or use-cases.
- **name↔slug seam** — the translation at the MCP tool boundary: the wire speaks
  `name`; the stores keep `slug` internally; `slug = toSlug(name)`. No `slug`
  appears in any tool schema, output, or `guide` text.
- **systemPrompt** — the flat system-prompt string of agent-mcp 1.x. Here it
  becomes a deprecated permanent compat shim (wrapped as one private inline
  component), mutually exclusive with a component list.
- **delegation surface** — the set of tools a delegated sub-agent sees. It stays
  exactly the 11 runtime tools; authoring/discovery tools are never in it.
- **modification manifest** — the enumerated list (in `decisions.md`) of the
  agent-mcp{,-types} src files this plan is allowed to touch, plus the pre-plan
  baseline git ref — the mechanism of the back-out guarantee.
- **`DEMO.md`** — the initiative's Cumulative Usability Gate contract
  (`docs/plan/agent-registry/DEMO.md`): the round-trip, real-input demo the
  orchestrator runs before a phase is review-ready. `[dod.5]` is this plan's rung of it.
- **`COVERAGE.md`** — the initiative's path-coverage ledger
  (`docs/plan/agent-registry/COVERAGE.md`) recording which GOAL capabilities are
  proven vs not-yet-covered. `[dod.6]` closes its §B "no live-model e2e" entry for this lane.
- **`CLAUDE.md`** — the project's verification standard (real components, teeth,
  exit-code-gated, live-model proof). `[dod.6]` satisfies its standard #5 for the authoring lane.

## Definition of Done

- `[dod.1]` **An agent authors a component over MCP with content only; the registry auto-files it (summary, use-cases, weights). (behavioral)** — GOAL §Shared Components/Single Authorship + §Maintainability-Authoring.
  - given: a running agent-mcp server backed by a real registry with seeded use-case anchors
  - when: the agent calls `component_define({name,type,content,shared})` supplying only content-bearing fields
  - then: the response carries an auto-derived summary and weighted use-cases the agent never supplied, and a re-define of identical content is an idempotent no-op
  - entrypoint: `component_define MCP tool ({name,type,content,shared})`
  - observable: `returns {summary (non-empty, auto-derived), use_cases:[{name,weight>0}], version} with NO agent-supplied weights/use-cases; a second identical define returns changed:false and does NOT churn the index (deterministic enrichment)`
  - negative-control: `stubbing the enrichment to skip embedding makes the use_cases array empty → the assertion fails`
  - delivered-by: `embedding-substrate, enrichment-pipeline, component-define`

- `[dod.2]` **An agent discovers components for a task by intent, auto-ranked, one call per slot. (behavioral)** — GOAL §Maintainability-Discovery; replaces manual taxonomy navigation (SPEC §6.2).
  - given: a registry holding components of several types, some matching a task intent and some unrelated
  - when: the agent calls `component_search({query, type})` with the task intent
  - then: components semantically matching the intent rank above unrelated ones, returned as cheap summaries
  - entrypoint: `component_search MCP tool ({query,type?,shared?,limit?})`
  - observable: `returns ranked results [{name,type,summary,score,shared}] where a query semantically matching a seeded component ranks it above an unrelated one (score-ordered); restricting type fills exactly one grammar slot`
  - negative-control: `replacing the semantic ranker with insertion-order returns the unrelated component first → assertion fails`
  - delivered-by: `discovery-tools`

- `[dod.3]` **An agent composes a NEW agent from components in ONE declarative idempotent upsert. (behavioral)** — GOAL §Maintainability-Onboarding (compose without reading another agent's file); SPEC §5.2/§7.
  - given: the discovered components, a model name, and tool/policy names from the discovery lane
  - when: the agent calls `agent_define({name,model,components[],tools?,policy?})`
  - then: the agent is composed with a compiled preview, and an identical re-define is an idempotent no-op while a changed composition bumps the version and busts the cache
  - entrypoint: `agent_define MCP tool ({name,model,components[],tools?,policy?})`
  - observable: `first call returns {version:1, compiled_preview (contains each component's content in position order), composed_prompt_id, changed:true}; identical re-define returns changed:false with no version bump; a changed component list bumps version and busts the composed_prompt cache`
  - negative-control: `removing the content-hash compare makes an identical re-define report changed:true / bump version → assertion fails`
  - delivered-by: `agent-define`

- `[dod.4]` **`name` is the only identity on the wire; `slug` never leaks through the MCP boundary. (behavioral)** — SPEC §3 (Decision E), the translation-seam refactor.
  - given: registry stores that keep `slug` internally and tools that accept human display names
  - when: the agent reads or writes any agent/component through an authoring/discovery tool
  - then: every response is keyed by `name` with no `slug` field anywhere, and a display name resolves to its slug-form row
  - entrypoint: `any authoring/discovery tool output (component_read, agent_read, component_search, agent_define)`
  - observable: `every tool response JSON contains a name field and NO slug key anywhere (recursive scan); passing a human 'Display Name' resolves to the same row as its slug form`
  - negative-control: `leaving a raw store object (with .slug) in any tool response → the recursive no-slug scan fails`
  - delivered-by: `name-slug-seam, discovery-tools, agent-define, component-define`

- `[dod.5]` **The full SPEC §7 task-packet→agent journey runs over the PUBLIC MCP surface only (zero internal/src imports), and the agent RUN step is driven by a REAL provider — not a scripted/mock provider. (behavioral)** — the Cumulative Usability Gate (DEMO.md).
  - given: a real registry + agent-mcp server reachable over the MCP wire, the compiler CLI bin, and a REAL provider available for the run step (default `claudecli` — the locally-authenticated `claude` CLI; gated by `AGENT_MCP_LIVE`/provider availability)
  - when: an MCP client drives the whole §7 journey end-to-end, with the discovery + `agent_define` wiring asserted deterministically and the `agent → task → result` run executed against the real provider
  - then: a freshly-composed agent runs a task through the real provider and returns a result, and the test imports no package src internals; when no real provider is available the RUN step skips (not fails) while the deterministic wiring assertions still run
  - entrypoint: `an MCP client driving the §7 journey (prompt_types_list → component_search → component_read → tool_list → model_list → policy_list → component_define → agent_define → agent → task → result) over a real registry+agent-mcp server with the run step on a REAL provider, exercised by packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts`
  - observable: `composition-journey-e2e.test.ts imports NO packages/ai/**/src/** path (only the MCP wire client + the compiler CLI bin); the composed prompt contains the discovered components in order (deterministic, always asserted); the agent→task→result run uses a REAL provider (no scripted/mock provider on the run path) and returns a result, skipping cleanly when no provider is available`
  - negative-control: `reintroducing a deep src import into packages/ai/agent-mcp/src/__tests__/composition-journey-e2e.test.ts (e.g. buildHarness / factory.ts) trips its static import-scan assertion and the test fails red; substituting a scripted/mock provider on the run path trips the real-provider guard`
  - delivered-by: `composition-journey-e2e`

- `[dod.6]` **A REAL model walks the composition journey end-to-end across a real-provider MATRIX — `anthropic` (env OAuth / Claude Max keychain), `claudecli`, and `lmstudio` (OpenAI-compatible local) — each emitting the model-independent invariants; NEVER a scripted/mock provider. (behavioral)** — closes COVERAGE.md §B "No live-model e2e tests" for the authoring lane (CLAUDE.md verification standard #5).
  - given: the live matrix is enabled by `AGENT_MCP_LIVE=1`, and EACH provider's prerequisites are met — (1) `anthropic` with `useClaudeOauth:true` (macOS keychain, no API key), (2) `claudecli` (`claude` CLI installed, configured via `{claudePath,model}`), (3) `lmstudio` running and reachable at `LMSTUDIO_BASE_URL` (`{model,baseURL}`, OpenAI-compatible) — plus a seeded registry
  - when: for each available provider, the live model is tasked to compose and run an agent through that REAL provider + Orchestrator — `component_search → agent_define → agent → task`
  - then: on each provider the model ITSELF issues a real `agent_define` tool call a scripted provider could not fake, and the task completes (`stopReason: completed`); a provider whose prerequisites are absent is skipped (not failed) per-provider; the whole matrix is skipped offline when `AGENT_MCP_LIVE` is unset so CI stays offline
  - entrypoint: `AGENT_MCP_LIVE=1 driving a real model across the {anthropic, claudecli, lmstudio} provider matrix through component_search → agent_define → agent → task via each real provider's Orchestrator, exercised by packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts`
  - observable: `authoring-live-e2e.test.ts: for each enabled provider in {anthropic (useClaudeOauth keychain), claudecli, lmstudio (baseURL)} the model issues a real agent_define call (not fakeable by a scripted provider) and stopReason is completed; per-provider availability gates each case (skip-not-fail when creds/service absent); the whole matrix is skipped (not failed) when AGENT_MCP_LIVE is unset so CI stays offline; README/USAGE documents how to enable each provider`
  - negative-control: `seeding packages/ai/agent-mcp/src/__tests__/authoring-live-e2e.test.ts with an empty component registry makes the model's agent_define raise COMPONENT_NOT_FOUND on every enabled provider and the live run fails — proving each provider drives real composition, not a canned reply; swapping any provider for a scripted/mock provider trips the no-mock-on-live-path guard`
  - delivered-by: `live-model-e2e`

- `[dod.7]` **The flat `systemPrompt` authoring path is a deprecated permanent compat shim, mutually exclusive with components; the 11-tool runtime hot path and required-arg counts are unchanged. (behavioral)** — SPEC §8/§9/§14-F (agent-mcp@2.0.0).
  - given: an agent-mcp 2.0.0 server with both the runtime and authoring lanes loaded
  - when: a caller uses `agent_create({systemPrompt})`, supplies both systemPrompt and components, and a sub-agent is delegated a task
  - then: the flat prompt runs as one inline component identically to 1.0.1, the conflicting input is rejected, and the delegated sub-agent sees exactly the 11 runtime tools
  - entrypoint: `agent_create({name,provider,systemPrompt}) compat shim + agent({name}) runtime tool + guide`
  - observable: `agent_create with systemPrompt wraps it as one private inline component and runs identically to 1.0.1; supplying BOTH systemPrompt and components raises VALIDATION_ERROR; agent({name}) === agent({name,platform:'claude_code',context:{}}); the delegation surface a sub-agent sees is exactly the 11 runtime tools (0 authoring/discovery tools); package.json is 2.0.0`
  - negative-control: `a test that counts delegation-surface tools fails if any *_define/*_list/*_search tool leaks into the runtime delegation set`
  - delivered-by: `compat-shim, versioning`

- `[dod.8]` **agent-mcp/agent-mcp-types source is modified ONLY under this plan's explicit opt-in states and the change is reversible; no modification occurs before the `authoring-design` gate records the modification manifest. (structural)** — honors the owner's byte-identical back-out guarantee.
  - entrypoint: `git diff against the pre-plan baseline ref recorded in decisions.md (def:agent-mcp-modification-manifest) + the agent-mcp non-regression guard (nx test agent-mcp)`
  - observable: `every touched agent-mcp src file is listed in decisions.md's modification manifest; the full pre-existing agent-mcp test suite stays green at every state; check_manifest.py reports the change set is a subset of the manifest (reverting this plan's commits restores agent-mcp to the baseline ref byte-for-byte)`
  - negative-control: `touching an agent-mcp src file not in the recorded manifest makes check_manifest.py's manifest-diff check fail`
  - delivered-by: `authoring-design, audit-final`

## State machine

| phase | state | kind | proves |
|---|---|---|---|
| architecture | `authoring-design` | work | `decisions.md`: embedding-source decision, name↔slug seam policy, the agent-mcp **modification manifest** (opt-in reversible gate), agent_define transaction + Plan-6 sequencing |
| enrichment | `embedding-substrate` | work | deterministic embedding + seeded use-case anchor embeddings; cosine ranks a match first |
| enrichment | `enrichment-pipeline` | work | `enrichComponent`: embed → weighted use-case links → extractive summary; idempotent on identical content |
| seam | `name-slug-seam` | work | `name↔slug` translation bridge; no slug on any MCP response |
| discovery | `discovery-tools` | work | the 11 read tools (`component_search` semantic + `*_list` + `agent_*`) over the real stores |
| authoring | `component-define` | work | content-only upsert that enriches on write, version-bumps on change, idempotent |
| authoring | `agent-define` | work | declarative composition upsert (full-replace, version-bump, idempotent, compiled preview, typed errors) |
| compat | `compat-shim` | work | flat `systemPrompt` → inline component; mutual-exclusion error; guide deprecation; 11-tool surface intact |
| compat | `versioning` | work | `agent-mcp@2.0.0` + CHANGELOG |
| e2e | `composition-journey-e2e` | work | SPEC §7 journey over the MCP wire + CLI bin, zero internal imports; the agent RUN step on a REAL provider (no mock on the run path) |
| e2e | `live-model-e2e` | work | `AGENT_MCP_LIVE`-gated real-model journey across the `{anthropic, claudecli, lmstudio}` provider MATRIX; per-provider availability gates each case; empty-registry teeth |
| audit | `code-review` | review | architect-reviewer diff-read against CLAUDE.md + decisions.md + the back-out guarantee; default NEEDS-WORK |
| audit | `audit-final` | audit | `audit_authoring.py --phase final`: every `[dod.N]` + back-out-guarantee checks |

## Reviewer routing

`code-review` → **architect-reviewer (opus)**. This plan adds a new MCP lane AND
touches agent-mcp src for the first sanctioned time. The reviewer reads the full
`authoring-design..live-model-e2e` diff against CLAUDE.md (layer/platform
isolation, `@adhd/` imports, I-prefixed interfaces, JSDoc, the "Proving features
actually work" standard) AND `decisions.md`/SPEC contracts. Must verify: the
back-out guarantee (every changed agent-mcp src file in the manifest; the 11-tool
delegation surface unchanged; the runtime hot path has no new required args); no
`slug` on the wire; the enrichment pipeline is deterministic/idempotent;
`agent_define`/`component_define` are true upserts; the flat `systemPrompt` is a
computed compat shim, not a competing source of truth. Default verdict
NEEDS-WORK; a PASS must be explicitly justified. On NEEDS-WORK, fixes go back to
the implementation states, then re-review. Mutates only `review.md` +
`scripts/review_gate.py`.
