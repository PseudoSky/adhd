# Architecture Decisions — `@adhd/agent-compiler` (Composition & Compile Engine)

> **Status:** binding. Written in the `compiler-design` (architecture) state of the
> `agent-compiler` plan, BEFORE any compiler code is frozen. Every later state of
> this plan — `scaffold-package`, `composition-resolve`, `tool-header-emit`,
> `model-and-policy-emit`, `platform-markdown-emit`, `compile-cli`,
> `composed-prompt-caching`, `compile-fixtures-e2e` — treats these as the binding
> resolution of the open consumption / header / topology / cache questions raised in
> `contexts/compiler-design.md`. Re-deciding any of these in a later state is a
> planner-class amendment, not a local choice.
>
> Source requirements: `docs/plan/agent-registry/{USAGE,DATA_MODEL,SEED_DATA}.md`
> (USAGE "Compiling to Markdown", "Context-Conditional Composition", "Applying
> Policies", "Runtime Integration via agent-mcp"; DATA_MODEL Domain 1 "Composed
> Prompts" + Domain 5 "Runtime Sink"; SEED_DATA §5 platforms / §6 tool bindings /
> §7 model bindings / §14 example agents) and `contexts/{compiler-design,_shared}.md`.
>
> **Upstream binding it consumes (not re-decides):**
> `agent-registry-schema/decisions.md` — DB topology (Decision 1), context-condition
> evaluation semantics (Decision 2), `context_condition`/`context_rules` unification
> (Decision 3), version-pin semantics (Decision 4), head/version split (Decision 5).

`@adhd/agent-compiler` is the CONVERGENCE package. It is `platform:node`
(`[inv:platform-node]` — pure Node + SQLite, no `react`/`window`/`document`). It
opens ONE handle to the shared registry-family SQLite file and JOINS across the four
table prefixes to turn an agent definition + a runtime context into a flat,
platform-shaped artifact, recording every compile in `registry_composed_prompts`.

The public surface (`[ref:compile-agent]`) is:

```ts
compileAgent({ agentSlug, platform, context, db }): {
  id: number;                         // registry_composed_prompts row id (audit/cache handle)
  content: string;                    // flat platform artifact (markdown | JSON string)
  tools: string[] | ToolDefinition[]; // resolved per platform
  componentVersions: Record<string, number>;  // {componentSlug: resolvedVersion}
}
```

It composes four real upstream primitives (verified to exist in `src/`):

| Concern        | Upstream primitive (real signature)                                                        |
| :------------- | :----------------------------------------------------------------------------------------- |
| body order     | `CompositionStore.resolveComposition(agentSlug, ctx) → ResolvedComponent[]` (`agent-registry`) |
| cache key part | `contextHash(context: Record<string,string>) → string` (`agent-registry`)                  |
| cache row      | `ComposedPromptStore` + `registry_composed_prompts` (`agent-registry`)                      |
| tool alias     | `BindingStore.resolve(canonicalToolName, platformId) → platformToolName` (`agent-tool-registry`) |
| model alias    | `ModelStore.resolveModelId(canonicalId, platform) → platformModelId` (`agent-provider`)    |
| API tool shape | `emitToolsForProvider(...)` + `provider_tool_formats` / `EmitShape` (`agent-provider`)      |
| policy rows    | `AgentPolicyStore.resolveForAgent(agentSlug) → AgentPolicyRow[]` (direct + inherited) (`agent-policy`) |

---

## Decision A — Context-condition precedence: CONSUMED from `agent-registry`, never re-evaluated

**Question (`contexts/compiler-design.md` Delta-Spec 1 / `[inv:context-precedence-consumed]`).**
When two `registry_agent_components` junction rows share a `position` with different
`context_condition`s and more than one matches the runtime context, which wins — and
does the compiler decide that, or does it delegate?

**Decision.** The compiler **delegates the precedence rule entirely** to
`CompositionStore.resolveComposition(agentSlug, context)` and **does not re-evaluate
conditions, ordering, or version pins itself.** The rule it consumes — frozen verbatim
in `agent-registry-schema/decisions.md` **Decision 2** — is:

