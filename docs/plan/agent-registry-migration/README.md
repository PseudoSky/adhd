# Agent Registry — LLM-driven Corpus Ingestion, Migration & Removal (@adhd/agent-registry-migration)

Builds `@adhd/agent-registry-migration`: an **LLM-driven ingestion pipeline** that
does the semantic breakdown of the file-based agent corpus UP FRONT and crystallizes
it into a **reusable public import script**, then **retires** the superseded
file-based systems — but only after a round-trip equivalence gate proves the registry
is a lossless replacement for every file. The pipeline is:

> deterministic `corpus-parser` (maps the COMMON FORMAT onto the FULL 18-type
> component set) → `haiku-usecase-batch` (an LLM fan-out, cheap tier, emits candidate
> use-cases per component) → `sonnet-consolidation` (one LLM pass → canonical
> use-case vocabulary + weighted component↔use-case links) → `dataset-build`
> (populate the real registry) → `import-script` (crystallize into a public
> registry-write entrypoint, **closes FEAT-007**) → `roundtrip-equivalence-gate` →
> `removal-runbook`.

**Sources ingested:** all 46 00-active agents
(`~/dev/ai/claude-agents/categories/00-active/agents/*.md`), the workflow-plugin
agents, and every `.md` referenced within the specs, plus `.claude/skills/*/SKILL.md`.

This is the **final** plan (7 of 7) of the Agent Registry initiative: it consumes
`@adhd/agent-registry` (plan 1) through `@adhd/agent-compiler` (plan 5), the
refactored `@adhd/agent-mcp` (plan 6), and Plan 8's embedding/anchor substrate
(`@adhd/agent-registry` `enrich/*`).

> **Runtime framing (corrected).** agent-mcp RUNS agents at runtime TODAY (shipped
> core). Nothing in this plan or Plan 6 newly enables runtime execution — Plan 6 only
> changes the system-prompt SOURCE to a registry-compiled prompt resolved at session
> start. This plan only IMPORTS the corpus and crystallizes the methodology; no clause
> implies runtime execution is newly enabled.

> **Cross-plan anchor linkage (explicit).** `sonnet-consolidation`'s canonical
> use-case set is the **ANCHOR vocabulary** Plan 8 (`agent-mcp-authoring`)'s
> enrichment (`component_define` auto use-case resolution, SPEC §5.3 step 2 / §10.2)
> resolves against. Plan 8 ships SEED anchors so its discovery proves on fixtures;
> THIS plan's `dataset-build` backfills the real corpus-derived anchors. The relation
> is documented sequencing (CLOSEOUT.md), not a `depends_on_plans` edge — the plans do
> not block each other.

> **Plan set & ordering.** Plan 7 of 7 (source spec: `docs/plan/agent-registry/`).
> Ordering: `agent-registry-schema` → `agent-tool-registry`, `agent-provider`,
> `agent-policy` (parallel) → `agent-compiler` (plan 5; depends on the four) →
> `agent-mcp-refactor` (plan 6; depends on compiler) → **`agent-registry-migration`
> (plan 7; depends on compiler + refactor; does the migration AND the final
> removal)**. See `docs/plan/plan-index.json`. This plan is LAST in the set —
> nothing depends on it.

## Consumer

A platform/registry engineer running the one-time corpus migration. Today they
have 346 hand-authored `.md` agent files and a tree of `.claude/skills/*/SKILL.md`,
each carrying YAML frontmatter (`name`, `description`, `tools`, `model`) plus a
markdown body. They have no way to (a) get those into the normalized registry, or
(b) safely delete the files afterward without risking that the compiler emits
something different from what the file said. After this plan they run the import
tool, read a per-agent PASS/FAIL equivalence report, and retire files only for the
agents that round-trip — with the tool *refusing* to delete anything whose
compiled output differs from its source.

## Value delta

- **Before:** an agent's source of truth is a flat `.md` file in a separate repo;
  there is no programmatic path from file → registry, no use-case discovery
  vocabulary, and "is it safe to delete this file?" is answered by hand. Skills live
  as loose `SKILL.md` files outside the registry entirely. The registry ships with
  no corpus-derived components or use-cases — `component_search` (Plan 8) has nothing
  real to rank.
