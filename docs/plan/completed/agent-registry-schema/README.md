# Agent Registry — Prompt Component Schema (@adhd/agent-registry)

Designs and builds `@adhd/agent-registry`: the normalized, database-backed schema
that decomposes an agent's system prompt into typed, ordered, versioned prompt
components, plus the agent / taxonomy / composition-junction / use-case /
composed-prompt tables and their Drizzle stores. This is the foundation package
of the Agent Registry initiative — `@adhd/agent-compiler` and the migration
tooling read from it. Schema details in `DATA_MODEL.md` Domain 1 are a
**requirements document, not a final schema**; this plan's first state is an
architecture pass that resolves the open field/topology questions before any
table is frozen.

> **Plan set & ordering.** This is plan 1 of 7 for the Agent Registry initiative
> (source spec: `docs/plan/agent-registry/`). Ordering:
> `agent-registry-schema` → `agent-tool-registry`, `agent-provider`,
> `agent-policy` (parallel, all depend on schema) → `agent-compiler` (depends on
> all four) → `agent-mcp-refactor` (depends on compiler) →
> `agent-registry-migration` (depends on compiler + refactor; does the final
> removal). See `docs/plan/plan-index.json`.

## Consumer

A registry/compiler engineer (and, transitively, every downstream package:
`@adhd/agent-compiler` joins these tables; the migration tool writes rows into
them). Today they have no schema — agents live as flat `.md` files and as a flat
`systemPrompt: string` blob in agent-mcp's `AgentStore`. After this plan they
have a real relational store they can `create` / `read` / `resolveComposition`
against, with persistence proven by reopening the DB.

## Value delta

- **Before:** an agent's prompt is one opaque text blob (`AgentDefinition.systemPrompt`);
  there is no record of which component, at which version, in which order, made it
  up; shared behavior is copy-pasted across 346 files.
- **After:** a prompt is a set of typed `prompt_components` rows joined to an
  agent through an ordered, version-pinned, context-conditioned junction; a
  component is authored once and referenced by N agents; every composed prompt is
  reproducible from rows and survives a process restart (round-trips after reopen).

## Execution model

- **Parallel execution:** No — states are a linear schema build with two audit
  hold points. The schema file (`db/schema.ts`) and barrel (`index.ts`) are
  shared mutable files written by every state in sequence, so serialization is
  required (no merge protocol needed).
- **Implementer:** one `backend-developer` / `typescript-pro`-class executor with
  Nx + better-sqlite3 + Drizzle in the environment.
- **Review:** `architect-reviewer` reviews `design-and-architecture` output
  (the schema/topology decisions) before `scaffold-package`; the final audit is
  the acceptance gate, accepted by the requesting engineer.
- **Automatic dispatch:** No — authored by the planner, executed by a separate
  executor agent across sessions. Hand off with the Dispatch line.

## Definition of Done

> Behavioral clauses are proven by vitest entrypoints that drive the REAL stores
> against a REAL on-disk SQLite DB and assert persistence by REOPENING the store.
> Each names a `negative-control:` that must turn the clause red if the guarantee
> regresses.

- `[dod.1]` A prompt component created through `ComponentStore` is read back
  identical after the store is closed and reopened — persistence is proven by
  reopen, not in-memory state. (behavioral)
  - entrypoint: `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/roundtrip.test.ts`
  - observable: vitest exits 0 and the `roundtrip.test.ts` case "component round-trips after reopen" passes (it closes the DB handle, reopens from the same file path, and deep-equals the read-back row to the written one).
  - delivered-by: `lookup-and-component-schema, seed-and-roundtrip`
  - negative-control: in `roundtrip.test.ts`, drop the `version` column from the written component before reopen (or have `ComponentStore.read` return a hard-coded blob) → the reopened-row deep-equality fails → `npx --yes nx test agent-registry --testFile=...roundtrip.test.ts` goes red.