> **ALL matching components are `all included`.** A `context.condition` is an
> *inclusion filter*, not a selector; `position` is an ordering key, not a unique slot.
> Every component whose `context.condition` matches (or is null) is included; **no
> matched component is dropped because another also matched — there is no "winner"**
> in the last-wins sense. Determinism comes from the total order
> `(position ASC, resolved-version DESC, component_slug ASC)`, NOT from any
> `last wins` `precedence` tie-break. A `null` condition is always included; a
> `is_required` row whose condition does NOT match raises `CompositionError`
> (`REQUIRED_COMPONENT_EXCLUDED`).

So the **precedence** semantics are: *no row supersedes another at the same position —
the engine emits both in the deterministic total order*; the only place a "drop"
happens is a non-required unmatched filter (excluded) or a required unmatched filter
(error). The literal `all included` rule (NOT `last wins`) is what `compiler-design.2`
greps for, and it is what the compiler honours.

**How the compiler consumes it (binding):**

1. `compileAgent` calls `resolveComposition(agentSlug, context)` exactly once and emits
   the body sections **in the returned array order, verbatim** (`[def:junction-order]`).
   It MUST NOT re-sort, re-filter on `context.condition`, or re-resolve version pins —
   `resolveComposition` already applied the `(position, version, slug)` total order and
   the version-pin rule (`agent-registry` Decision 4) internally (verified in
   `composition-store.ts:243` — sort + `_resolveComponentVersion`).
2. The `success_criteria` use case from `SEED_DATA.md` §14 `code-reviewer` (position 6
   `security-audit-criteria` conditioned `{"ticket_type":"security"}`) is therefore
   handled by `resolveComposition`: context `{"ticket_type":"security"}` includes it;
   any other context excludes it. The compiler asserts the *outcome*
   (`[inv:platform-shaped-observable]`: body contains / omits that section), never the
   condition logic.
3. **Escalation rule.** If a real seeded fixture ever exposes that this precedence rule
   is under-specified (e.g. two required rows mutually exclude), the compiler does NOT
   invent a tie-break — it escalates a planner-class amendment against
   `agent-registry-schema`, per `[inv:context-precedence-consumed]`. As of this writing
   Decision 2 is fully specified, so no amendment is open.

**Downstream implications.** `composition-resolve` state implements `resolve/composition.ts`
as a thin adapter over `resolveComposition` (audit `composition-resolve.1` greps
`resolveComposition`/`junction order`/`position`). No second condition evaluator exists
in this package — there is exactly one owner of the rule, upstream.

**Rationale.** A second evaluator is the classic drift hazard the upstream Decision 3
("one predicate evaluator") was written to prevent. Re-implementing precedence here
would let the compiler and registry disagree about what an agent *is* — the worst
possible bug in a code-generation step. Delegation makes the rule single-sourced and
the compiler a pure projection.

---

## Decision B — Per-platform header builder contract: `yaml_frontmatter` / `json_object` / `none`

**Question (`contexts/compiler-design.md` Delta-Spec 2).** For each platform
`header_format` (`SEED_DATA.md` §5), exactly what does the **header builder** emit —
field set, ordering, and how tools/model resolve into it?

**Decision.** A per-platform **header builder** is selected by the platform's
`header_format` column. There are exactly three builders, one per format value seeded in
§5 (`yaml_frontmatter` → `claude_code`; `json_object` → `claude_api`/`openai`/`bedrock`;
`none` → `cursor`/`vscode`). Each consumes the same resolved inputs (composed body,
resolved tool aliases, resolved model alias, effective policy rules) and projects them
into its format. The builder is selected by data, never by a hard-coded platform check.

### B.1 `yaml_frontmatter` (claude_code) — the headline format

Emits a YAML frontmatter block, a `---` fence, then the markdown body. Field set and
order are FROZEN:

```text
---
name: <agent.slug>
description: <agent.description>
tools: <comma-joined resolved platform aliases, in agent_tools grant order>
model: <resolved platform model alias>
---

<body: resolveComposition sections joined in junction order, "\n\n" between>
```

