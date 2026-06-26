# Architecture Decisions — `@adhd/agent-registry` and the Registry Family

> **Status:** binding. Written in the `design-and-architecture` state of the
> `agent-registry-schema` plan, BEFORE any table is frozen. Every later state in
> this plan — and the sibling plans `agent-tool-registry`, `agent-provider`,
> `agent-policy`, plus the downstream `agent-compiler` — treats these decisions as
> the resolution of the "Cross-Domain Design Decisions (Open)" section of
> `docs/plan/agent-registry/DATA_MODEL.md`. Re-deciding any of these downstream is
> a planner-class amendment, not a local choice.
>
> Source requirements: `docs/plan/agent-registry/DATA_MODEL.md` (Domain 1 +
> "Cross-Domain Design Decisions (Open)").

These four packages are FLAT siblings under `packages/ai/`:
`agent-registry`, `agent-tool-registry`, `agent-provider`, `agent-policy`. Each is
`platform:node`, pure Node + SQLite (`[inv:platform-node]`).

---

## Decision 1 — DB topology: one shared SQLite file, per-package table-name prefixes

**Question (`DATA_MODEL.md` "DB topology" + "Cross-package query at compile time").**
Should the four registry packages share one SQLite file (simpler cross-package
joins, weaker isolation), use separate files joined via `ATTACH DATABASE` (stronger
isolation, more complex compile-time queries), or expose only an in-process API?

**Decision.** **One shared SQLite file.** Every package owns a disjoint set of
tables distinguished by a package-name prefix:

| Package                  | Table prefix | Example tables                                                   |
| :----------------------- | :----------- | :--------------------------------------------------------------- |
| `@adhd/agent-registry`   | `registry_`  | `registry_prompt_types`, `registry_components`, `registry_component_versions`, `registry_agents`, `registry_agent_components`, `registry_context_rules`, `registry_composed_prompts` |
| `@adhd/agent-tool-registry` | `tool_`   | `tool_tools`, `tool_platform_bindings`, `tool_mcp_servers`, `tool_agent_tools` |
| `@adhd/agent-provider`   | `provider_`  | `provider_providers`, `provider_models`, `provider_model_platform_bindings`, `provider_tool_formats` |
| `@adhd/agent-policy`     | `policy_`    | `policy_policy_types`, `policy_policy_templates`, `policy_agent_policies` |

**Binding sub-rules (`[inv:one-db-handle]`):**

1. **One handle.** A consumer (notably `@adhd/agent-compiler`) opens exactly one
   `better-sqlite3` handle to the shared file and queries `registry_*`, `tool_*`,
   `provider_*`, and `policy_*` tables through it. **No `ATTACH DATABASE`.**
2. **No cross-package SQLite foreign keys.** Tables in one prefix MUST NOT declare a
   Drizzle `.references()` FK onto a table in another prefix. Cross-package links are
   **logical** (a `registry_agents.slug` is referenced by `policy_agent_policies.agent_slug`
   as a plain text column, joined in application SQL) — never enforced at the SQLite
   FK level. This keeps each package independently migratable and seedable: a package
   can create and migrate its own tables without the others' tables existing yet.
3. **In-package FKs are unchanged.** Within one prefix, `.references()` FKs are used
   normally (e.g. `registry_components.type` → `registry_prompt_types.slug`). After
   the Decision 5 head/version split, the in-package FKs are MORE complete: every
   reference to a component (`registry_agent_components.component_slug`,
   `registry_component_usage.component_slug`, `registry_context_rules.component_slug`,
   and `registry_agent_components.version_pin`) is now a real DB-enforced FK rather
   than a logical-only one.
4. **Each package owns its migration directory** (`drizzle/`) and only ever
   creates/alters tables in its own prefix.

**Rationale.**

