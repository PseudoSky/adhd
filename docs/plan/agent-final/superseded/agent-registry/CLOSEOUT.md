# Agent Registry — Closeout, Sequencing & Worktree Map

> **Audience:** the repository owner / release operator and the plan orchestrator.
> **Purpose:** the single, unambiguous answer to "where does this work live, how is
> it sequenced, how do I land it, and how much of the GOAL does it achieve?" — the
> top-level map the whole initiative points back to.
> **Authored by:** the plan author (Plan 9 `worktree-clarity`).

---

## 1. Where the work lives (read this first — eliminates the worktree confusion)

| | |
|---|---|
| **Worktree path** | `/Users/nix/dev/node/adhd-agent-registry` |
| **Branch** | `agent-registry-execution` |
| **Base branch** | `main` (this worktree was checked out off `main`) |
| **Why a worktree?** | The initiative is large (12 packages + 9 plans) and touches `agent-mcp`, which **works today and the owner must be able to back out**. Isolating all work on `agent-registry-execution` in a separate worktree keeps `main` pristine and the whole initiative revertible as one unit until the owner chooses to land it. |
| **Main repo** | `/Users/nix/dev/node/adhd` (the primary checkout on `main`) — untouched by the initiative until the merge. |

**To land it (the exact path):**

```bash
# 0. From the worktree, confirm the back-out guarantee is intact (HARD GATE):
python3 docs/plan/agent-registry-release/scripts/check_agent_mcp_baseline.py   # must exit 0

# 1. From the MAIN checkout (/Users/nix/dev/node/adhd), on main:
git fetch && git merge --no-ff agent-registry-execution      # see MERGE_RUNBOOK.md

# 2. Publish (clean cached build+test — NEVER --skip-nx-cache):
#    see docs/plan/agent-registry-release/PUBLISH_RUNBOOK.md
npx nx release publish                                        # dependency order, 6 packages

# To BACK OUT after merge: revert the single --no-ff merge commit; agent-mcp returns
# to its pre-initiative bytes (the back-out gate guarantees no out-of-manifest drift).
```

The full, gated runbooks live in **Plan 9 (`docs/plan/agent-registry-release/`)**:
`MERGE_RUNBOOK.md`, `PUBLISH_RUNBOOK.md`, `POST_PUBLISH.md`.

---

## 2. The agent-mcp back-out guarantee (the constraint that shaped sequencing)

`packages/ai/agent-mcp/` and `packages/ai/agent-mcp-types/` work today. The owner
retains the right to back them out. Therefore:

- agent-mcp may be **CONSUMED** (imported, its tests run) freely, but **MODIFIED**
  only under an explicit, reversible, enumerated manifest.
- **Plan 8 (`agent-mcp-authoring`)** is the FIRST sanctioned modifier; its
  `decisions.md` (`def:agent-mcp-modification-manifest`) lists every agent-mcp src
  file it touches + a baseline ref, and every state touching agent-mcp src carries
  the non-regression guard (`nx test agent-mcp` green).
- **Plan 9** makes the guarantee a **gate on merge AND publish**
  (`check_agent_mcp_baseline.py`): byte-identical to baseline, or within Plan 8's
  manifest — nothing else.

---

## 3. The nine plans (sequencing + current state)

> States as of authoring (2026-06): Plans 1–5 built (`audit-final`/`done`), Plans
> 6–7 authored-unbuilt, Plans 8–9 newly authored.

| # | plan dir | role | depends on | state |
|---|---|---|---|---|
| 1 | `agent-registry-schema` | components/agents/composition/taxonomy + `resolveComposition` | — | built (audit-final, 10/10) |
| 2 | `agent-tool-registry` | canonical tools + platform bindings + `resolveTools` | 1 | built (audit-final, 9/9) |
| 3 | `agent-provider` | model registry + `ProviderAdapter` contract | 1 | built (done, 10/10) |
| 4 | `agent-policy` | policy templates + direct/inherited resolution + hook enforcement | 1 | built (audit-final, 10/10) |
| 5 | `agent-compiler` | `compileAgent` — orchestrates 1–4, emits per platform, `composed_prompts` cache, CLI bin | 1–4 | built (audit-final, 13/13) |
| 6 | `agent-mcp-refactor` | wire the registry into the agent-mcp RUNTIME (session-start `compileAgent` + cache) | 5 | **authored, unbuilt (0/10)** |
| 7 | `agent-registry-migration` | LLM-driven corpus INGESTION pipeline → import script: deterministic 18-type parser → haiku use-case fan-out → sonnet consolidation → dataset-build → `importCorpus` (FEAT-007) → round-trip equivalence → gated removal | 1–5 | **authored, unbuilt (0/12)** |
| 8 | `agent-mcp-authoring` | the DEFINITION lane over MCP (`agent_define`/`component_define`/`component_search` + enrichment + name↔slug seam + `agent-mcp@2.0.0`); e2e proofs on a LIVE-provider matrix (anthropic/claudecli/lmstudio), no mocks | 6 | **authored, unbuilt (0/13)** |
| 9 | `agent-registry-release` | merge + publish + cleanup + worktree clarity (this closeout) | 6, 7, 8 | **authored, unbuilt (0/8)** |

