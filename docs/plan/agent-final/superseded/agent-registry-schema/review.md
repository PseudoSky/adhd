# Code Review Sign-Off — `@adhd/agent-registry`

**Reviewer:** code-reviewer (senior)
**Branch:** `agent-registry-execution`
**HEAD:** `f2a8721a83312ccb801b869220f4fd9311688b5d`
**Merge base (main):** `34ed69a0c9cdf65daeb31b51654583b56ea09d79`
**Scope:** `git diff <merge-base>..HEAD -- packages/ai/agent-registry` (37 files, +6875)
**Posture:** project default-skeptic — default NEEDS-WORK, PASS only if explicitly justified.

---

## How this review was grounded (tool evidence)

- **Read** all 13 source files under `src/` (schema, 5 stores, db client/migrate/migrate-runner, index, 3 seed files), all 6 test files, `project.json`, `package.json`, `tsconfig.json`, `tsconfig.lib.json`, the PK-fix commit `d747ad4`, the contract `decisions.md`, and both relevant plan context files.
- **Ran** `npx nx test agent-registry` → **55 tests / 6 files pass, exit clean.**
- **Ran** `npx nx build agent-registry --skip-nx-cache` (after `rm -rf dist`) → **build passes.**
- **Ran** `npx nx typecheck agent-registry --skip-nx-cache` → **FAILS (14 errors).** See [NB-1].
- **Proved PK teeth independently** with a standalone better-sqlite3 script replaying migration 0005's DDL: a real composite `PRIMARY KEY` rejects a duplicate (`SQLITE_CONSTRAINT_PRIMARYKEY`), and the *old* `CREATE INDEX` shape does **not** reject the duplicate — confirming the fix is load-bearing.

---

## The PK fix (commit d747ad4) — VERIFIED SOUND

The previously-flagged defect (composite keys declared as non-unique `index()` instead of real PKs) is genuinely fixed:

- `schema.ts:59` `promptComponentsTable` → `primaryKey({ columns: [t.slug, t.version] })`
- `schema.ts:166` `componentUsageTable` → `primaryKey({ columns: [t.componentSlug, t.useCaseSlug] })`
- `schema.ts:305` `agentComponentsTable` → `primaryKey({ columns: [t.agentSlug, t.componentSlug, t.position] })`

All three are real `primaryKey(...)`, NOT `index()`.

- **Migration emits real constraints.** `drizzle/0005_warm_norman_osborn.sql` performs the SQLite table-recreate dance and emits `PRIMARY KEY(...)` + the FK + `NOT NULL` for each of the three tables. The `0005_snapshot.json` records each under `compositePrimaryKeys` (not as an index).
- **No secondary index lost.** For each rebuilt table, the prior secondary indexes are re-created in the same migration: `agent_idx` + `position_idx` (agent_components), `use_case_idx` + `component_idx` (component_usage), `slug_idx` + `type_idx` (prompt_components). Cross-checked against `schema.ts` — index set is unchanged; only the bogus `*_pkey` index was promoted to a real PK.
- **The duplicate-insert test has teeth.** `component-store.test.ts` "composite PK (slug, version) enforcement" inserts the same `(slug=pk-dup-test, version=1)` twice and asserts `.toThrow()`. Independently confirmed via the standalone DDL replay that the real PK throws and the reverted index shape would not — so the assertion bites if the PK is reverted.

---

## Findings

### Non-blocking

#### [NB-1] `typecheck` target fails (TS6306 + 14× TS6305) — pre-existing repo-wide tsconfig misconfiguration this package reproduced
- **Where:** `packages/ai/agent-registry/tsconfig.json:15-19` references `tsconfig.lib.json`, which lacks `"composite": true` (`tsconfig.lib.json` has no `composite` setting).
- **Problem:** `nx typecheck agent-registry` runs `tsc -p tsconfig.json --noEmit`. Because `tsconfig.json` declares a project `references: [{ path: "./tsconfig.lib.json" }]` but the referenced project is not `composite`, tsc emits **TS6306** ("Referenced project … must have setting `composite: true`") plus **TS6305** for every `.d.ts` it expects in `dist/`. This fails **even after a clean `dist`** — it is a config defect, not a stale-artifact artifact.
- **Severity rationale (why non-blocking, not blocking):** I verified the **identical pattern and identical failure** on the sibling `agent-mcp` package (`nx typecheck agent-mcp` also fails with the same shape). This is an inherited copy-paste convention across `packages/ai/*`, not a regression introduced by this package's source. The real ship gates — `build` and `test` — both pass. No source-level type error exists; `nx build` (which invokes `tsconfig.lib.json` directly) compiles cleanly.
- **Fix (one line):** add `"composite": true` to `packages/ai/agent-registry/tsconfig.lib.json` `compilerOptions` (and `tsconfig.spec.json` if a spec reference is later added). This is the standard fix for a referenced project. Because it is repo-wide, the orchestrator may prefer to route it as a separate cross-cutting cleanup rather than block this merge — but it should be tracked, not buried.