- **After:** an **LLM-driven pipeline** does the semantic breakdown up front — a
  deterministic parser maps the COMMON FORMAT onto the FULL 18-type component set; a
  haiku fan-out generates candidate use-cases per component; a sonnet pass
  consolidates them into a canonical use-case vocabulary with weighted
  component↔use-case links; `dataset-build` populates the **real** registry (the
  corpus dataset the discovery lane searches over). The pipeline crystallizes into a
  reusable public `importCorpus(...)` entrypoint (lib + CLI bin) — **closing
  FEAT-007**, the missing public registry-write door. A round-trip gate then proves
  `agent-registry compile <slug> --platform claude_code` emits markdown
  byte/behaviorally equivalent to the original, and removal is **forced** to depend
  on an all-PASS equivalence report so nothing is deleted until every agent
  round-trips. All output survives a process restart (rows re-read after the registry
  DB is reopened).

## Execution model

- **Parallel execution:** No across states — a mostly linear pipeline (parse →
  ingest → import → verify → removal) with two audit hold points. `src/index.ts` is a
  shared mutable barrel written by every work state in sequence, so serialization is
  required. (The `haiku-usecase-batch` fan-out IS parallel WITHIN its state.)
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle in the environment, the published
  `@adhd/agent-registry` + `@adhd/agent-compiler` packages on the workspace path, and
  — for the live LLM stages — Claude model access (`corpus-ingest-llm` blocker;
  `AGENT_REGISTRY_INGEST_LIVE=1`). The LLM stages run a real haiku/sonnet through the
  agent-mcp provider; CI runs the deterministic replay offline.
- **Review:** `code-reviewer` reviews `migration-design` output (the parser + 18-type
  mapping strategy, the LLM pipeline contract, the anchor-vocabulary linkage to Plan
  8, the equivalence definition, the zero-loss gate, and the cross-repo removal
  boundary) before any code; the final audit is the acceptance gate, accepted by the
  requesting engineer.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions.

## Cross-repo safety boundary (read before executing removal)

