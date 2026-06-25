# review.md — FINAL Architecture Review: `@adhd/agent-compiler` full implementation

**Reviewer:** architect-reviewer (Opus 4.8)
**Gate:** `code-review` (second of two review gates; mid-plan `review-engine.md` cleared resolve→emit)
**Scope:** full diff `compiler-design … compile-fixtures-e2e` — `packages/ai/agent-compiler/src/{resolve,emit,cache,cli,seed,db}/*.ts`, `compile.ts`, `index.ts`, `src/__tests__/*.test.ts`
**Test run:** `npx nx test agent-compiler` → **EXIT 0**, 8 files / 75 tests passed (captured `/tmp/compiler_test.log`; gated on exit code per CLAUDE.md std #4, not on stdout).

---

## Verdict rationale

Five of the six mandatory design-intent checks PASS cleanly with file:line evidence, and both orchestration-flagged items (a)/(b) are acceptable as built. The shipped code is correct. The single blocking finding is a **test-teeth gap on the headline behavioral guarantee of Decision D** (the cache's version-drift miss), which is one of the criteria this gate exists to enforce (`composed_prompts cache keyed on the RIGHT context hash`) and which the structural audit cannot catch. Default posture for a gate is NEEDS-WORK; this finding keeps it there until a tooth is added.

---

## Per-check results (6 mandatory)

### Check 1 — Single-DB cross-package join topology (Decision C / `[inv:one-db-handle]`) — PASS

`db/client.ts:31` opens exactly one `new Database(resolvedPath)`; `client.ts:40` wraps it in one `drizzle(sqlite,{schema})`. The CLI (`cli/compile.ts:198`) opens exactly ONE `new Database(dbPath)` per invocation and threads that single handle through `compileAgent({…, db})` (`cli/compile.ts:229-234`). `compileAgent` constructs every upstream store from that same `db`: `AgentStore` (`compile.ts:175`), `CompositionStore` (`compile.ts:132`), `BindingStore` (`compile.ts:106`), and the resolve-layer stores all receive the parameter handle. Grep confirms NO `ATTACH DATABASE` in source (`client.ts:11` is the comment documenting its absence) and the only two `new Database(` sites are the package singleton and the CLI entrypoint — neither is a *second* connection within a compile. No second connection to keep coherent. **Single-handle topology holds.**

### Check 2 — Composition-order precedence (Decision A / `[def:junction-order]`) — PASS

`compile.ts:133` (`extractBodyParts`) makes exactly one `store.resolveComposition(agentSlug, context)` call and the loop at `compile.ts:138-141` pushes `rc.component.content` in returned-array order verbatim — no re-sort, no re-filter on `context.condition`, no version-pin re-resolution. Upstream `composition-store.ts:243-297` is the sole owner of the `(position ASC, version DESC, slug ASC)` total order, the `context_condition` inclusion filter, the `REQUIRED_COMPONENT_EXCLUDED` error, and the version-pin rule. The e2e suite proves the *outcome*: body in junction order (`compile-e2e.test.ts:253-290`), security criteria included/excluded by context (`:329-384`) — each with a documented negative-control. Ordering/filtering is delegated, not re-implemented. **Pure projection confirmed.**

### Check 3 — Per-platform header builder contract (Decision B) — PASS

`compile.ts:179` reads `headerFormat` via `getPlatformHeaderFormat` → `BindingStore.readPlatform(platform).headerFormat` (`compile.ts:105-115`), i.e. dispatch is on the `header_format` **column**, not a hard-coded platform name. The seed (`agent-tool-registry/src/seed/platforms.ts:22/28/46`) confirms the three values `yaml_frontmatter`/`json_object`/`none` map to claude_code / claude_api+openai+bedrock / cursor+vscode exactly as decided. Dispatch: `yaml_frontmatter` → `emitYamlFrontmatter` (`compile.ts:239`), `json_object` → `emitJsonObject` (`compile.ts:258`), else body-only (`compile.ts:316-331`). Markdown emitter starts with `---`, frozen field order name→description→tools→model, `tools:`/`model:` omitted when empty (`emit/markdown.ts:77-94`, proven `compile-e2e.test.ts:292-323`). JSON emitter is a `JSON.stringify` of `{name,systemPrompt,model,tools}` with a structured tool array (`emit/json.ts:84-122`, proven `compile-e2e.test.ts:541-625`). **Both decided contracts match; adding a same-format platform needs no compiler code.**

### Check 4 — composed_prompts cache key (Decision D / `[def:context-hash]`) — PARTIAL: mechanism correct, test-teeth gap (see BLOCKING-1)

The implemented key is correct: `computeContextHash` (`cache/composed-prompt-cache.ts:59-78`) reuses the upstream `contextHash` for the context part (`:65`, confirmed sorted-key-JSON + SHA-256 at `composed-prompt-store.ts:37-46` — NOT reimplemented), sorts `componentVersions` by slug and `JSON.stringify`s the `[k,value]` entries (`:68-71`), appends `platform` with a bare-space separator (`:76`). Lookup-before-assembly is honoured: `extractBodyParts` (cheap read) runs first to derive `componentVersions`, THEN `cacheL` runs BEFORE the resolve/emit assembly (`compile.ts:187-225`); on HIT the assembly steps 4-7 are bypassed. Reopen-proven: `compile-cache.test.ts:222-268` closes+reopens and asserts same `id`, identical content, row-count stays 1, and a `resolveComposition` spy shows assembly bypassed on HIT. Context-change miss (`:270-306`) and platform miss (`:312-318`) are proven with teeth. **However** the *headline* Decision D guarantee — an unpinned component advancing changes the body while the context is identical, therefore MUST miss — is not driven through `compileAgent`, and the `computeContextHash` unit tests assert version-*key* order-independence (`:329-336`) but never that different version *values* yield a different hash. See BLOCKING-1.

### Check 5 — No cross-package FK violations (Decision C §2) — PASS

`db/schema.ts` defines no compiler_ tables yet and contains no `.references()` call across prefixes (`:18-19` is the documenting comment). Cross-package reads are application-level joins on logical text keys (`agent_slug`) through the upstream stores; integrity is enforced in code (typed errors from the stores), not SQLite FKs. Confirmed no regression since `review-engine.md` Check 2. **Logical keys only, no cross-namespace FK.**

### Check 6 — CLAUDE.md conformance — PASS (one advisory)

- **Platform isolation:** `project.json:6` = `["layer:ai","platform:node"]`; grep for `react`/`window.`/`document.` in non-test source returns none. PASS.
- **`@adhd/` imports:** all cross-package imports use scoped paths (`@adhd/agent-registry`, `-tool-registry`, `-provider`, `-policy`); intra-package uses `./*.js`; no `../../` cross-package relatives. PASS.
- **JSDoc on public fns:** `compileAgent`, `resolveBody`, `resolveTools`, `resolveModel`, `resolvePolicyConstraints`, `computeContextHash`, `lookup`, `write`, `emitYamlFrontmatter`, `emitJsonObject`, `seedFixtureAgent` all carry complete JSDoc blocks. PASS.
- **Verification standard:** real on-disk SQLite everywhere (never `:memory:`); persistence proven by close+reopen (`compile-e2e.test.ts:200-201`, `compile-cache.test.ts:231-233`); the CLI test drives the REAL built bin as a child process and keys on its exit code (`compile-cli.test.ts:8-43`); negative controls documented and present for tools-alias leak, context filter, policy row-drive. The version-drift cache miss is the one DoD clause lacking a tooth (BLOCKING-1).
- **I-prefix:** ADVISORY (non-blocking, unchanged from `review-engine.md`): `layer:ai` package; the `I` rule is scoped to shared/data interfaces; consistent with sibling registry packages. Not a violation.

---

## Orchestration-flagged items

### (a) `resolveBody` vs `resolveComposition` — acceptable public surface; single source of ordering truth INTACT

Grep confirms `resolveBody` (`resolve/composition.ts:54`) is called ONLY by the barrel (`index.ts:11`) and `composition-resolve.test.ts` — it is NOT on the `compileAgent` path. `compileAgent` instead calls `resolveComposition` directly via `extractBodyParts` (`compile.ts:133`). So there are two callers of `resolveComposition` *inside the package* (`resolveBody` `composition.ts:62` joins `'\n'`; `extractBodyParts` `compile.ts:133` joins `'\n\n'`), but **both delegate ALL ordering/filtering/version-pin to `resolveComposition`** and differ only in the trivial concatenation separator. There is exactly ONE source of ordering truth (upstream `CompositionStore`), so the divergence risk is cosmetic (a separator), not a semantic precedence fork. Judgment: **acceptable.** `resolveBody` is a legitimate public-API convenience export. Minor non-blocking advisory: the two iterate-and-join loops are duplicated; a future tidy could have `extractBodyParts` reuse a shared section-extractor returning `string[]` so the separator is the only caller choice — but this carries no correctness risk today.

### (b) the `\n\n` emit-layer fix — confirmed; no second ordering/filter path introduced

The compiled claude_code artifact joins sections with `'\n\n'` (`emit/markdown.ts:118`) and the JSON `systemPrompt` likewise (`emit/json.ts:103`); the none-format path joins `'\n\n'` (`compile.ts:327`). This matches Decision B.1 and is proven by `compile-agent.test.ts:445` ("sections are separated by `\n\n`"). Handling the separator at the emit layer (compile.ts owning the join via `bodySections: string[]`) did NOT introduce a second ordering or filter path — `extractBodyParts` still delegates order+filter to `resolveComposition` and only concatenates. The mid-plan advisory (review-engine.md Advisory 1) is thereby discharged correctly. Judgment: **resolved as designed.**

---

## Findings

BLOCKING: Decision D's headline guarantee — an UNPINNED component advancing to a new latest version (context identical) MUST miss the cache and recompile fresh content — has no test with teeth. The cache-miss suite proves context-change and platform-change misses (`compile-cache.test.ts:270-306`, `:312-318`), and the `computeContextHash` unit tests prove version-KEY order-independence (`:329-336`), but NONE asserts that different version VALUES produce a different hash, and no test drives an actual component version bump through `compileAgent` to observe MISS + new row + changed content. Every existing assertion would stay GREEN even if `computeContextHash` hashed only the sorted version keys and dropped the values — the exact "implementation-shaped check stays green while the guarantee regresses" failure mode (CLAUDE.md verification std #2 + #6). Since folding `componentVersions` into the key is the ENTIRE rationale of Decision D ("context-only is insufficient — unpinned advance ⇒ miss"), this is the one named gate criterion (`composed_prompts cache keyed on the RIGHT context hash`) left unproven. REMEDIATION: add (1) a `computeContextHash` unit assertion that `(ctx,{c:1},p) ≠ (ctx,{c:2},p)`; and (2) an integration test in `compile-cache.test.ts` that compiles, bumps an unpinned component to a new version via `ComponentStore`, recompiles the SAME agent+context, and asserts a NEW row (count→2), a DIFFERENT `context_hash`, and CHANGED `content`. Prove the tooth by a negative control (hash only the version keys → the new assertion goes red). Route to the `composed-prompt-caching` implementation state, then re-review.

NON-BLOCKING (advisory): `resolveBody` (composition.ts) and `extractBodyParts` (compile.ts) duplicate the resolveComposition iterate-and-join loop with different separators. No correctness risk (both delegate ordering); optional future tidy to a shared `string[]` extractor.

NON-BLOCKING (advisory, carried from review-engine.md): the `db/schema.ts` placeholder/example comment should be removed when the first real compiler_ table is added; none exists yet.

---

VERDICT: NEEDS-WORK