#### [NB-2] Stale rationale comment in `seed/index.ts` now contradicts the schema after the PK fix
- **Where:** `packages/ai/agent-registry/src/seed/index.ts:50-51`.
- **Problem:** The comment states *"registry_prompt_components has no UNIQUE constraint on (slug, version) — only a regular index — so ON CONFLICT DO NOTHING would not fire."* After commit `d747ad4`, `(slug, version)` **is** a real composite PRIMARY KEY. The factual premise of the comment is now false. The read-before-write logic itself is still correct and still desirable (it keeps re-seed a silent no-op instead of throwing a constraint error), but a future reader will be misled into thinking no uniqueness exists.
- **Why it matters beyond cosmetics:** Without the read-before-write guard, a second `seed()` run would now **throw** `SQLITE_CONSTRAINT_PRIMARYKEY` rather than silently insert-nothing — so the guard is now the *only* thing keeping seed idempotent. The comment should say that, not claim the constraint is absent. (`roundtrip.test.ts` "seed is idempotent on re-run" proves idempotency holds, so behavior is correct; only the comment is wrong.)
- **Fix:** update the comment to: components now carry a composite `(slug, version)` PRIMARY KEY, so a duplicate insert would *throw*; the read-before-write check is what keeps re-seed an idempotent no-op (`ON CONFLICT DO NOTHING` is not used here because we want to skip silently, not on a specific conflict target).

#### [NB-3] Contract drift: `decisions.md` Decision 3 says `resolveComposition` is the single owner of the context_rules additive merge, but the implementation does not merge context_rules — and that is correct for THIS plan's scope
- **Where:** `decisions.md` Decision 3 §"Binding unification rules" ("…evaluated by the **same** function inside `CompositionStore.resolveComposition`"; "Resolution = (matching junction components) ∪ (components added by matching `context_rules`)") vs. `composition-store.ts:165-219` `resolveComposition`, which reads **only** `agentComponentsTable` junction rows and never touches `context_rules`.
- **Problem:** Decision 3 (the schema-level architecture contract) reads as though the additive union of `context_rules` happens *inside* `resolveComposition`. It does not. The junction-state plan context (`contexts/composition-junction.md` steps 1-4) scopes `resolveComposition` to junction rows only, and the `usecase-and-context-rules` state (`contexts/usecase-and-context-rules.md`) marks `composition-store.ts` **read_only** and notes the compiler consumes `contextRulesFor`. So the merge is intentionally deferred to `@adhd/agent-compiler`. The CODE matches the per-state plan; the DECISIONS.md prose overstates where the merge lives.
- **Severity rationale (non-blocking):** No behavioral defect in *this* package — every in-scope acceptance criterion is met and the single shared evaluator (`evaluateCondition`, exported) is in place so the compiler can reuse it. The risk is downstream: an `agent-compiler` author reading Decision 3 may expect `resolveComposition` to already merge rules and skip implementing the union. Worth a one-line clarification so the contract and the code agree.
- **Fix:** add a sentence to Decision 3 (or a note in `composition-store.ts`) stating that `resolveComposition` owns junction-row resolution + the *shared evaluator*, and that the additive `context_rules` union is performed by the compiler **using that same evaluator** — the "single evaluator" guarantee is satisfied; the merge step lives in the compiler.

### Nits

#### [N-1] Pinned-version resolution loads all versions then `.find()` instead of an exact `(slug, version)` query
- **Where:** `composition-store.ts:233-253` (`_resolveComponentVersion`, pinned branch).
- **Problem:** For a pinned version it selects ALL rows for the slug ordered by version DESC, pulls them into JS with `.all()`, then `.find(r => r.version === pin)`. `ComponentStore.readVersion` (`component-store.ts:163-183`) already does the correct exact `and(eq(slug), eq(version))` `.get()`. The composition path is the hot path and now has a real composite PK that makes the exact lookup an index seek.
- **Impact:** Functional (the test pins v1 with v2 present and passes), purely an efficiency/consistency nit. O(n) row fetch per pinned component vs O(1) seek.
- **Fix:** replace the pinned branch with a single `.where(and(eq(slug), eq(version, pin))).get()` (or delegate to a shared helper used by both stores).

#### [N-2] `composition-store.ts:52` comment "(later) context_rules rows" — pairs with [NB-3]; once [NB-3] is clarified, refresh this to "the compiler's context_rules merge reuses this evaluator" so it doesn't read as unfinished work.

---

## Verified clean (no findings)