**Recommended execution order:** `6 → (7 ∥ 8) → 9`. Plan 8 depends on Plan 6's
runtime wiring; Plan 7 (LLM-driven corpus ingestion) overlaps Plan 8 and runs in
parallel after Plan 6. The two are NOT coupled by a `depends_on_plans` edge — the
relationship is a documented **anchor-vocabulary sequencing**:

- **Plan 8 ships SEED anchors** (a small fixed use-case anchor set in its
  `embedding-substrate` state) so its discovery + composition DoD prove on fixtures
  here and now, with no dependency on the real corpus.
- **Plan 7 backfills the REAL corpus-derived anchors**: its `sonnet-consolidation`
  state produces the canonical use-case vocabulary, and its `dataset-build` state
  writes those use-cases + anchor embeddings (via Plan 8's substrate) into the
  registry — the dataset Plan 8's `component_search` then ranks over.
- After Plan 7's `dataset-build`, re-run Plan 8's discovery DoD against the migrated
  corpus (FEAT-009) to confirm corpus-scale discovery.

Plan 8's e2e proofs run against a **LIVE provider matrix** (anthropic via Claude Max
OAuth keychain, claudecli, lmstudio) — never a scripted/mock provider on the run
path; per-provider availability gates each case (skip-not-fail), the matrix skips
offline when `AGENT_MCP_LIVE` is unset. Plan 7's LLM ingestion stages similarly run
real haiku/sonnet behind `AGENT_REGISTRY_INGEST_LIVE` + the `corpus-ingest-llm`
blocker, with a deterministic replay for CI. Plan 9 runs last.

**Runtime framing (corrected, applies to all plans).** agent-mcp RUNS agents at
runtime TODAY (shipped core). Neither Plan 6 nor Plan 7 newly enables runtime
execution — Plan 6 only changes the system-prompt SOURCE to a registry-compiled
prompt resolved at session start; Plan 7 only imports the corpus. No clause anywhere
implies runtime execution is newly enabled by this initiative.

---

## 4. DoD grounded on GOAL — the achieves / defers map

Honest clause-by-clause status of `GOAL.md` against what is built + what the new
plans deliver. **ACHIEVED** = a real public entrypoint + observable a consumer can
drive (per the project verification standard). The single most important
correction to a "5 plans green = goal achieved" reading: **the agent-mcp runtime
imports zero registry packages today** — every runtime-facing outcome is proven
only against the compiler/CLI until Plan 6 wires it in.

