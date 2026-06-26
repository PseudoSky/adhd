# DEMO.md — The Cumulative Usability Demo (0→complete, one-shot path coverage)

> **Status:** authoritative gate document for the agent-registry initiative.
> **Owner:** the orchestrator (`workflow:plan-orchestrator`).
> **Rule (binding):** *Before declaring ANY phase ready for review, the orchestrator MUST run
> the cumulative demo up through that phase and confirm every path the phase introduced is
> EXERCISED — not merely present.* A phase is not "ready for review" until its slice of this demo
> is green. By the final phase, ONE run of the flow below exercises every path built across all
> phases. This is distinct from DoD (which proves each clause's observable in isolation) — see
> reflections `01KVZWVTD8…` (Cumulative Usability Gate) and `01KVZWW8Q7…` (DoD-as-demonstration).

---

## 0. Why this document exists (the three failure modes it closes)

Driving this initiative surfaced three ways a "green" build can still be unusable:

1. **Green-but-empty.** agent-compiler reached 39/39 DoD-green + APPROVED review while the registry
   held **zero real agents** and nothing had ever been compiled from the real corpus. DoD proved
   each clause against *seeded fixtures*, never the integrated system against real input.
2. **Green-but-inert.** A naive `##`-header decomposition of `qa-expert.md` produced 3 components
   with **no `context_condition`, all version-pinned, shared by zero other agents** — so compiling
   them is byte-identical to compiling one blob. The differential code paths (conditional inclusion,
   version-drift cache, cross-agent sharing) **exist and are unit-tested but were never triggered**.
3. **Green-but-untyped/unrun.** The package shipped "39/39 green" while `nx typecheck` was red (13
   errors hidden because vitest doesn't type-check), and the compiled agent was never run through a
   real model/runtime.

**The cure:** a single fixture set deliberately engineered so that compiling/running it **forces
every differential path to fire**, plus a real-corpus ingest, plus a real-model execution — run
cumulatively so each phase inherits and re-exercises everything below it.

---

## 1. Principles

- **Cumulative inheritance.** Phase N's demo = Phase N−1's demo + the new paths Phase N introduced.
  The fixture set is seeded ONCE into a **persistent** DB (`demo/tmp/registry.db`); every phase
  reads/extends the same state. No throwaway per-test tmp DBs.
- **Exercise, don't assert-exists.** Every path must be *triggered with data that makes it matter*:
  a conditional component that is **included in one context and excluded in another**; an **unpinned**
  component that, when bumped, **busts the cache**; a **shared** component referenced by **≥2 agents**
  whose single edit changes both compiled outputs.
- **Real input + real output.** The flow ingests a **real** corpus agent (`qa-expert.md`) and ends by
  **running the compiled agent through a real model** (agent-mcp's `ClaudeCliProvider`; full
  Orchestrator once Plan 6 lands).
- **One-shot coverage.** The final §7 flow, run once, touches every row, every resolver branch, every
  emit format, the cache (miss+hit+drift), policy (direct+inherited), and execution. The §8 matrix is
  the checklist.
- **Boundary.** agent-mcp / agent-mcp-types are **consumed, never modified**. Verify
  `git status packages/ai/agent-mcp packages/ai/agent-mcp-types` is clean after every run.
- **Gate on exit codes**, never `| grep -q`. better-sqlite3+vitest can segfault at teardown *after*
  passing — trust the reported pass count + exit status.

---

## 2. The canonical fixture set (engineered to fire every path)

Seeded once via the store APIs into `demo/tmp/registry.db`. Every value below is raw data the demo
needs; nothing is looked up externally except the real `qa-expert.md` (§2.7).

### 2.1 Platforms (Plan 2 — `platforms`)
| slug | header_format |
|---|---|
| `claude_code` | `yaml_frontmatter` |
| `claude_api`  | `json_object` |

### 2.2 Tools + bindings (Plan 2 — `tool_types`, `tools`, `tool_platform_bindings`)
Canonical tool → per-platform alias + availability. (Identity where the corpus already uses an alias.)
| canonical (`tools.slug`) | type | claude_code alias | claude_api alias | claude_api availability |
|---|---|---|---|---|
| `file_read`  | `fs`     | `Read`      | `read_file`   | `available` |
| `file_grep`  | `fs`     | `Grep`      | `grep`        | `available` |
| `file_glob`  | `fs`     | `Glob`      | `glob`        | `available` |
| `shell_exec` | `exec`   | `Bash`      | `bash`        | `available` |
| `web_search` | `net`    | `WebSearch` | `web_search`  | `available` |
| `human_input`| `hitl`   | `AskUserQuestion` | `(n/a)` | **`unavailable`** ← exercises the drop-unavailable branch |

> **Path forced:** `resolveTools` MUST drop `human_input` on `claude_api` (availability=`unavailable`)
> and emit platform aliases (not canonical names) on both platforms.

### 2.3 Provider + model (Plan 3 — `provider_providers`, `provider_models`, `provider_model_platform_bindings`)
| model (`provider_models.slug`) | provider | claude_code alias | claude_api alias |
|---|---|---|---|
| `claude_sonnet_4_6` | `anthropic` | `sonnet` | `claude-sonnet-4-6` |

> **Path forced:** `resolveModel` returns `sonnet` on claude_code, `claude-sonnet-4-6` on claude_api,
> from the SAME `model_hint`. Plus a **fallback** check (§2.8 agent uses an unbound hint → canonical id).

### 2.4 Policy (Plan 4 — `policy_policy_types`, `policy_policy_templates`, taxonomy, `policy_agent_policies`)
| template (`policy_policy_templates.slug`) | rules (constraint text) | attachment |
|---|---|---|
| `no-credentials` | "Never write API keys or secrets to files, task output, or handoff text." | **direct** to `demo-reviewer` |
| `reviewer-posture` | "Default verdict is NEEDS-WORK. Explicitly justify any PASS." | **inherited** via taxonomy category `04-quality` |

> **Path forced:** `resolveForAgent` returns BOTH a direct row and a category-inherited row
> (`inherited_from = 04-quality`), and the compiler folds both into the `## Policies` block.

### 2.5 Shared components (Plan 1 — referenced by ≥2 agents → proves single-authorship)
| component (`registry_components.slug`) | type | is_shared | content (v1) |
|---|---|---|---|
| `shared-grounding-rule` | `rule` | `1` | "Numbers MUST reflect actual tool output, not estimates." |
| `shared-reviewer-posture` | `rule` | `1` | "Default verdict is NEEDS-WORK; justify any PASS." |

Both are attached to **two** agents (`demo-reviewer` AND `qa-expert`, §2.6/§2.7).

> **Path forced:** editing `shared-grounding-rule` → **new version** → both agents' compiled output
> changes from ONE write (the N-edit→1-edit goal). Used by the version-drift step (§2.8).

### 2.6 Synthetic agent `demo-reviewer` (engineered to fire conditional inclusion + sharing + policy + 2 platforms)
- `registry_agents`: slug `demo-reviewer`, name "Demo Reviewer", model_hint `claude_sonnet_4_6`,
  taxonomy_category `04-quality`.
- Components (junction `registry_agent_components`), in `position` order:
  | pos | component | version_pin | context_condition | is_required |
  |---|---|---|---|---|
  | 1 | `shared-reviewer-posture` | v1 (pinned) | — | true |
  | 2 | `demo-reviewer-identity` | v1 (pinned) | — | true |
  | 3 | `crit-security` | v1 (pinned) | `{"ticket_type":"security"}` | false |
  | 4 | `crit-review`   | v1 (pinned) | `{"ticket_type":"review"}`   | false |
  | 5 | `shared-grounding-rule` | **NULL (unpinned)** | — | true |
  - `crit-security` content: "SECURITY CRITERIA: validate all inputs at the boundary; check authz."
  - `crit-review` content:   "REVIEW CRITERIA: assess readability, naming, and test coverage."
- Tool grants (`agent_tools`): `file_read`, `file_grep`, `web_search`, `human_input`.
- Direct policy: `no-credentials`.

> **Paths forced by `demo-reviewer`:**
> - **Conditional inclusion:** compile `{ticket_type:security}` → body has SECURITY text, NOT REVIEW;
>   `{ticket_type:review}` → REVIEW not SECURITY; **empty context → neither**.
> - **Sharing:** pos-1 + pos-5 are shared with `qa-expert`.
> - **Unpinned drift:** pos-5 (`shared-grounding-rule`, version_pin NULL) tracks latest → bumping it
>   busts this agent's cache (§7 step 9).
> - **Policy direct+inherited:** `no-credentials` (direct) + `reviewer-posture` (inherited via `04-quality`).
> - **Tool availability:** `human_input` dropped on claude_api.
> - **Two emit formats:** claude_code yaml_frontmatter vs claude_api json_object.

### 2.7 Real-corpus agent `qa-expert` (proves real ingest, not just synthetic fixtures)
Ingested from `/Users/nix/dev/ai/claude-agents/categories/00-active/agents/qa-expert.md`.
Frontmatter (raw, as of last run — re-read at ingest time; the file is the source of truth):
```yaml
name: qa-expert
description: "Use this agent when you need comprehensive quality assurance strategy, test planning across the entire development cycle, or quality metrics analysis to improve overall software quality."
tools: Read, Grep, Glob, Bash, ListMcpResourcesTool, ReadMcpResourceTool, WaitForMcpServers, AskUserQuestion, WebSearch, Monitor, LSP, mcp__memory-server__*, SendMessage, TaskGet, TaskList
model: sonnet
```
- Body decomposes on top-level `##` into: `qa-expert-section-1` (preamble), `qa-expert-development-workflow`,
  `qa-expert-tool-grounding-requirements`.
- **ALSO attach the two shared components** (`shared-reviewer-posture` pos-0, `shared-grounding-rule`
  pos-99 unpinned) so `qa-expert` and `demo-reviewer` genuinely share rows.
- Tools: ingest the 15 frontmatter aliases as identity bindings (canonical lowercased → original alias);
  `mcp__memory-server__*` and `LSP` etc. as passthrough.
- Model: `sonnet` (identity binding) — and one variant run uses an **unbound** hint to force the
  fallback branch (§2.8).

> **Paths forced by `qa-expert`:** real-file parse; 15-tool round-trip; identity bindings; the
> documented honest limitation that a header-split yields *inert* components UNLESS shared (which is
> why we cross-attach the two shared components — to make at least one real corpus agent exercise sharing).

### 2.8 Fallback + drift fixtures
- **Model fallback:** a throwaway agent `demo-nobind` with `model_hint = ghost-model-xyz` (no binding)
  → `resolveModel` returns the canonical id unchanged (records the fallback decision).
- **Version drift:** after the first full compile, bump `shared-grounding-rule` to v2
  ("Numbers MUST cite file:line or tool output — estimates are defects.") → both agents (which attach it
  **unpinned**) MISS the cache on recompile and pick up the new text.

---

## 3. Environment + invocation primitives

```bash
WT=/Users/nix/dev/node/adhd-agent-registry
DEMO=$WT/docs/plan/agent-registry/demo
DB=$DEMO/tmp/registry.db
SKILL=/Users/nix/.claude/plugins/cache/sox-subagents/workflow/0.8.22/skills/plan-state-machine/scripts
QA=/Users/nix/dev/ai/claude-agents/categories/00-active/agents/qa-expert.md
CLAUDE_CLI=/Users/nix/.local/bin/claude   # real model for §7 step 11
```
- **Migrations (one shared DB, dependency order):** run each package's drizzle migrate against `$DB`:
  `agent-registry → agent-tool-registry → agent-provider → agent-policy → agent-compiler`.
- **Seed:** via store APIs (`ComponentStore.create`, `AgentStore`, `CompositionStore.attach`,
  `AgentToolStore.grant`, tool `BindingStore`, provider `ModelStore`, `AgentPolicyStore`,
  `PolicyTemplateStore`).
- **Compile (CLI):** `node <agent-compiler dist>/cli/compile.js compile <slug> --platform <p> [--context '<json>'] [--format json] --db $DB`
  (build agent-compiler first; resolve `@adhd/*` within the workspace — standalone dist import fails on
  `@adhd` resolution, a known limitation).
- **Run (agent-mcp provider):** `createProvider({type:'claudecli', claudePath:$CLAUDE_CLI, model:'sonnet', timeoutMs:120000}, {}).chat({messages, tools, signal})` — deep-imported from
  `packages/ai/agent-mcp/src/providers/factory.ts` (NOT exported from the index — backlog item).

---

## 4. Per-phase cumulative demo (each phase inherits all rows below it)

For each phase: **builds** → **paths introduced** → **demo steps (data subset)** → **observable that
proves it** → **what it leaves for downstream**. Run the demo *up through* the phase before declaring
it review-ready.

### Phase 1 — agent-registry (storage + composition)
- **Builds:** `registry_components`/`_versions`, `registry_agents`, `registry_agent_components`
  (junction with `position`/`version_pin`/`context_condition`/`is_required`), `registry_prompt_types`,
  `registry_composed_prompts`, taxonomy; `resolveComposition`.
- **Paths introduced:** version split (head+versions); junction ordering by `position`;
  context-condition filtering; version-pin vs unpinned; required-component enforcement.
- **Demo steps:** seed §2.5 shared components + §2.6 `demo-reviewer` (incl. the conditioned pos-3/4 and
  the unpinned pos-5) + §2.7 `qa-expert` body. Call `resolveComposition('demo-reviewer', {ticket_type:'security'})`.
- **Observable (proves built + every path):** returned ordered list = [posture, identity, crit-security,
  grounding] — **crit-review EXCLUDED**, crit-security INCLUDED, in position order, with the unpinned
  grounding resolved to its latest version. Re-run with `{ticket_type:'review'}` → crit-review in,
  crit-security out. Empty context → both crit-* out. A missing required component → `REQUIRED_COMPONENT_EXCLUDED` error.
- **Leaves downstream:** all agents/components/junctions the later phases resolve against.

### Phase 2 — agent-tool-registry (platform tool resolution)
- **Builds:** `platforms`, `tool_types`, `tools`, `tool_platform_bindings`, `agent_tools`; `BindingStore.resolve`.
- **Paths introduced:** canonical→platform-alias join; `availability=unavailable` drop; per-platform divergence.
- **Demo steps:** seed §2.1/§2.2; grant §2.6 tools to `demo-reviewer`; `resolveTools('demo-reviewer','claude_code')`
  and `(...,'claude_api')`.
- **Observable:** claude_code → `[Read, Grep, WebSearch, AskUserQuestion]`; claude_api →
  `[read_file, grep, web_search]` (**AskUserQuestion/human_input DROPPED**, aliases NOT canonical).
- **Leaves downstream:** the `tools:` header the compiler emits.

### Phase 3 — agent-provider (model resolution + adapter contract)
- **Builds:** `provider_providers`, `provider_models`, `provider_model_platform_bindings`,
  `provider_tool_formats`; `ModelStore.resolveModelId`; `ProviderAdapter` contract (in agent-mcp-types).
- **Paths introduced:** model_hint→platform model id; missing-binding fallback to canonical.
- **Demo steps:** seed §2.3; `resolveModel('demo-reviewer','claude_code')`, `(...,'claude_api')`, and
  `resolveModel('demo-nobind','claude_code')` (§2.8).
- **Observable:** `sonnet` / `claude-sonnet-4-6` from the same hint; `ghost-model-xyz` returns unchanged
  (fallback) and records the decision.
- **Leaves downstream:** the `model:` header.

### Phase 4 — agent-policy (governance, direct + inherited)
- **Builds:** `policy_policy_types`, `policy_policy_templates`, `policy_agent_policies`, taxonomy link;
  `AgentPolicyStore.resolveForAgent` (3-query merge).
- **Paths introduced:** direct attachment; category-inherited cascade (`inherited_from`); empty→[] (neg control).
- **Demo steps:** seed §2.4; attach `no-credentials` direct to `demo-reviewer`, `reviewer-posture` to the
  `04-quality` category; `resolveForAgent('demo-reviewer')`.
- **Observable:** returns BOTH rows — `no-credentials` (direct) + `reviewer-posture` (`inherited_from=04-quality`);
  an agent with no policies → `[]`.
- **Leaves downstream:** the `## Policies` constraint block.

### Phase 5 — agent-compiler (the convergence)
- **Builds:** `compileAgent`, resolve layer (delegates to 1–4), emit (`markdown`=yaml_frontmatter /
  `json`=json_object dispatched on `header_format`), CLI bin, `composed_prompts` cache.
- **Paths introduced:** orchestration of all 4 resolvers; per-`header_format` dispatch; `context_hash`
  over (context + componentVersions + platform); lookup-before-assembly; reopen-proven hit; **version-drift miss**.
- **Demo steps:** §7 steps 5–10 (compile `demo-reviewer` × 2 platforms × 3 contexts; compile `qa-expert`;
  cache hit on recompile; **bump `shared-grounding-rule` → drift miss**).
- **Observable:** every emit/resolve/cache branch fires (see §8 matrix).
- **Leaves downstream:** the compiled artifacts + `composed_prompts` rows the runtime consumes.

### Phase 6 — agent-mcp-refactor (runtime integration) — **UNBUILT**
- **Builds (when built):** wire ProviderAdapter + compiled prompt into agent-mcp's Orchestrator
  (session/task/result, hook enforcement, tool loop).
- **Paths introduced:** registry-sourced prompt at task time; live policy enforcement (hook throws);
  full task lifecycle.
- **Demo steps (target):** register `demo-reviewer`'s compiled prompt via agent-mcp; run a task that
  triggers the `no-credentials`/budget enforcement hook; assert the hook FIRES (task fails with the
  enforcement error) — the live path that unit tests can't fake.
- **Observable (target):** task runs through the real Orchestrator; an enforced policy actually blocks a call.
- **Until built:** §7 step 11 runs at the **provider** layer only (`ClaudeCliProvider.chat`), and the
  matrix marks the Orchestrator/enforcement paths **NOT-YET-COVERED** (honest gap, not silent).

### Phase 7 — agent-registry-migration (bulk corpus) — **UNBUILT**
- **Builds (when built):** ingest the real 346-agent corpus with **semantic** (not header-split)
  decomposition into shared/conditioned components.
- **Demo steps (target):** migrate the corpus; assert ≥1 shared component is referenced by ≥N agents and
  that editing it changes all of them (real N-edit→1-edit); spot-compile 5 migrated agents and diff vs
  their original files.
- **Observable (target):** corpus round-trips; sharing is real at corpus scale.
- **Until built:** §7 ingests `qa-expert` + the cross-attached shared components as a single-agent proxy;
  the matrix marks corpus-scale sharing **NOT-YET-COVERED**.

---

## 5. The gate rule (binding on the orchestrator)

Before declaring **phase N** ready for review:
1. Run the cumulative flow (§7) **up through phase N** against the persistent `$DB`.
2. Confirm **every path in §8 owned by phases ≤ N is EXERCISED** (column "exercised by step" green),
   not merely present.
3. Confirm the **boundary** is clean (`git status packages/ai/agent-mcp packages/ai/agent-mcp-types`).
4. Confirm `nx typecheck` AND `nx build` AND `nx lint` are green for every touched package (the gap that
   hid 13 errors behind "39/39"): vitest alone is insufficient.
5. Record the run + the matrix state in `demo/README.md`. If any owned path is NOT exercised, the phase is
   **not** review-ready — fix the build or the fixture until it fires.

A phase that cannot exercise one of its paths with this fixture set is telling you the path is either
dead code or needs richer fixture data — both are review-blocking findings.

---

## 6. Honest coverage caveats (carried, never hidden)

- **Inert-decomposition risk:** a path is only "exercised" if the data makes it MATTER. `qa-expert`'s
  header-split components are inert in isolation; we make them count by cross-attaching the shared
  components (§2.7). The matrix distinguishes "fired with consequence" from "ran but no-op."
- **Provider vs Orchestrator:** until Phase 6, execution proves agent-mcp's **provider** runs the
  compiled prompt — NOT the full Orchestrator/enforcement. Marked explicitly in §8.
- **Single-agent vs corpus:** until Phase 7, sharing is proven across 2 agents, not the 346-agent corpus.

---

## 7. THE ONE-SHOT FLOW (run this; it touches everything built)

```bash
set -euo pipefail
# 0. Fresh persistent DB + migrations (Plans 1–5), dependency order
rm -f "$DB"; mkdir -p "$DEMO/tmp"
node "$DEMO/migrate-all.mjs" "$DB"                 # runs all 5 packages' drizzle migrations

# 1. Seed the canonical fixture set (§2.1–§2.6, §2.8)
node "$DEMO/seed-fixtures.mjs" "$DB"               # platforms, tools+bindings, model+bindings,
                                                   # policies+taxonomy, shared components,
                                                   # demo-reviewer (conditioned+unpinned+shared),
                                                   # demo-nobind (fallback)

# 2. Ingest the REAL corpus agent + cross-attach shared components (§2.7)
node "$DEMO/ingest-agent.mjs" "$DB" "$QA"          # parse frontmatter+body, decompose, attach shared rows

# 3–4. Phase 1–4 resolver assertions (prove each resolver path BEFORE compile)
node "$DEMO/assert-resolvers.mjs" "$DB"            # resolveComposition (incl/excl by context, required err),
                                                   # resolveTools (alias + drop-unavailable, 2 platforms),
                                                   # resolveModel (2 platforms + fallback),
                                                   # resolveForAgent (direct + inherited + empty[])

# 5. Compile demo-reviewer — 2 platforms × 3 contexts (claude_code + claude_api; security/review/empty)
for P in claude_code claude_api; do for C in '{"ticket_type":"security"}' '{"ticket_type":"review"}' '{}'; do
  node "$COMPILER_BIN" compile demo-reviewer --platform "$P" --context "$C" --db "$DB" > "$DEMO/tmp/demo-reviewer.$P.$(echo "$C"|tr -dc 'a-z').txt"
done; done

# 6. Compile the REAL agent qa-expert (claude_code + claude_api)
node "$COMPILER_BIN" compile qa-expert --platform claude_code --db "$DB" > "$DEMO/tmp/qa-expert.claude_code.txt"
node "$COMPILER_BIN" compile qa-expert --platform claude_api  --format json --db "$DB" > "$DEMO/tmp/qa-expert.claude_api.json"

# 7. Diff qa-expert.claude_code vs original (normalized) — faithful round-trip (minor syntactic diffs ok)
node "$DEMO/diff-roundtrip.mjs" "$QA" "$DEMO/tmp/qa-expert.claude_code.txt" > "$DEMO/tmp/diff.txt"

# 8. Cache HIT proof: recompile demo-reviewer (security, claude_code); composed_prompts row count unchanged, same id
node "$DEMO/assert-cache-hit.mjs" "$DB"

# 9. Version-DRIFT miss proof: bump shared-grounding-rule → v2; recompile both agents → NEW rows, changed content
node "$DEMO/bump-and-assert-drift.mjs" "$DB"      # asserts: count grows, context_hash differs, new text present;
                                                   # neg-control: a key-only hash would NOT differ (proves the tooth)

# 10. Sharing proof: the v2 bump changed BOTH demo-reviewer AND qa-expert outputs from ONE edit
node "$DEMO/assert-sharing.mjs" "$DB"

# 11. EXECUTION — run the compiled qa-expert through agent-mcp's real provider (live model)
AGENT_MCP_LIVE=1 node "$DEMO/run-via-agentmcp.mjs" "$DEMO/tmp/qa-expert.claude_code.txt"
#   asserts: stopReason completed; in-character; mandated {"agent":"qa-expert",...} JSON; grounding discipline.
#   Phase-6 target (when built): swap to the full Orchestrator + assert an enforcement hook fires.

# 12. Boundary + typecheck/build/lint gates
git -C "$WT" status --short packages/ai/agent-mcp packages/ai/agent-mcp-types   # MUST be empty
for PKG in agent-registry agent-tool-registry agent-provider agent-policy agent-compiler; do
  ( cd "$WT/packages/ai/$PKG" && ../../../node_modules/.bin/tsc -p tsconfig.json --noEmit )   # typecheck
  npx --yes nx build "$PKG"; npx --yes nx lint "$PKG"
done
```

> The orchestrator may dispatch the harness build to an executor, but MUST verify each observable
> state-side (DB rows, exit codes, diffs, transcript) — never from executor prose.

---

## 8. ONE-SHOT PATH-COVERAGE MATRIX (the checklist that defines "everything tested")

| # | path (code that runs differently) | plan | exercised by step | fired-with-consequence observable |
|---|---|---|---|---|
| P1.a | junction ordering by `position` | 1 | 3–4, 5 | sections appear in pos order in every compile |
| P1.b | **context-condition INCLUDE** | 1 | 5 (security ctx) | crit-security present; crit-review absent |
| P1.c | **context-condition EXCLUDE** | 1 | 5 (review/empty ctx) | crit-security absent; (empty → both absent) |
| P1.d | required-component enforcement | 1 | 3–4 | missing required → `REQUIRED_COMPONENT_EXCLUDED` |
| P1.e | version-pin (pinned holds) | 1 | 9 | pinned components unchanged by the v2 bump |
| P1.f | **unpinned tracks latest** | 1 | 9 | unpinned `shared-grounding-rule` picks up v2 |
| P2.a | canonical→alias join | 2 | 3–4, 5 | `Read`/`read_file` not `file_read` |
| P2.b | **drop `unavailable`** | 2 | 5 (claude_api) | `AskUserQuestion` absent on claude_api |
| P2.c | per-platform divergence | 2 | 5 | claude_code vs claude_api tool lists differ |
| P3.a | model resolve (2 platforms) | 3 | 5 | `sonnet` vs `claude-sonnet-4-6` |
| P3.b | **model fallback** | 3 | 3–4 (demo-nobind) | unbound hint → canonical id, decision recorded |
| P4.a | policy DIRECT | 4 | 5 | `no-credentials` text in `## Policies` |
| P4.b | **policy INHERITED** | 4 | 5 | `reviewer-posture` (inherited_from 04-quality) present |
| P4.c | policy empty (neg-control) | 4 | 3–4 | no-policy agent → `[]` |
| P5.a | emit `yaml_frontmatter` | 5 | 5–6 (claude_code) | output starts `---`, frontmatter fields |
| P5.b | emit `json_object` | 5 | 5–6 (claude_api) | `JSON.parse` → `{systemPrompt,tools,model}` |
| P5.c | header_format dispatch (column-driven) | 5 | 5 | format chosen by `platforms.header_format`, not hardcoded |
| P5.d | cache WRITE + lookup-before-assembly | 5 | 5,8 | `composed_prompts` row written on first compile |
| P5.e | **cache HIT (reopen-proven)** | 5 | 8 | recompile → same id, count unchanged |
| P5.f | **cache MISS on version drift** | 5 | 9 | v2 bump → new row, different `context_hash`, new text |
| P5.g | drift tooth neg-control | 5 | 9 | key-only hash would NOT differ (proves P5.f bites) |
| X1 | **single-authorship / sharing** | 1+5 | 9–10 | ONE edit to shared comp changes BOTH agents' output |
| X2 | real-corpus ingest + round-trip | 1–5 | 2,6,7 | qa-expert reconstructs faithfully (diff = policy block only) |
| X3 | **execution via agent-mcp provider (live)** | 5→6 | 11 | real model runs compiled prompt; mandated JSON emitted |
| **N1** | full Orchestrator + enforcement hook fires | **6** | 11 (target) | **NOT-YET-COVERED** (Plan 6 unbuilt) |
| **N2** | corpus-scale sharing (346 agents) | **7** | (target) | **NOT-YET-COVERED** (Plan 7 unbuilt) |

**"Everything tested" = every row above whose plan is built shows a green "fired-with-consequence
observable" in a SINGLE run.** Rows N1/N2 are the only honest gaps and are tied to the two unbuilt plans.

---

## 9. Harness manifest (files the demo needs under `demo/`)

| file | responsibility |
|---|---|
| `migrate-all.mjs` | run all 5 packages' drizzle migrations against one `$DB` |
| `seed-fixtures.mjs` | seed §2.1–§2.6 + §2.8 via store APIs (idempotent) |
| `ingest-agent.mjs` | parse a real agent .md → components + agent + grants + cross-attach shared |
| `assert-resolvers.mjs` | Phase 1–4 resolver assertions (incl/excl, drop-unavailable, fallback, inherited) |
| `diff-roundtrip.mjs` | normalized diff of compiled vs original |
| `assert-cache-hit.mjs` | reopen-proven HIT (same id, count unchanged) |
| `bump-and-assert-drift.mjs` | bump unpinned shared comp → MISS + neg-control tooth |
| `assert-sharing.mjs` | one edit changed both agents |
| `run-via-agentmcp.mjs` | drive compiled prompt through `ClaudeCliProvider` (Phase-6 target: Orchestrator) |
| `README.md` | the recorded run + matrix state (regenerated each run) |

> All harness files live under `docs/plan/agent-registry/demo/`. They consume the packages as
> libraries and **never** modify any package `src/` or agent-mcp.