- It is the **DAG-neutral** choice. The downstream `agent-compiler` plan already
  encodes this exact topology as its central assumption — `agent-compiler/README.md`
  ("one shared SQLite file with per-package table-name prefixes … no cross-package
  SQLite FKs … is the central assumption this plan rests on") and
  `agent-compiler/contexts/compiler-design.md` `[inv:one-db-handle]`. Choosing it
  here means **no plan's DAG changes**. (See "DAG impact" below.)
- The compiler's headline DoD is a single-handle cross-package join
  (`compile-e2e.test.ts` seeds rows across all four prefixes, calls `compileAgent`,
  and asserts a platform-shaped frontmatter + ordered body). A single file makes
  that join an ordinary `SELECT … JOIN`, no `ATTACH` ceremony, no per-query
  database-alias plumbing.
- Logical-only cross-package links (no SQLite FK) preserve **package isolation at
  the migration boundary** — the strongest practical benefit `ATTACH`/separate files
  was meant to buy — while keeping the simplest possible query path. We get most of
  the isolation without the join cost.

**Trade-offs accepted.**

- **Weaker physical isolation than separate files.** A corrupt write in one package
  can affect the shared file. Mitigated by: disjoint prefixes (no table-name
  collisions), per-package migrations, and the no-cross-FK rule (a package's schema
  can be reasoned about in isolation).
- **No DB-enforced referential integrity across packages.** A `policy_agent_policies`
  row can name an `agent_slug` that does not exist in `registry_agents`. This is a
  deliberate cost of decoupling; integrity across packages is enforced in the store
  layer / compiler, not by SQLite. This matches how the existing `agent-mcp` stores
  already treat cross-concern references.
- **`ATTACH DATABASE` was rejected** because it pushes database-alias qualification
  into every cross-package query and complicates the compiler's single-`SELECT`
  join for no isolation benefit we actually need (the no-cross-FK rule already gives
  us migration isolation). An **in-process-only API** (each package hides its DB and
  exposes method calls) was rejected because the compiler's join is inherently
  set-based across four domains; forcing it through four method APIs would re-implement
  a join in TypeScript and lose SQLite's query planner.

**DAG impact: NONE.** This is the recommended option and the assumption every
downstream plan was authored against. No planner-class amendment.

---

## Decision 2 — Context-condition evaluation semantics: ALL-INCLUDED, deterministic order

**Question (`DATA_MODEL.md` "Context condition evaluation semantics" + Domain 1
"Agent-Component Junction").** When multiple components target the same assembly
`position` with different context conditions, and more than one condition is
satisfied for a given runtime context, which wins — all included / last-wins /
error?

**Decision.** **ALL matching components are included.** A context condition is an
*inclusion filter*, not a *selector*. `position` is an **ordering key, not a unique
slot** — it does not imply mutual exclusion. Multiple components may legitimately
share or interleave around the same position (e.g. several `success_criteria`
components, one per `ticket_type`, several of which match a multi-tagged context).

**Binding evaluation rule (the precedence/determinism contract):**

1. For an agent + runtime context, evaluate each `registry_agent_components` junction
   row's `context_condition`:
   - `context_condition IS NULL` → **always included**.
   - non-null JSON predicate → included **iff** the predicate matches the runtime
     context (every key in the predicate equals the corresponding context value).
2. **Include every component whose condition matches** (or is null). No matched
   component is dropped because another also matched. There is no "winner."
3. **Deterministic total order.** The included set is emitted ordered by
   `(position ASC, version_pin-resolved component version DESC, component_slug ASC)`.
   The `component_slug` tertiary key guarantees a **total, stable order** even when
   two components share the same `position` — this is what removes the
   non-determinism `DATA_MODEL.md` warns about. The same (agent, context) input
   therefore always assembles byte-identical output, which is the precondition for
   the `composed_prompts` context-hash cache (Decision 1's `registry_composed_prompts`).
4. **`is_required` interacts with, but does not change, the above.** If a junction
   row has `is_required = true` and its condition does NOT match, the composition is
   an **error** (a required component was filtered out) — surfaced as a typed
   `CompositionError`, not silently dropped. Required + matched → included like any
   other. Required + null condition → always included (can never error).

**Why ALL-INCLUDED over last-wins or error:**

- **Last-wins** silently discards content an author attached on purpose and makes the
  outcome depend on insertion order / row id — exactly the hidden non-determinism we
  must avoid. It also breaks the documented `success_criteria` use case
  (`DATA_MODEL.md` Domain 1 Agents: "includes whichever set matches … **or all of
  them**"), where several criteria sets legitimately co-apply.
- **Error on multi-match** would make perfectly reasonable authoring (two independent
  conditions both true) a hard failure, pushing authors toward brittle mutually-
  exclusive predicates. Reserved instead for the genuine failure case: a `required`
  component filtered out.
- **All-included** is the only rule consistent with the prose ("the composition engine
  includes whichever set matches the current context, or all of them if no condition
  is specified"), and the `(position, version, slug)` total order makes it fully
  deterministic — satisfying the "explicit rule to avoid non-deterministic assembly"
  mandate.

**Ownership.** `CompositionStore.resolveComposition` is the single owner of this rule
(ordering + version-pin + context-condition evaluation), per
`references.json` `[ref:store-class]` and audit check `[composition-junction.3]`.
The compiler delegates to it (`agent-compiler` `composition-resolve` state) rather
than re-implementing the precedence — so the rule lives in exactly one place.

**Trade-off accepted.** Authors are responsible for ensuring co-included components
at the same position read coherently together; the engine guarantees deterministic
order, not semantic non-overlap. This is the right boundary: content coherence is an
authoring concern, determinism is an engine guarantee.

**DAG impact: NONE.** `agent-compiler/contexts/compiler-design.md` consumes "the
context-condition precedence rule" from this `decisions.md` (its `compiler-design`
guard greps for the consumed rule). Recording ALL-INCLUDED here satisfies that
contract; it does not reshape any state.

---

## Decision 3 — Junction `context_condition` vs. free-standing `context_rules`: KEEP BOTH, single evaluator, additive

**Question (`DATA_MODEL.md` Domain 1 "Context Rules").** Unify junction-level
`context_condition` with free-standing `context_rules`, or keep both? The DATA_MODEL
flags them as "the same underlying need."

**Decision.** **Keep both tables, but unify the evaluation.** They are not the same
relationship and collapsing them would lose information, but they MUST share one
predicate evaluator so the semantics never diverge.

- **`registry_agent_components.context_condition`** (junction-level) — a *filter on a
  component the author has already attached to the agent at a specific `position`*.
  Answers: "this component is part of the agent; include it only when …". This is the
  primary, position-bearing mechanism.
- **`registry_context_rules`** (free-standing, agent-level) — an *additive inclusion
  rule*: "for agent X, when condition Y, ALSO include component Z." It exists to
  attach a component **conditionally without giving it a permanent junction slot** —
  useful when the same conditional add-on applies broadly, or is managed/seeded
  separately from an agent's core composition. A `context_rules` row carries its own
  `position` (or a position-resolution rule) so the added component lands in the
  deterministic order of Decision 2.

**Binding unification rules:**

1. **One predicate shape, one evaluator.** Both `context_condition` (junction) and the
   condition on a `context_rules` row use the identical JSON-predicate format and are
   evaluated by the **same** function inside `CompositionStore.resolveComposition`.
   There is exactly one definition of "does this context match."
2. **Additive, then deduplicated.** Resolution = (matching junction components) ∪
   (components added by matching `context_rules`). If the same `component_slug` arrives
   from both a junction row and a context rule, it appears **once** — the junction row
   wins for `position` / `version_pin` / `is_required` (the explicit attachment is
   authoritative over the broad rule). The merged set is then ordered by Decision 2's
   `(position, version, slug)` total order.
3. **No `context_rules` override of `is_required`.** A context rule can only *add* a
   component; it cannot make a junction-attached component optional or required. This
   keeps `is_required` a property of the explicit attachment only.

**Why keep both rather than fully unify:**

- They encode genuinely different relationships: a junction row is "this component IS
  part of this agent (at this position)"; a context rule is "ADD this component when a
  condition holds, without committing it to the agent's permanent composition." Folding
  context rules into the junction would force every conditional add-on to occupy a
  permanent junction slot and lose the "managed separately" property the DATA_MODEL
  describes.
- Fully separate *evaluators* was the real risk the DATA_MODEL was pointing at — two
  code paths drifting into inconsistent matching. The single-evaluator + additive-merge
  rule removes that risk while preserving both tables' distinct meaning.

**Trade-off accepted.** Slightly more surface (two tables, one merge step) in exchange
for not overloading the junction. The dedup rule (junction wins) is the one piece of
extra logic, and it is small and explicit.

**DAG impact: NONE.** `registry_context_rules` is already scheduled in this plan's
`usecase-and-context-rules` state (audit check `usecase-and-context-rules.1` greps for
`context_rules`). Keeping both tables matches the existing schema-phase plan; no state
is added or removed.

---

## Decision 4 — Component version-pin semantics: pin is a per-reference choice; absence = latest-at-resolve

**Question (`DATA_MODEL.md` "Component versioning across agents").** If component X v2
ships while agent A pins v1 and agent B takes latest, what version does each reference
resolve to — across junction rows, policy references, and experiment definitions?
Pinning semantics must be consistent across all three reference sites.

**Decision.** **A version pin is a property of the *reference*, not of the component,
and the rule is identical at every reference site.** Components are immutable per
version (`[inv:version-retained]` — bumping `version` never deletes the prior row).
Every place that references a component does so via a `(component_slug, version_pin?)`
pair with one universal resolution rule:

- **`version_pin` is an explicit integer →** resolve to **exactly** that version row.
  Pinned references are frozen; releasing X v2 does not affect them.
  Per Decision 5, the stored `version_pin` integer is a
  `registry_component_versions.version_id` (a stable single-column surrogate), not a
  human `version` number — this is what lets the pin be a DB-enforced FK. Callers may
  still pin ergonomically by `(slug, version)`; `CompositionStore.attach` /
  `resolvePinVersionId` resolve that pair to the `version_id` actually stored.
- **`version_pin IS NULL →** resolve to the **highest existing `version` for that
  `component_slug` at resolution time** ("latest"). Releasing X v2 advances every
  unpinned reference on its next resolution.

**Applied consistently at all three reference sites:**

1. **Junction rows** (`registry_agent_components.version_pin`) — agent A pins v1
   (frozen), agent B is null → latest (advances to v2). Each agent's composition is
   independent; one advancing never disturbs another's pin.
2. **Policy references** (`@adhd/agent-policy`) — where a policy template references a
   prompt component (e.g. a policy whose `enforcement` includes `agent` materializes
   as a `rule`-type component), it carries the **same** `(slug, version_pin?)` pair
   with the same rule. A category-level policy referencing X **v1** evaluated against
   agent B (who takes X latest in its own junction) resolves the **policy's** copy of
   X to **v1** (the policy pinned it) — the agent's separate unpinned junction
   reference to X still resolves to latest. **The two references are independent;
   neither overrides the other.** This directly answers the DATA_MODEL's worked
   example: pins are per-reference, so there is no conflict to resolve — each reference
   gets the version it asked for.
3. **Experiment definitions** (`@adhd/agent-mcp` experiment assignments) — an
   experiment variant that wants reproducibility **pins explicit versions** for the
   components it varies; an experiment that wants "current behavior" leaves them null
   (latest). Because the assignment records the resolved `component_versions` JSON in
   the resulting `composed_prompts` row, the exact versions used are always auditable
   regardless of pin/latest.

**Invariant that makes this safe:** `composed_prompts.component_versions` (JSON) records
the **resolved** version of every component at assembly time. The cache key
(`context_hash`) and the recorded versions together mean a cached composed prompt is
reused only while its inputs are unchanged; an unpinned reference advancing to a new
latest changes the resolved versions, which is a cache miss → recompile. Pins and the
cache therefore compose cleanly.

**Rationale.**

- Putting the pin on the **reference** (not the component) is the only model under which
  "A pins v1 while B takes latest" is expressible at all, and it makes the three
  reference sites trivially consistent: same `(slug, version_pin?)` shape, same
  resolution function everywhere.
- "Null = latest-at-resolve" (not latest-at-attach) keeps unpinned references tracking
  improvements automatically, with the `composed_prompts` audit trail capturing exactly
  what was used — so "automatic latest" never means "untraceable."

**Trade-off accepted.** Unpinned references can change behavior when a component is
bumped, even if the referencing agent/policy/experiment was not touched. This is the
intended behavior of "latest"; anyone needing stability pins. The `composed_prompts`
version record + cache-miss-on-version-change make the change observable and never
silent.

**DAG impact: NONE.** `version_pin` is already part of `[def:junction-row]` in
`contexts/_shared.md` and exercised by the `composition-junction` state (which tests
ordering + pin + context). This decision specifies the resolution rule; it does not add
or reshape a state.

---

## Decision 5 — Component identity vs. version modeling: head/version split (POST-EXECUTION CORRECTION)

> **Status:** binding. Recorded AFTER the schema-phase states executed, as a
> deliberate foundation correction before the registry-family schemas merge or any
> dependent plan (`agent-compiler`, `agent-registry-migration`) builds against the
> component shape. The schema-phase state.json / dag.json are NOT changed; this is a
> design correction with full code + migration + test coverage, not a re-plan.

**Question.** The original `lookup-and-component-schema` state modeled a component as a
single `registry_prompt_components` table with a **composite** PRIMARY KEY
`(slug, version)`. That makes `slug` a non-unique column, so it **cannot be a foreign
key target**. As a consequence, every reference to a component was a *logical FK only*
(a plain text column, no DB enforcement): `registry_agent_components.component_slug`,
`registry_component_usage.component_slug`, `registry_context_rules.component_slug`, and
the `registry_agent_components.version_pin` (which pointed at a `version` number with no
row guaranteed to exist). Orphan references and pins to nonexistent versions were
silently accepted — exactly the referential-integrity holes Decision 1 already accepted
*across* packages but never intended *within* a package, where Decision 1 §3 explicitly
keeps in-package FKs enforced.

**Decision.** **Split component IDENTITY from component HISTORY** so the identity has a
single-column PK that other tables can FK onto with real enforcement:

- **`registry_components`** (identity / head) — `slug` text **PRIMARY KEY** (single
  column), `type` text NOT NULL **enforced FK → `registry_prompt_types.slug`**,
  `is_shared` boolean NOT NULL default false, `created_at` text NOT NULL. `type` and
  `is_shared` are identity-level facts (what the component IS), so they live on the head
  and never change per version.
- **`registry_component_versions`** (history / audit) — `version_id` integer **PRIMARY
  KEY autoincrement** (single-column surrogate, FK-able), `slug` text NOT NULL
  **enforced FK → `registry_components.slug`**, `version` integer NOT NULL, `content`
  text NOT NULL, `created_at` / `updated_at` text NOT NULL, and a real
  **`UNIQUE(slug, version)`** index. Bumping a component appends a new version row at
  `max(version)+1`; old rows are retained (`[inv:version-retained]`, now with DB teeth
  via the unique index).

**The four references are now real DB-enforced FKs:**

1. `registry_agent_components.component_slug` → **`registry_components.slug`** (enforced).
2. `registry_agent_components.version_pin` → **`registry_component_versions.version_id`**
   (NULLABLE-enforced FK; null = resolve latest at resolve-time, set = exactly that
   version row, now guaranteed to exist). Modeled as **two SEPARATE FKs** on the
   junction (`component_slug` always-enforced + `version_pin` nullable-enforced), NOT one
   composite `(component_slug, version_pin)` FK: SQLite treats a composite FK with a NULL
   column as satisfied (un-enforced), which would lose enforcement for the common
   null-pin case.
3. `registry_component_usage.component_slug` → **`registry_components.slug`** (enforced).
4. `registry_context_rules.component_slug` → **`registry_components.slug`** (enforced).

**`registry_composed_prompts.component_versions` (audit map).** Kept as
`{componentSlug: version}` — human `version` numbers, not `version_id`s. Rationale: this
column is a human-readable audit trail (GOAL.md "Audit Trail"), `(slug, version)` is the
form an operator reads and reasons about, and `ComponentStore.resolveVersionId(slug,
version)` maps it to a `version_id` whenever a stable surrogate is needed. It is a JSON
audit record, not an FK, so it does not require the surrogate.

**Why this over the single-table model:**

- **Enforceable in-package integrity.** A single-column PK is the only shape SQLite can
  FK onto. This is what turns four "logical FKs" into four enforced ones, closing the
  orphan-reference and dangling-pin holes — proven by FK-teeth tests that FAIL when any
  FK is removed.
- **`version_pin` integrity.** Pinning to a `version_id` (a row that must exist) is
  strictly safer than pinning to a `version` number (which the old model could not
  guarantee corresponded to any row).
- **Multi-writer integrity.** With several registry-family packages and the migration
  importer writing concurrently, DB-level enforcement (not store-layer discipline alone)
  is what prevents a careless writer from leaving orphans.
- **Audit.** Identity vs. history separation makes "what is this component" (one head
  row) and "how has it changed" (its version rows) first-class and independently
  queryable.

**Store-API impact (semantics preserved).** `ComponentStore.create/read/readVersion/
version/list` keep their names and meaning; `create()` writes head + v1 atomically,
`version()` appends a version row, `read()` joins head to its latest version. The
public `PromptComponent` gains a `versionId` field, and two helpers are added:
`ComponentStore.resolveVersionId(slug, version)` and `CompositionStore.resolvePinVersionId
(slug, version)` plus an ergonomic `attach({ pinVersion })`.

**Trade-off accepted.** Two tables and a head↔version join instead of one table. The join
is a single indexed `slug` equality and only runs in the store layer; the integrity and
audit gains far outweigh it.

**DAG impact: NONE.** No schema-phase state is added, removed, or reshaped. Downstream
plans consume the registry through `ComponentStore` / `CompositionStore` /
`resolveComposition` and the `composed_prompts` audit map — all preserved — so their
DAGs are unaffected. Their *contract notes* are updated (head/version shape) for accuracy.

---

## Summary

| # | Decision | Rule (one line) | DAG impact |
| :- | :------- | :-------------- | :--------- |
| 1 | DB topology | One shared SQLite file, `registry_*`/`tool_*`/`provider_*`/`policy_*` prefixes, one handle, no `ATTACH`, no cross-package FK | none (recommended/baseline) |
| 2 | Context-condition evaluation | ALL matching included; total order `(position, version, slug)`; `is_required` unmatched ⇒ error | none |
| 3 | `context_condition` vs `context_rules` | Keep both tables, one shared predicate evaluator, additive union, junction wins on dedup | none |
| 4 | Version-pin semantics | Pin is per-reference; null = latest-at-resolve; stored pin is a `version_id` (Decision 5); identical at junction / policy / experiment sites | none |
| 5 | Component identity vs. version | Split `registry_components` (head, slug PK) from `registry_component_versions` (history, version_id PK) so the 4 component references become DB-enforced FKs + version_pin integrity | none (post-execution correction) |

**No decision changes the DAG.** All five resolve to the options the downstream plans
(`agent-tool-registry`, `agent-provider`, `agent-policy`, `agent-compiler`) were
authored to consume. No planner-class amendment is required.