The actual 346 `.md` agent files and the `.claude/skills/` tree live in a
**separate repository** — `~/dev/ai/claude-agents` (REFERENCES.md "Primary
Source: claude-agents") — **not** in this `adhd` monorepo. Therefore:

- This plan builds and verifies the migration **tool** in
  `@adhd/agent-registry-migration` (this repo) against a **representative sample of
  FIXTURE `.md` files copied into the package** (`src/__fixtures__/`,
  e.g. `code-reviewer.md` — the canonical worked example from SEED_DATA §0 — and
  `ticket-creation.SKILL.md`).
- Every behavioral DoD and every removal DoD operates on the **in-repo fixtures**
  and the tool's verified-equivalence report. The audit guards NEVER reach into
  `~/dev/ai/claude-agents` and NEVER delete files in another repo.
- The actual cross-repo `claude-agents` removal is a **documented runbook step**
  (`RUNBOOK.md`) gated on an all-PASS equivalence report for the full corpus —
  executed by an operator, outside these guards, never automatically.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL
> migration tool (parser → importer → compiler → equivalence gate → removal
> runbook) against a REAL on-disk registry SQLite DB and the REAL
> `@adhd/agent-compiler`, asserting persistence by REOPENING the store. Each names
> a `negative-control:` that must turn the clause red if the guarantee regresses.
> Mock only the absent external boundary (none here — even the compiler is real);
> never mock the thing under test.

- `[dod.1]` **The deterministic parser maps the 00-active COMMON FORMAT onto the FULL
  18-type component set, exercising every type across the corpus or explicitly
  flagging the unmapped residue — driven against the REAL agent files, no LLM.**
  (behavioral)
  - given: the real 00-active corpus (`~/dev/ai/claude-agents/categories/00-active/agents/*.md`) plus the in-repo fixtures
  - when: `corpus-parser` parses each file's frontmatter + body sections + un-headed `You are…` paragraph deterministically
  - then: the union of mapped `prompt_type`s across the corpus covers all 18 types, OR every section that maps to no type is recorded in an `unmapped[]` flag list — never silently dropped
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/corpus-parser.test.ts`
  - observable: `vitest exits 0 and the case 'parser exercises all 18 component types across the corpus or flags the residue' asserts the mapped-type union ∪ unmapped[] accounts for every section (no silent drop) and the 18-type set is covered`
  - negative-control: `drop a type from the heading→type table (e.g. never emit 'evidence') without flagging it → the 18-type coverage / no-silent-drop assertion fails → corpus-parser.test.ts goes red`
  - delivered-by: `migration-design, corpus-parser`

- `[dod.2]` **A haiku fan-out processes EVERY parsed component and returns ≥1
  candidate use-case per component; a sonnet pass consolidates them into a canonical
  use-case vocabulary smaller than the raw union, with weighted component↔use-case
  links — REAL models, gated, skip-not-fail offline.** (behavioral)
  - given: the parsed component set (and `AGENT_REGISTRY_INGEST_LIVE` controlling live vs replay)
  - when: `haiku-usecase-batch` fans out one cheap-tier call per component, then `sonnet-consolidation` reviews the full candidate set in one pass
  - then: every component has a non-empty candidate set; the consolidated canonical vocabulary is strictly smaller than the raw candidate union (dedup happened) and carries weighted links; the LLM stages skip (not fail) when no model is available, with a deterministic replay fixture proving the shape offline
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/sonnet-consolidation.test.ts`
  - observable: `vitest exits 0 and the case 'consolidation dedups candidates into a smaller weighted vocabulary' asserts |canonical| < |raw candidate union|, every canonical use-case traces to ≥1 candidate, links carry weights, and the stage skips cleanly when AGENT_REGISTRY_INGEST_LIVE is unset`
  - negative-control: `make consolidation a pass-through (no dedup) → |canonical| == |raw union| → the strictly-smaller assertion in nx test agent-registry-migration --testFile=...sonnet-consolidation.test.ts fails → that test goes red`
  - delivered-by: `haiku-usecase-batch, sonnet-consolidation`

- `[dod.3]` **`dataset-build` populates the REAL registry — components (18-typed) +
  canonical use-cases (with anchor embeddings) + weighted links — recoverable after
  the DB is closed and reopened; the weights survive.** (behavioral)
  - given: a fresh on-disk registry SQLite DB and the consolidated dataset
  - when: `dataset-build` writes components, use-cases (with anchor embeddings via the Plan 8 substrate), and weighted `component↔use-case` links through the published stores, then the DB is reopened from the same path
  - then: the read-back components/use-cases/links match what was written, weights included (not flattened to membership)
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/dataset-build.test.ts`
  - observable: `vitest exits 0 and the case 'dataset persists components+use-cases+weighted links after reopen' reopens the DB and deep-equals the read-back rows including link weights`
  - negative-control: `drop the weight on the link insert (write membership only) → the read-back weight assertion fails → dataset-build.test.ts goes red`
  - delivered-by: `dataset-build`

- `[dod.4]` **A single public `importCorpus(...)` entrypoint (lib export + CLI bin)
  runs the whole pipeline end-to-end and persists the corpus dataset recoverable
  after reopen, folding in `SKILL.md`→process/invocation; the LLM methodology is
  captured as a deterministic replay — this is the FEAT-007 public registry-write
  door.** (behavioral)
  - given: the parsed corpus + the captured consolidation record (replay) on a fresh on-disk DB
  - when: `importCorpus({replay})` runs parse→ingest→dataset-build through the public entrypoint, including each `SKILL.md`
  - then: the registry holds the agents, 18-typed components, use-cases, weighted links, and skills (typed process/invocation) recoverable after reopen; a second replay run reproduces the same rows deterministically
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/import-script.test.ts`
  - observable: `vitest exits 0 and the cases 'importCorpus persists the corpus dataset after reopen' + 'replay is deterministic (twice → equal rows)' + 'skill imports as process/invocation' all assert read-back through a reopened DB`
  - negative-control: `make importCorpus skip the SKILL.md import (or make replay non-deterministic) → the skill-typed read-back / the twice-equal assertion fails → import-script.test.ts goes red`
  - delivered-by: `import-script`

- `[dod.5]` **A migrated agent compiles to equivalent markdown vs. its original
  `.md`, and removal is GATED on an all-PASS equivalence report** — with a
  deliberately non-equivalent agent the removal runbook *refuses* to remove the
  fixture `.md`; an all-PASS report removes it AND `compile` still produces the
  agent. (behavioral)
  - given: an imported agent on a real registry DB and an equivalence report
  - when: the round-trip gate runs `agent-registry compile <slug> --platform claude_code` and normalized-diffs against the original; then `retire()` is invoked against a report that has ≥1 FAIL, then against an all-PASS report
  - then: an equivalent agent reports PASS (empty normalized diff); `retire()` refuses (throws/blocked) on the not-all-PASS report leaving the `.md` intact; on the all-PASS report it removes the `.md` AND `compile` still emits the agent
  - entrypoint: `npx --yes nx test agent-registry-migration --testFile=packages/ai/agent-registry-migration/src/__tests__/removal-runbook.test.ts`
  - observable: `vitest exits 0 and the cases 'retire refuses when report is not all-PASS' (md untouched) + 'all-PASS retire removes the md AND compile still produces the agent' both pass; the round-trip case asserts an empty normalized diff`
  - negative-control: `remove the all-PASS guard in retire() → it deletes the fixture despite a FAIL entry → removal-runbook.test.ts goes red; nc_mutate.mjs corrupting a persisted component makes the round-trip diff non-empty → roundtrip-equivalence.test.ts goes red`
  - delivered-by: `roundtrip-equivalence-gate, removal-runbook`

- `[dod.6]` **`@adhd/agent-registry-migration` is a `platform:node` Nx library,
  registered in `tsconfig.base.json`, that depends on `@adhd/agent-registry` +
  `@adhd/agent-compiler` and builds clean.** (structural)
  - Proven by `[scaffold-package.1..5]` in the audit: `project.json` exists and is
    tagged `platform:node`, the tsconfig path is present, `package.json` declares
    the `@adhd/agent-registry` + `@adhd/agent-compiler` deps, and
    `nx build agent-registry-migration` exits 0.
  - delivered-by: `scaffold-package`

---

## State graph

`migration-design` → `scaffold-package` → `corpus-parser` →
`haiku-usecase-batch` → `sonnet-consolidation` → `dataset-build` →
`import-script` → `roundtrip-equivalence-gate` → `audit-migration` →
`removal-runbook` → `code-review` → `audit-final` → done. See `dag.json`.

The two LLM stages (`haiku-usecase-batch`, `sonnet-consolidation`) drive REAL
models behind the `corpus-ingest-llm` human-blocker + `AGENT_REGISTRY_INGEST_LIVE`;
they SKIP (not fail) offline, with deterministic replay fixtures proving shape so CI
stays green and offline.

`audit-migration` is the hold point that proves the pipeline is correct (parse →
ingest → dataset-build → import → round-trip equivalence) BEFORE the removal phase
touches anything; `removal-runbook` depends on it, so removal cannot start until the
ingestion + equivalence pipeline is verified.

## Design questions handed to `migration-design`

Resolved (recorded in `decisions.md`) before any code:

1. **Parser + 18-type mapping** — the deterministic frontmatter+body parser for the
   00-active COMMON FORMAT; the heading → `prompt_type` table; how the un-headed
   opening `You are a…` maps to `role`; how the heterogeneous heading long-tail is
   handled (recognizable forms typed deterministically, ambiguous residue FLAGGED in
   `unmapped[]` for the LLM stages — never silently dropped); the full 18-type
   coverage proof (`[dod.1]`).
2. **LLM pipeline contract** — the haiku fan-out (one cheap-tier call per component,
   parallel, over-generate candidate use-cases) → the single sonnet consolidation
   pass (dedup → canonical vocabulary + weighted links); the live vs. replay split
   (`AGENT_REGISTRY_INGEST_LIVE`, `corpus-ingest-llm` blocker, skip-not-fail); the
   replay-capture format that makes `importCorpus` reproducible offline.
3. **Anchor-vocabulary linkage to Plan 8** — the sonnet-consolidated use-case set IS
   Plan 8's enrichment anchor vocabulary; Plan 8 ships SEED anchors, this plan's
   `dataset-build` backfills the corpus-derived ones via Plan 8's embedding
   substrate; documented sequencing, not a `depends_on_plans` edge.
4. **Public import entrypoint (FEAT-007)** — `importCorpus(...)` as a lib export +
   CLI bin; skills folded in; how it closes the DEMO.md §6 / CLOSEOUT.md §5 seeding
   gap.
5. **Equivalence definition + zero-loss gate** — byte- vs. behaviorally-equivalent;
   the normalization applied before the diff and why each is sound; the report shape
   (per-agent PASS/FAIL); the forcing function (`retire()` MUST require all-PASS).
6. **Cross-repo removal boundary** — the in-repo fixtures vs. the external
   `claude-agents` corpus; guards touch fixtures only; cross-repo removal is a
   documented operator runbook step (`RUNBOOK.md`).