| GOAL outcome | status | delivered / would-be by | proving entrypoint + observable | gap if not achieved |
|---|---|---|---|---|
| Shared Components / Single Authorship | PARTIAL → Plan 8 | 1, 5 (lib); **8** (agent-facing) | lib: `ComponentStore`+junction compile in order; **8: `component_define` upsert** | no agent-facing write path until Plan 8 |
| Runtime Composition & Context Sensitivity | PARTIAL | 1, 5 (compile); **6** (runtime) | `compileAgent --context` includes/excludes by condition (teeth) | session-start `compileAgent` is Plan 6, unbuilt |
| Platform Portability (cc/api/openai/md) | PARTIAL | 2, 3, 5 | `compile` emits per `header_format`; cc+api proven | openai + raw-markdown observables unproven (seed an `openai` platform row) |
| Audit Trail (COMPOSED_PROMPT) | PARTIAL | 1, 5 (cache); **6** (per-invocation) | `composed_prompts` row written on compile, persists across reopen | per-invocation `sessions.composed_prompt_id` is Plan 6 |
| A/B Testing (EXPERIMENT) | GOAL-FUTURE | — | no EXPERIMENT table built | design-pass illustration; needs a dedicated plan |
| Variable Policy Enforcement (8 mechanisms) | PARTIAL (1/8) | 4; **6** (runtime bridge) | `hook` enforces via real `IHookRegistry` (teeth) | 7 of 8 mechanisms observational-only (COVERAGE.md §B) |
| Policy Inheritance (category cascade) | PARTIAL (single-level) | 4 | `resolveForAgent` inherits one category level (teeth) | multi-level taxonomy walk unbuilt (COVERAGE.md §B) |
| Maintainability — Authoring | PARTIAL → Plan 8 | 1; **8** | `component_define` content-only + auto-enrich | agent-facing tool is Plan 8 |
| Maintainability — Storage | ACHIEVED (lib) | 1, 5 | DB authoritative; `agent-registry compile` emits files | corpus not imported until Plan 7 |
| Maintainability — Discovery | PARTIAL → Plan 8 | 1 (lib); **8** (semantic) | lib `list`/`componentsFor`; **8: `component_search`** | semantic MCP discovery is Plan 8 (no embeddings today) |
| Maintainability — Change Propagation | ACHIEVED (compile) | 1, 5 | `version()` bump picked up on next compile | runtime invalidation is Plan 6 |
| Maintainability — Rollback (`version_pin`) | ACHIEVED (lib) | 1 | pinned vs latest resolution (teeth) | tool-level pin authoring is Plan 8 |
| Maintainability — Onboarding | DEFERRED → Plan 8 | **8** | the SPEC §7 task-packet→agent journey | entirely Plan 8 |
| Adaptability — new PROMPT_TYPE no migration | ACHIEVED | 1 | lookup-table (not enum); add a row, no migration | — |
| Adaptability — Knowledge Graph | GOAL-FUTURE | — | substrate tables exist; no graph layer | design-pass illustration |
| Adaptability — SP Optimizer | GOAL-FUTURE | — | gated on EXPERIMENT (absent) | design-pass illustration |
| Adaptability — Dynamic Content | GOAL-FUTURE / DEFERRED | — | content is static; no interpolation pass | "nothing prevents" — extension, not built |
| Adaptability — Multi-Tenant | GOAL-FUTURE | — | `scope_context` exists at current granularity | extensibility claim, not built |
| Adaptability — Model-Specific Composition | PARTIAL | 3 | model tables resolve (teeth); evaluator is generic | model-conditioned inclusion unseeded/unproven |

**Achieves now (drivable consumer entrypoint + teeth):** the lib/CLI half of
single-authorship, storage, change-propagation, rollback; new-prompt-type-no-
migration; platform portability for claude_code + claude_api; the compile-path
"foundations together" e2e — **all via the `agent-registry compile` CLI / library
APIs, none via a running agent.**

**Defers (authored, pending execution):** the runtime halves (Plan 6), onboarding +
semantic discovery + agent-facing authoring + the live-provider e2e matrix (Plan 8),
the LLM-driven corpus ingestion + `importCorpus` public entrypoint / FEAT-007 +
corpus-derived discovery anchors (Plan 7), release (Plan 9).

**GOAL-FUTURE-ILLUSTRATIVE (GOAL's own design-pass carve-outs — no plan, no
schema):** A/B testing, knowledge graph, SP optimizer, dynamic content,
multi-tenant. These are explicitly illustrations in `GOAL.md`, not commitments.

> The detailed source-grounded version of this map (with quoted DoD clause text)
> is the analysis the closeout was built from; this table is its durable summary.

---

## 5. Cumulative Usability Gate (DEMO.md) — testing reground

`DEMO.md` is the binding gate: before any phase is review-ready, the orchestrator
runs the cumulative demo up through that phase and confirms every path it
introduced is **exercised**, not merely present. The throwaway demos under
`demo/` test from the **author's** perspective (deep `src/` imports — `factory.ts`,
`buildHarness`, store APIs). **Plan 8's `composition-journey-e2e` promotes them
into a maintained, zero-internal-import integration test** driving the public MCP
surface + the compiler CLI bin — the §7 journey as a zero-context user. The
`agent-mcp` server bin (16 tools) and the `agent-compiler` CLI bin are the public
entrypoints that exist today; only registry seeding/ingest lacks a public
entrypoint (the one genuine Plan-8 blocker, recorded honestly in DEMO.md §6).

---

## 6. Open backlog (deferrals filed during planning)

See `packages/ai/agent-mcp/BACKLOG.md` for the deferrals this planning pass filed
(enrichment-source upgrade seam, discovery-lane corpus dependency on Plan 7, the
public registry-write entrypoint gap, the GOAL-FUTURE items). Nothing here is a
silent gap — each is either a named plan state or a filed backlog item.