- `tools:` — built by `BindingStore.resolve(canonicalTool, "claude_code")` for each
  `tool_agent_tools` grant (e.g. `file_read`→`Read`, `shell_exec`→`Bash`,
  `web_search`→`WebSearch`; `SEED_DATA.md` §6 claude_code bindings). The line is the
  consumer-visible observable (`[inv:platform-shaped-observable]`: frontmatter `tools:`
  equals the resolved aliases). An agent with no grants emits no `tools:` line (NOT
  `tools:` empty) — matching `evidence-validator` (§14, "none").
- `model:` — `ModelStore.resolveModelId(agent.model_hint, "claude_code")` (e.g.
  `claude_sonnet_4_6`→`sonnet`; §7 claude_code aliases). Omitted if the agent has no
  `model_hint`.
- **Policy rendering** — effective policy rules (`AgentPolicyStore.resolveForAgent`,
  direct + inherited) render as `[def:policy-constraint]` body text (a `## Policies` /
  constraint block appended to the body), NOT as frontmatter keys, because `claude_code`
  frontmatter has no policy field. Observable: the constraint text (e.g.
  `no-credentials` → "Never write API keys…") appears in `content` (`dod.3`).
- CLI stdout for `claude_code` therefore **begins with `---`**
  (`[inv:platform-shaped-observable]`, `dod.5`).

### B.2 `json_object` (claude_api / openai / bedrock)

Emits a JSON **string** (`content` is `JSON.stringify(...)`) — NOT YAML, no `---`:

```jsonc
{
  "name": "<agent.slug>",
  "systemPrompt": "<flat body: same resolveComposition sections + policy block, joined>",
  "model": "<resolveModelId(model_hint, platform)>",   // full id, e.g. claude-sonnet-4-6
  "tools": [ /* structured tool array */ ]
}
```

- `systemPrompt` is the **flat body** (the same composed sections as B.1, minus the YAML
  header; policy constraints folded into the prompt text).
- `tools` is a **structured array**, shaped via `provider_tool_formats` through
  `emitToolsForProvider(...)` / `EmitShape` (`agent-provider`) — per-platform tool
  definitions, NOT a comma string. Tools whose platform binding is `unavailable` for the
  target (e.g. `human_input`/`code_analysis` on `claude_api`, §6) are **omitted**, not
  emitted as broken stubs.
- `model` resolves to the **full** platform id (`claude-sonnet-4-6`), per §7 claude_api
  bindings — distinct from the claude_code alias.

### B.3 `none` (cursor / vscode)

Body only: `content` = the flat composed `systemPrompt` body (with policy block), no
frontmatter, no JSON envelope, no `tools` declaration (these platforms have
`supports_tool_selection = false`, §5). `tools` in the return object is `[]`.

**Selection (binding).** The `header builder` is chosen by reading the target row's
`header_format` from `provider_*`/`platforms` and dispatching: `yaml_frontmatter` →
markdown emitter (`emit/markdown.ts`), `json_object` → JSON emitter (`emit/json.ts`),
`none` → body emitter. Adding a platform with an existing `header_format` requires **no
compiler code** — it reuses the builder. (Open: a genuinely new `header_format` value
would be a planner-class amendment; none is seeded.)

**Downstream implications.** `tool-header-emit` owns `resolve/tools.ts` (joins
`tool_platform_bindings`); `model-and-policy-emit` owns `resolve/model.ts` +
`resolve/policy.ts`; `platform-markdown-emit` owns `emit/markdown.ts` (audit greps
`frontmatter`/`---`) and `emit/json.ts` (audit greps
`json_object`/`JSON.stringify`/`systemPrompt`). The `yaml_frontmatter` / `json_object`
tokens above are what `compiler-design.3` greps.

**Rationale.** One builder per `header_format` (not per platform) keeps the matrix at 3
code paths for 6+ platforms and makes the compiler data-driven — the platform table, not
the code, decides shape. This is the only design under which "add bedrock" is a seed-row
change, not a code change.

---

## Decision C — Cross-package join: ONE handle, prefix-qualified, no `ATTACH`, no cross-FK

**Question (`contexts/compiler-design.md` Delta-Spec 3 / `[inv:one-db-handle]`).** How
does the compiler read rows that live in four different packages?