- **Platform isolation (`platform:node`):** `project.json:14` tags `["layer:ai", "platform:node"]`. No browser imports anywhere in `src/` (grep for `react`/`window.`/`document.`/`jsdom` in non-test source returns nothing). All DB/crypto imports are Node (`node:crypto`, `better-sqlite3`, `drizzle-orm`).
- **No relative `../../` cross-package imports** and **no cross-package `@adhd/*` runtime imports** — package is self-contained; all `@adhd/*` occurrences are doc comments. In-package imports use `./` / `../` within the package only (allowed).
- **Decision 1 (DB topology):** every table uses the `registry_` prefix; cross-package columns (`model_hint`, `agent_components.component_slug`, `component_usage.component_slug`, `context_rules.component_slug`, `composed_prompts.agent_slug`) are plain `text` with NO `.references()`; in-package FKs (`prompt_components.type`, `agents.taxonomy_category`, `taxonomy.parent_slug` self-FK, `agent_components.agent_slug`, `component_usage.use_case_slug`, `context_rules.agent_slug`) all use `.references()`. Matches the contract exactly. `client.ts` opens one handle, no `ATTACH`.
- **FK topology enforcement:** in-package FKs are real SQLite FKs (the 0005 migration re-emits `FOREIGN KEY (agent_slug) REFERENCES registry_agents(slug)` etc.). The agent-store test "creates a subcategory with a parent_slug self-FK" exercises the self-FK with `foreign_keys = ON`. Logical cross-package links (`component_slug`) are enforced at **resolve time** — `resolveComposition` → `_resolveComponentVersion` throws `COMPONENT_VERSION_NOT_FOUND` when the referenced component/version is absent (proven by the pin test resolving a specific version). Note: `attach()` (`composition-store.ts:119-138`) does NOT validate `component_slug` at write time — invalid links surface at resolve, not insert. This is consistent with the documented "store layer enforces at write/resolve" and the resolve-time enforcement is tested; acceptable by design.
- **`context_hash` (`composed-prompt-store.ts:37-46`):** sorted-key JSON → SHA-256 hex. Order-independent and canonical for the declared input type `Record<string, string>` (flat string map — the contract's runtime context shape). The "nested objects too" concern is N/A: the public type is flat, so there are no nested objects to canonicalize; the implementation is correct for its contract. Teeth: `composed-prompt-store.test.ts` asserts three shuffled key orders hash identically and that sorting-removal would go red. (If the context type is ever widened to nested values, the shallow sort would need a recursive canonicalizer — worth a guard comment, but not in scope now.)
- **`resolveComposition` (Decision 2 + 4):** ordering is `(position ASC, resolvedVersion DESC, componentSlug ASC)` (`composition-store.ts:212-216`) — matches Decision 2's total order. version_pin null → latest via `max(version)`, int → exact (Decision 4). Context filtering via the single `evaluateCondition`. `is_required` + unmatched → `CompositionError('REQUIRED_COMPONENT_EXCLUDED')`. All four behaviors are proven by `composition-store.test.ts` with documented negative controls, and `evaluateCondition` is the single exported evaluator (Decision 3's "one evaluator" guarantee).
- **Test teeth across the board (exit-code gated, real on-disk DB, never `:memory:`):**
  - reopen-persistence: every suite closes the handle and reopens from the same file path before read-back assertions (`[inv:reopen-proves-persistence]`).
  - seed idempotency: `roundtrip.test.ts` re-runs `seed()` and asserts row counts + versions unchanged.
  - nc_mutate / nc_restore negative control: `roundtrip.test.ts` honors `ROUNDTRIP_DB_PATH`, and `scripts/nc_mutate.mjs` / `nc_restore.mjs` / `nc_assert_reopen.mjs` exist to corrupt-then-restore the persisted `default-skeptic` row so the deep-equal reopen assertion fails when mutated.
  - PK enforcement: independently replayed (see above).
- **JSDoc on shared public functions:** present and substantive on all exported store methods, `contextHash`, `evaluateCondition`, `seed`. Interface naming: the codebase convention here uses un-prefixed domain interfaces (`Agent`, `PromptComponent`, `ComposedPrompt`) mirroring the existing `agent-mcp` store pattern rather than the `I`-prefix; consistent within the package and with its sibling, so not flagged.

---

## Verdict

Default posture is NEEDS-WORK, and I am explicitly justifying a PASS. The one previously-blocking defect — composite keys as non-unique indexes — is genuinely fixed at schema, migration, and snapshot level, and I independently proved the duplicate-insert test bites. All 55 tests pass on a clean exit, `build` passes, and every Decision (1-4) is implemented and proven by teeth tests driving a real on-disk DB through reopen. The three non-blocking findings are: a `typecheck`-target tsconfig misconfiguration that is **pre-existing and repo-wide** (the identical failure reproduces on `agent-mcp`) and does not affect the real ship gates; a stale comment in `seed/index.ts` whose described behavior is still correct; and a `decisions.md`-vs-code contract-prose drift about *where* the context_rules merge lives, where the code correctly matches the per-state plan and the deferral to `agent-compiler` is intentional. None of these block the schema package's merge. They should be tracked (NB-1 and NB-2 are trivial one-line fixes; NB-3 is a doc clarification) and routed by the orchestrator rather than buried.

VERDICT: APPROVED

The `@adhd/agent-registry` schema package meets its plan contract and the project's verification standard: the composite-PK fix is sound and teeth-tested, platform/import/topology rules hold, and Decisions 1-4 are correctly implemented with deterministic, reopen-proven, exit-code-gated tests. The three non-blocking items (repo-wide typecheck tsconfig fix [NB-1], stale seed comment [NB-2], decisions.md merge-location clarification [NB-3]) are cleanup/documentation follow-ups that do not gate this merge; the real ship gates (build + test) are green.
