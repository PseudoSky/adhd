# Shared context — Agent Registry — Migration & Removal (@adhd/agent-registry-migration)

> Single source of truth for definitions. Reference entries here from any
> context file instead of restating them.

## What this plan is (owner re-author)

This plan is the **LLM-driven ingestion pipeline** that crystallizes into a
reusable import script. The LLMs do the semantic breakdown UP FRONT:

> deterministic `corpus-parser` → `haiku-usecase-batch` (LLM fan-out, cheap tier)
> → `sonnet-consolidation` (LLM, one pass) → `dataset-build` (persist) →
> `import-script` (crystallize into a public entrypoint, closes FEAT-007) →
> `roundtrip-equivalence-gate` → `removal-runbook`.

agent-mcp already RUNS agents at runtime today (shipped core); nothing in this plan
newly enables runtime execution. This plan only IMPORTS the corpus into the
registry and crystallizes the methodology.

## Source of truth

- **Sources to ingest:** all 46 00-active agents
  (`~/dev/ai/claude-agents/categories/00-active/agents/*.md`), the workflow-plugin
  agents (`~/dev/ai/claude-agents` workflow plugin), and every `.md` referenced
  within the specs. `[inv:cross-repo]` — these are READ-ONLY external sources.
- The COMMON-FORMAT parse mapping is `docs/plan/agent-registry/SEED_DATA.md` §0 —
  the frontmatter→table mapping, the body→component heading table, the 8-step "what
  a migration script must do". The corpus headings are heterogeneous, so the
  deterministic parser flags what it cannot type and the LLM stages do the semantic
  typing of the residue.
- The removal scope + the zero-loss rule are `docs/plan/agent-registry/SCOPE.md`
  "Systems Replaced" and `REFERENCES.md` "Superseded Systems — Removal Targets"
  ("Nothing is removed until migration tooling verifies zero data loss").
- The registry tables + stores this tool writes are owned by
  `@adhd/agent-registry` (plan 1, published). The compiler this tool round-trips
  through is `@adhd/agent-compiler` (plan 5). The embedding/anchor substrate is
  Plan 8's `@adhd/agent-registry` `enrich/*`. Treat all as published, importable
  dependencies — do NOT re-implement them here.

## Glossary

- **[def:fixture]** — a representative `.md` agent or `SKILL.md` file copied into
  `packages/ai/agent-registry-migration/src/__fixtures__/` and checked in. The
  tool is built + verified against fixtures because the real corpus lives in a
  separate repo (`[inv:cross-repo]`). `code-reviewer.md` is the canonical
  worked example (SEED_DATA §0).
- **[def:import]** — `importCorpus(...)`: the single public registry-write
  entrypoint (lib export + CLI bin) that runs parse → ingest → dataset-build,
  writing `AGENT`, `PROMPT_COMPONENT` (+ `AGENT_COMPONENT` junction), `USE_CASE` (+
  weighted `COMPONENT_USAGE`), and `AGENT_TOOL` rows through the real
  `@adhd/agent-registry` stores. Closes FEAT-007 (the missing public seeding door).
- **[def:round-trip]** — import an agent, then `agent-registry compile <slug>
  --platform claude_code`, then normalized-diff the emitted markdown against the
  original fixture. An empty diff means the registry is a lossless replacement for
  the file (SEED_DATA §0 step 7: "the migration's correctness gate").
- **[def:equivalence-report]** — the artifact the round-trip gate produces: a
  per-agent `PASS`/`FAIL` list. `retire()` requires it to be **all-PASS**.
- **[def:retire]** — the removal action: delete a migrated file (a fixture in this
  plan; the real corpus via the operator runbook) AND assert the compiler still
  produces the agent. Gated on `[def:equivalence-report]` being all-PASS.
- **[def:eighteen-types]** — the FULL 18 prompt-component types the parser maps onto
  (registry `prompt-types.ts`): `role`, `identity`, `capability`, `rule`, `style`,
  `personality`, `process`, `invocation`, `success_criteria`, `handoff`,
  `escalation`, `posture`, `boundary`, `convergence`, `deliverable`, `evidence`,
  `context_pull`, `risk_posture`. `corpus-parser` must exercise every one across the
  corpus or explicitly flag the unmapped residue.