**Decision.** **INHERITED from `agent-registry-schema/decisions.md` Decision 1 — not
re-decided here.** The four registry packages share **one SQLite file** with
**table-name prefix** namespacing: `registry_*` (agent-registry), `tool_*`
(agent-tool-registry), `provider_*` (agent-provider), `policy_*` (agent-policy). The
compiler:

1. Opens **exactly one** `better-sqlite3` handle to that single SQLite / `one DB` file
   and queries all four prefixes through it. **No `ATTACH DATABASE`. No second DB file.
   No cross-package SQLite foreign key.** (Quoting Decision 1 §1–2 verbatim.)
2. Joins across prefixes are **ordinary application-level `SELECT … JOIN`s** on the
   logical text keys (`registry_agents.slug` ↔ `tool_agent_tools.agent_slug` ↔
   `policy_agent_policies.agent_slug`), since cross-package links are logical, never
   FK-enforced (Decision 1 §2). The compiler enforces cross-package referential
   integrity in its own code (a grant naming a missing tool is a typed compile error),
   because SQLite does not.
3. Reads go **through the published store classes** where they exist
   (`[ref:store-read]`: `resolveComposition`, `BindingStore.resolve`,
   `ModelStore.resolveModelId`, `AgentPolicyStore.resolveForAgent`), falling back to
   thin Drizzle reads against the prefixed tables — all on the **same handle**.

The `table-name prefix` tokens `registry_` / `tool_` / `provider_` / `policy_` and
`single SQLite` / `one DB` above are what `compiler-design.4` greps.

**Downstream implications.** Every store the compiler instantiates is constructed with
the **same** `db`/`sqlite` handle threaded through `compileAgent({…, db})`. The e2e
fixture (`seed/fixtures.ts`) seeds REAL rows into all four prefixes on that one file
(`[inv:real-rows-not-mocks]`), and the cache test proves persistence by **closing and
reopening** the one file (`[inv:reopen-proves-cache]`). There is no second connection to
keep coherent.

**Rationale.** Cited, not argued — Decision 1 already established this is the
DAG-neutral, single-`SELECT` topology the compiler plan was authored against
(`agent-compiler/README.md` "central assumption"). Re-opening it would be a planner-class
amendment with NO upside; the single handle is precisely what makes the convergence join
trivial.

---

## Decision D — Composed-prompt cache key: hash over `(context, resolved component-version set)`

**Question (`contexts/compiler-design.md` Delta-Spec 4 / `[def:context-hash]`).** What
keys a `registry_composed_prompts` cache row, and what forces a miss?

**Decision.** The cache key is a **canonical hash over the pair `(context, resolved
component-version set)`**, scoped to `(agent_slug, platform)`. A change to **either**
the runtime context **or** the resolved version of any component **must miss** the cache.

**Binding canonicalization (frozen):**

1. **Context part.** Canonicalize `context` as **sorted-key JSON** — `Object.keys(context)
   .sort()` then `JSON.stringify`. This is exactly the existing
   `contextHash(context: Record<string,string>)` helper in
   `agent-registry/composed-prompt-store.ts` (verified: it sorts keys then
   `JSON.stringify` then SHA-256). The compiler **imports and reuses** that helper for
   the context part — it does NOT reimplement it (`[ref:store-read]`).
2. **Version part.** Canonicalize the **resolved `componentVersions` map**
   (`{componentSlug: resolvedVersion}` from `resolveComposition` /
   `registry_composed_prompts.component_versions`) the **same way** — sort by
   `componentSlug`, `JSON.stringify`.
3. **Combined key.** `context_hash = SHA-256( sortedJSON(context) + " " +
   sortedJSON(componentVersions) )` — a single canonical string over BOTH parts, with a
   ` ` field separator so the two JSON blobs can never collide by concatenation.
   The row is stored as `registry_composed_prompts(agent_slug, platform, context_hash,
   content, component_versions, …)` and looked up by `(agent_slug, platform,
   context_hash)`.

   > **Note (load-bearing for `composed-prompt-caching`):** the bare upstream
   > `contextHash(context)` helper hashes the **context only**. It is reused for the
   > context part but is NOT sufficient as the whole cache key, because an **unpinned**
   > component advancing to a new latest (Decision 4: null pin = latest-at-resolve)
   > changes the body while leaving the context identical — that MUST be a miss. The
   > compiler therefore folds the resolved `componentVersions` into the hash as above.
   > The `composed-prompt-caching` state implements this combined key in
   > `cache/composed-prompt-cache.ts` (audit greps `composed_prompts`/`context_hash`).