- `[dod.2]` An agent composed from ordered component rows resolves its components
  in assembly order, with `version_pin` and `context_condition` honored, queried
  back through `CompositionStore` against a real DB. (behavioral)
  - entrypoint: `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/composition-store.test.ts`
  - observable: vitest exits 0 and the `composition-store.test.ts` case "resolveComposition returns ordered, pinned, context-filtered components" passes — components return in `position` order, a pinned row returns its pinned `version`, and a row whose `context_condition` does not match the supplied context is excluded.
  - delivered-by: `composition-junction`
  - negative-control: in `composition-store.test.ts`, remove the `ORDER BY position` / context-filter in `resolveComposition` → components return out of order or the unmatched one leaks in → `npx --yes nx test agent-registry --testFile=...composition-store.test.ts` goes red.

- `[dod.3]` Seeding populates every `prompt_type` and shared component from
  `SEED_DATA` into a fresh DB, and a second seed run is idempotent (no duplicate
  rows, versions unchanged). (behavioral)
  - entrypoint: `npx --yes nx test agent-registry --testFile=packages/ai/agent-registry/src/__tests__/roundtrip.test.ts`
  - observable: vitest exits 0 and the `roundtrip.test.ts` case "seed is idempotent on re-run" passes — after `seed()` runs twice against the same DB, the `prompt_types` and shared `prompt_components` row counts and versions are identical to a single run.
  - delivered-by: `seed-and-roundtrip`
  - negative-control: in `roundtrip.test.ts`, make `seed()` use plain `INSERT` instead of upsert/`INSERT OR IGNORE` → the second run duplicates rows / bumps versions → `npx --yes nx test agent-registry --testFile=...roundtrip.test.ts` goes red.

- `[dod.4]` `@adhd/agent-registry` is a `platform:node` Nx library, registered in
  `tsconfig.base.json` paths, that builds clean and imports no browser code.
  (structural)
  - Proven by `[scaffold-package.1..5]` in the audit: `project.json` exists and is
    tagged `platform:node`, the tsconfig path is present, `nx build agent-registry`
    exits 0, and no `react`/`document.`/`window.` import appears in `src/`.
  - delivered-by: `design-and-architecture, scaffold-package`

- `[dod.5]` The Drizzle schema contains `prompt_types`, `prompt_components`,
  `agents`, `taxonomy_categories`, `agent_components`, `use_cases`,
  `context_rules`, and `composed_prompts` tables with the fields `DATA_MODEL.md`
  Domain 1 requires (slug PK, integer `version`, `is_shared` flag, junction
  `position`, nullable `version_pin`, `context_condition` JSON, `is_required`,
  composed-prompt context hash + component-versions JSON). (structural)
  - Proven by the `present` criteria on `db/schema.ts` across the schema and
    composition states (`[lookup-and-component-schema.1..2]`,
    `[agent-and-taxonomy-schema.1..2]`, `[composition-junction.1]`,
    `[usecase-and-context-rules.1]`, `[composed-prompt-cache.1]`).
  - delivered-by: `lookup-and-component-schema, agent-and-taxonomy-schema, composition-junction, usecase-and-context-rules, composed-prompt-cache`

---

## State graph

`design-and-architecture` → `scaffold-package` → `lookup-and-component-schema` →
`agent-and-taxonomy-schema` → `composition-junction` → `usecase-and-context-rules`
→ `composed-prompt-cache` → `audit-schema` → `seed-and-roundtrip` → `audit-final`
→ done. See `state-machine.md` and `dag.json`.

## Open design questions handed to `design-and-architecture`

These come straight from `DATA_MODEL.md` "Cross-Domain Design Decisions (Open)"
and must be resolved (recorded in `contexts/design-and-architecture.md`) before
the schema is frozen:

1. **DB topology** — one shared SQLite file with table-name prefixes vs. separate
   files per package joined via `ATTACH DATABASE`. The compiler must join across
   all four registry packages; the decision here constrains `agent-compiler`.
2. **Context-condition evaluation semantics** — precedence when multiple
   components target the same `position` with different conditions (all included?
   last wins? error?). Needed before `composition-junction`.
3. **Junction context vs. free-standing `context_rules`** — `DATA_MODEL.md` flags
   these as "the same underlying need, may be unified." Decide unify-or-keep-both.
4. **Component versioning across agents** — pin semantics consistent across
   junction rows, policy references, and experiments.