- **[def:llm-stage]** — a pipeline stage that drives a REAL model via the agent-mcp
  provider (haiku for the fan-out, sonnet for consolidation). Gated behind
  `AGENT_REGISTRY_INGEST_LIVE=1` + the `corpus-ingest-llm` human-blocker; SKIPS (does
  not fail) when the model is unavailable so CI stays offline. The offline path uses
  a recorded/replay fixture to prove SHAPE — never a faked model on the live path
  (CLAUDE.md verification standard #5).
- **[def:anchor-vocabulary]** — the canonical use-case set `sonnet-consolidation`
  produces. It IS the **anchor vocabulary** Plan 8 (`agent-mcp-authoring`)'s
  enrichment (`component_define` auto use-case resolution, SPEC §5.3 step 2 / §10.2)
  resolves component content against. Plan 8 ships SEED anchors; `dataset-build`
  backfills these corpus-derived anchors. Sequencing relationship (CLOSEOUT.md), not
  a `depends_on_plans` edge.

## Cross-cutting invariants

- **[inv:platform-node]** — `@adhd/agent-registry-migration` is `platform:node`.
  It MUST NOT import browser code (`react`, `window`, `document`, CSS). Pure
  Node + SQLite + the registry/compiler packages.
- **[inv:real-deps-not-mocks]** — the import + round-trip tests drive the REAL
  `@adhd/agent-registry` stores and the REAL `@adhd/agent-compiler` against a real
  on-disk SQLite DB. The only thing ever mocked is the absent external repo — and
  even that is replaced by in-repo fixtures, not a stub. Never mock the thing
  under test (project CLAUDE.md verification standard #1).
- **[inv:reopen-proves-persistence]** — import tests prove persistence by CLOSING
  the better-sqlite3 handle and REOPENING from the same file path, then asserting
  the read-back rows — never by reading in-memory state (standard #3).
- **[inv:zero-loss-before-removal]** — no file is deleted until the round-trip is
  verified for EVERY agent in the report. `retire()` refuses on any `FAIL`. This
  is the forcing function for `[dod.4]`.
- **[inv:cross-repo]** — the actual 346 `.md` files + `.claude/skills/` live
  in `~/dev/ai/claude-agents`, NOT in this repo. Guards touch ONLY in-repo
  fixtures + the report. The cross-repo removal is a documented operator runbook
  step (`RUNBOOK.md`), never an automated guard.

## Reference patterns

- **[fix:store-usage]** — write rows via the published `@adhd/agent-registry`
  store classes (`AgentStore`, `ComponentStore`, `CompositionStore`,
  `AgentToolStore` / the tool-registry binding store), mirroring how
  `packages/ai/agent-mcp/src/store/*.ts` wrap Drizzle. Do not hand-write SQL.
- **[fix:frontmatter-mapping]** — SEED_DATA §0 "Frontmatter → registry table
  mapping": `name:`→`AGENT.slug`; `description:`→`AGENT.description`; `tools:`
  comma list→one `AGENT_TOOL` row per token, canonical name via
  `TOOL_PLATFORM_BINDING` where `platform = claude_code`, unknowns flagged;
  `model:`→`AGENT.model_hint` via `MODEL_PLATFORM_BINDING[claude_code]`.
- **[fix:body-mapping]** — SEED_DATA §0 "Body → prompt components" heading table:
  un-headed opening `You are a…`→`role`; `## Identity`/`## Mission`→`identity`;
  `## Process`/`## Workflow`/`## Steps`→`process`;
  `## Invocation`/`## When to use`→`invocation`;
  `## Success Criteria`/`## Done When`→`success_criteria`; etc. Position = order
  of appearance (1-indexed); `context_condition = null`; `version = 1`.

## Notes for every executor

- `@adhd/agent-registry` + `@adhd/agent-compiler` must be on the Nx workspace path
  (`tsconfig.base.json`) before this package builds — they are plan 1 + plan 5
  outputs. `scaffold-package` adds this package's own path line only.
- `better-sqlite3` under vitest can segfault on teardown: gate on the runner's
  EXIT CODE, never on stdout `grep -q passed` (project memory
  `feedback_plan_execution_pitfalls`, CLAUDE.md verification standard #4).
- Keep `src/index.ts` the single public barrel; export each module as added
  (every work state mutates `index.ts` — append-only).