**Miss/hit semantics (the testable outcome, `dod.4`):**

- **Hit:** same `(agent_slug, platform)`, same `context`, and every referenced component
  still resolves to the same version → identical `context_hash` → reuse the persisted
  `content` and `id` **without recomposing**. Proven by **reopening** the closed SQLite
  file and asserting the second `compileAgent` returns the persisted row
  (`[inv:reopen-proves-cache]`).
- **Miss (recompile + new row):** any context key/value change (different
  `sortedJSON(context)`); OR an unpinned component bumped (different
  `sortedJSON(componentVersions)`); OR a different `platform`. Each yields a new
  `context_hash` and a fresh compile + insert.

**Downstream implications.** `compileAgent` is **cache-first**: compute the resolved
composition (cheap read) → derive `componentVersions` → compute `context_hash` → SELECT;
on hit return; on miss emit + INSERT + return. The `componentVersions` must be the
**resolved** versions (post version-pin), so the cache composes cleanly with Decision 4
(pin = frozen, null = advances → version-part changes → miss).

**Rationale.** Hashing only the context (the literal name `context_hash` is a slight
misnomer kept for schema compatibility) would serve a **stale** body whenever an unpinned
component advanced — silently. Including the resolved version set makes the audit trail
(`composed_prompts.component_versions`, GOAL "Audit Trail") and the cache *consistent by
construction*: the same key implies the same recorded versions, and any version drift is
a visible miss, never a silent stale hit.

---

## Summary

| # | Decision | Rule (one line) | Consumed/Owned |
| :- | :------- | :-------------- | :------------- |
| A | Context precedence | `all included` (NOT `last wins`); compiler delegates to `resolveComposition`, never re-evaluates `context.condition` | consumed from agent-registry Decision 2 |
| B | Header builder | one `header builder` per `header_format`: `yaml_frontmatter` (claude_code), `json_object` (claude_api/openai/bedrock), `none` (cursor/vscode) | owned here |
| C | Cross-package join | ONE handle to the `single SQLite` / `one DB` file; `registry_`/`tool_`/`provider_`/`policy_` `table-name prefix`; no `ATTACH`, no cross-FK | inherited from agent-registry Decision 1 |
| D | Cache key | `context_hash` = sorted-key-JSON hash over `(context, resolved componentVersions)`; context-only is insufficient (unpinned advance ⇒ miss) | owned here |

**No decision changes the DAG.** A and C consume frozen upstream decisions; B and D
specify the compiler's own internal contract within states already scheduled
(`platform-markdown-emit`, `composed-prompt-caching`). No planner-class amendment is
required, and none is open.

---

## Decision E — Model fallback: return canonical id when no platform binding exists

**State:** `model-and-policy-emit` · **Recorded by:** executor, append-only.

**Situation.** `resolveModel(db, agentSlug, platform)` calls
`ModelStore.resolveModelId(modelHint, platform)`. If no `provider_model_platform_bindings`
row exists for the `(modelHint, platform)` pair, `ModelStore` throws
`MODEL_BINDING_NOT_FOUND`.

**Decision.** On `MODEL_BINDING_NOT_FOUND`, `resolveModel` returns the raw `model_hint`
string (the canonical id, e.g. `claude_opus_4_8`) rather than throwing or returning `''`.

**Rationale.** A missing binding is a seed/config gap, not a compile-time error. The
compiler should produce a usable artifact with the canonical id rather than aborting the
entire compile. The caller (`platform-markdown-emit` / `compile-cli`) may log a warning,
but the compile continues. An agent with a well-seeded registry (the normal case) is
never affected.

**Impact.** Isolated to `resolve/model.ts` — no other state is affected. If a stricter
policy is preferred for a specific platform (throw instead of fall back), that is a
planner-class amendment, not a local choice.
