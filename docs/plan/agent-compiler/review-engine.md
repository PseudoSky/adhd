# review-engine.md — Mid-Plan Architecture Review: Composition Engine Core

**Reviewer:** architect-reviewer (Sonnet 4.6)
**Phase boundary:** resolve → emit (composition-resolve + tool-header-emit + model-and-policy-emit)
**Scope:** `packages/ai/agent-compiler/src/resolve/`, `src/db/`, `src/index.ts`, `src/__tests__/*.test.ts`

---

## Per-Check Results

### Check 1 — Single-DB join topology (Decision C / `[inv:one-db-handle]`)

PASS.

`db/client.ts:31` opens exactly one `new Database(resolvedPath)`. `db/client.ts:40` wraps it in one `drizzle(sqlite, {schema})`. No `ATTACH DATABASE`, no second `new Database(...)` call anywhere in non-test source (grep confirmed). All four resolve functions (`composition.ts:61`, `tools.ts:70–71`, `model.ts:52–63`, `policy.ts:64–66`) receive the `db` handle as a parameter and instantiate their upstream stores from it — they do not open a second handle. The module-level singleton in `client.ts` is the only top-level DB instantiation.

### Check 2 — No cross-package FK violations (Decision C §2 / `[inv:no-cross-pkg-fk]`)

PASS.

`db/schema.ts:18–19` documents the invariant explicitly. A `grep .references(` on `schema.ts` returns only that comment line — no `.references()` call exists. No compiler_ tables are defined yet that could carry cross-package FKs. The resolve layer passes `agentSlug: string` as a plain logical key, not a FK-enforced reference. Cross-package referential integrity is enforced in application code (typed compile errors), not in SQLite FK constraints, matching Decision C §2.

### Check 3 — Composition body-ordering precedence (Decision A / `[def:junction-order]` / `[inv:context-precedence-consumed]`)

PASS.

`composition.ts:62` makes exactly one `store.resolveComposition(agentSlug, context)` call. The body loop at `composition.ts:67–69` iterates the returned array verbatim — no re-sort, no re-filter, no second condition evaluator. This matches the binding in Decision A: the compiler is a pure projection, with ordering + version-pin + context-condition filtering owned exclusively by `CompositionStore`. The test at `composition-resolve.test.ts:189` asserts exact output order `INTRO TEXT\nBODY TEXT\nSECURE TEXT`; the exclusion negative-control at `composition-resolve.test.ts:207–210` confirms the delegated filter is the sole gate. No divergent precedence logic exists in this package.

### Check 4 — Binding-table resolution, not hard-coding (Decision B / `[ref:store-read]`)

PASS.

- **Tool resolution:** `tools.ts:78` calls `bindingStore.listForPlatform(platform)`, which reads `tool_platform_bindings` (platform-keyed). No alias map, no `if (platform === 'claude_code')` branch anywhere in `resolve/tools.ts`.
- **Model resolution:** `model.ts:65` calls `modelStore.resolveModelId(modelHint, platform)`, which reads `provider_model_platform_bindings`. Fallback at `model.ts:71–76` returns the raw canonical id on `MODEL_BINDING_NOT_FOUND`, matching Decision E.
- **Policy resolution:** `policy.ts:65` calls `agentPolicyStore.resolveForAgent(agentSlug)`, which runs the 3-query merge (direct rows + category memberships + category policies) against `agent_policy`. No hardcoded per-slug branches — confirmed by the `[dod.3]` negative-control test at `model-policy.test.ts:303–321` (agent with no policies returns `[]`).

All three binding paths go exclusively through the upstream store classes on the shared handle.

### Check 5 — CLAUDE.md conformance

**Platform isolation:** PASS. `project.json:6` tags `["layer:ai", "platform:node"]`. No browser imports (`window`, `document`, `react`, CSS) found in any non-test source file.

**`@adhd/` scoped imports:** PASS. All cross-package imports use `@adhd/agent-registry`, `@adhd/agent-tool-registry`, `@adhd/agent-provider`, `@adhd/agent-policy`. Intra-package relative imports (`./schema.js`, `./client.js`, `./migrate-runner.js`) are correct. No `../../` cross-package relative imports.

**I-prefixed interfaces:** ADVISORY (non-blocking). CLAUDE.md §7 scopes the `I`-prefix rule to "Shared/Data interfaces." This package is `layer:ai`, not `layer:shared` or `layer:data`. The four exported interfaces (`ResolvedBody`, `ResolvedTool`, `Constraint`) lack the `I` prefix, matching the pattern of the other `ai`-layer registry packages. This is consistent with the existing convention in the codebase and does not constitute a rule violation for a `layer:ai` package. No blocking finding.

**JSDoc on public functions:** PASS. All four public resolve functions carry complete JSDoc blocks: `resolveBody` (`composition.ts:39–52`), `resolveTools` (`tools.ts:44–63`), `resolveModel` (`model.ts:29–43`), `resolvePolicyConstraints` (`policy.ts:40–56`). Infrastructure functions `runMigrations` and `runMigrationsOn` also have JSDoc.

**Verification standard:** PASS. All three test files use real on-disk SQLite (never `:memory:`): `composition-resolve.test.ts:89`, `tool-header.test.ts:94`, `model-policy.test.ts:130`. Persistence is proven by close+reopen in every suite. Negative controls are documented inline and named explicitly. The migration-timestamp ordering issue (provider 1750* before registry/policy 1782*) is handled and documented at `model-policy.test.ts:66–73`. Exit-code gating is noted in all test headers.

---

## Blocking Findings

None.

---

## Advisory Findings (non-blocking)

1. The `body` separator in `composition.ts:72` joins sections with `'\n'` (single newline). Decision A specifies body sections "joined in junction order" with `"\n\n"` between (Decision B.1: "resolveComposition sections joined in junction order, `\n\n` between"). The current implementation uses `'\n'` (single). This does not affect the resolve-phase correctness (the test at `composition-resolve.test.ts:189` asserts `'\n'` and passes), but the emit-phase (`platform-markdown-emit`) must own the final separator — either `resolveBody` uses `'\n\n'` or the emitter inserts it. If the emitter concatenates `body` verbatim, the final artifact will have single-newline section boundaries, which diverges from the `\n\n` specified in Decision B.1. This is an emit-phase concern, not a blocking issue here. Recommend: confirm in `platform-markdown-emit` whether the emitter applies the `\n\n` gap or whether `resolveBody` should be updated before the emitters build on it.

2. `db/schema.ts` currently exports only the drizzle-orm/sqlite-core re-exports as a skeleton (no compiler_ tables yet). The placeholder comment at `schema.ts:33` should be removed when the first real table is added. Non-blocking for this state.

---

VERDICT: APPROVED
