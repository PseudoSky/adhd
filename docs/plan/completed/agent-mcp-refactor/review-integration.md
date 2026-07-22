# review-integration.md — MID-PLAN review: agent-mcp integration/retire core

**Plan:** `agent-mcp-refactor` (Plan 6 of 7) · **State:** `code-review-integration` (wave 5)
**Reviewer:** architect-reviewer (opus) · **Date:** 2026-06-26
**Diff under review:** `git diff agent-mcp-baseline-pre-registry..HEAD -- packages/ai/agent-mcp packages/ai/agent-mcp-types tsconfig.base.json`
**Reviewed against:** project `CLAUDE.md` ("Proving features actually work"), `decisions.md` (Decisions 1–4), `contexts/_shared.md` (invariants + caller map), and the per-state Delta specs (`compiler-integration`, `agent-store-retire`, `policy-engine-bridge`).

---

## Evidence gathered (tool-grounded)

- **Full unit suite:** `npx --yes nx test agent-mcp` → **exit 0** (27 files passed, 3 skipped; 237 tests passed, 4 skipped). Cache-served; the project's CLAUDE.md cache-trust policy makes this valid evidence.
- **Build:** `npx --yes nx build agent-mcp` → **exit 0** (clean TypeScript compile).
- **Compiler baseline present:** `@adhd/agent-compiler` exists with a real `compileAgent` (`packages/ai/agent-compiler/src/compile.ts:170`, re-exported `index.ts:28`); declared in `packages/ai/agent-mcp/package.json:30` and `tsconfig.base.json:29`. `[inv:compiler-is-baseline]` satisfied.
- Files read in full: `engine/prompt-resolver.ts`, `store/composed-prompt-store.ts`, `db/schema.ts`, `engine/policy.ts` (+ baseline diff), `providers/claudecli.ts`, `store/session-store.ts`, `store/agent-store.ts`, `tools/session.ts`, `tools/task.ts` (reader sites), `validation/agent.ts`, `index.ts`, `server.ts` (agentTool call sites), `agent-mcp-types/src/domain.ts` (diff), `__tests__/compiler-resolve.test.ts`, `__tests__/policy-tool-reconcile.test.ts`, `BACKLOG.md` (diff).

---

## What is CORRECT (the integration core holds)

1. **Cache key identity — CORRECT.** `computeContextHash(agentSlug, platform, context)` (`prompt-resolver.ts:79`) is the single derivation used for BOTH the lookup (`findByAgentContext`, `prompt-resolver.ts:118`) and the write (`upsert` keyed on the same `contextHash`, `composed-prompt-store.ts:25–49`). Context keys are sorted before serialisation (`prompt-resolver.ts:84`), so insertion order cannot fork the hash. HIT returns `{content, id}` and does NOT call `compileAgentFn` (`prompt-resolver.ts:119–125`); MISS compiles + upserts (`:130–149`). The cache neither always-hits nor always-misses. The DB-level `uniqueIndex("idx_composed_prompts_agent_ctx")` (`schema.ts:147`) backs the key. **Decision 2 satisfied.**

2. **systemPrompt compat-shim — CORRECT (computed, never authored).** `domain.ts` resigns `systemPrompt: string` → `systemPrompt?: string` with a compat-shim doc; `validation/agent.ts:115` and the patch schema `:147` are `z.optional(z.string())`. `agentTool` populates it ONLY from `resolveComposedPrompt().content` (`tools/session.ts:83,89–91`); it is never written from user authoring elsewhere. **Decision 3 satisfied** at the type/schema/seam level.

3. **No competing source of truth in the retire — CORRECT.** `AgentStore` is the documented thin cache (`agent-store.ts:13–25`); CRUD surface retained for non-regression; no second writable agent store exists. `composed_prompts` is the only new authoritative cache and it is agent-mcp-owned. **Decision 1 satisfied.**

4. **FK topology — CORRECT.** `sessions.composed_prompt_id` is a nullable additive column (`schema.ts:44`), backward-compatible for legacy rows. No cross-package FK (the runtime sink references only agent-mcp tables). `experiment_assignments.session_id` → `sessions.id` cascade is intra-package. No cross-package FK violation found.

5. **PolicyEngine template reading — CORRECT and defensively clamped.** `check()` resolves limits per-agent → template → server-default; `Math.min(template, serverMax)` (`policy.ts:136–138,157–159`) means a template can only TIGHTEN, never loosen, the server cap. Per-agent `allowedAgents` overrides templates; permission allowlist read only when `mode==="allowlist"` (`policy.ts:96–107`). Backward-compat fallback preserved when `policyTemplateRules` absent. The recursion-depth check's use of `callingAgent.maxToolLoops` is PRE-EXISTING baseline behaviour (confirmed via baseline diff), not introduced here. **Decision 4 (policy half) satisfied; tests have real teeth** (depth-3-blocked-at-template-3-when-server-10 with explicit negative-control reasoning, `policy-tool-reconcile.test.ts:49–204`).

6. **claudecli derivation logic — CORRECT.** `chat()` derives the disallowed built-in set from `compiledTools` when supplied, else `config.allowedBuiltinTools` (`claudecli.ts:302–307`); `compiledTools` is a constructor param sourced from the AGENT_TOOL model. The LOGIC honours `[inv:no-third-tool-model]`. (Test-teeth weakness on this path is BLOCKING-1 below.)

7. **Back-out integrity — CLEAN.** All changes are within `agent-mcp{,-types}` + `tsconfig.base.json`, additive/reversible vs the baseline tag (new columns nullable, type field widened to optional, new tables/stores/tests added). Implementers disclosed `DEBT-006` (stale `server.ts` USAGE_GUIDE doc text) in `BACKLOG.md`, matching `decisions.md`'s explicit exclusion of `server.ts` doc strings. Good disclosure hygiene.

---

## Findings

BLOCKING: [RESOLVED] [policy-engine-bridge.3] (resolved on re-review — commit `338cc02`; see RE-REVIEW › B1: production `chat()` now calls the exported `computeClaudeBuiltinArgs` seam and `policy-tool-reconcile.test.ts` drives that REAL seam with a verified negative control) The "no competing third tool-permission model" DoD clause is backed by PROXY EVIDENCE, not a test with teeth on the production path. The only test touching `ClaudeCliProvider` (`__tests__/policy-tool-reconcile.test.ts:306–396`) defines an `InspectableClaudeCliProvider` subclass whose `getEffectiveAllowedBuiltins()` / `getDisallowedBuiltins()` REIMPLEMENT the `compiledTools !== undefined ? compiledTools : (config.allowedBuiltinTools ?? [])` ternary verbatim (`:314–318`, `:363–367`) rather than exercising the real derivation in `claudecli.ts:302–307`. The first reconciliation test (`:265–304`) asserts only `toBeInstanceOf` — no behavioral assertion. Consequence: if the real derivation in `chat()` regressed (e.g. flipped to honour `config.allowedBuiltinTools` over `compiledTools`), every test stays GREEN. Per CLAUDE.md verification #2 ("a behavioral test must FAIL if the bug is reintroduced") and #6 ("assert the consumer-visible outcome, not the implementation shape"), this clause is not actually proven. FIX (owned by `policy-engine-bridge`): refactor the disallowed-list computation out of `chat()` into a testable pure function (or accept a `dryRun`/`buildArgs` seam) and assert the REAL `--disallowedTools` argv it produces for `compiledTools=["Read","Grep"]` vs `allowedBuiltinTools=["Bash"]`. No subclass-reimplementation.

BLOCKING: [RESOLVED] [compiler-integration.2 / inv:real-session-start] (resolved on re-review — commit `338cc02`; see RE-REVIEW › B2: `compiler-resolve.test.ts:350–466` now drives the REAL `agentTool({…},{promptResolver})` with reopen-proves-persistence and a verified negative control) The production session-start seam (`agentTool`'s `if (deps.promptResolver)` gate + compat-shim snapshot population, `tools/session.ts:74–91`) has ZERO test coverage. `compiler-resolve.test.ts`'s "session start" cases (`:213–303`) do NOT call `agentTool`; they re-implement the resolve→`sessionStore.create` sequence inline (`:235–246`, `:281–292`). No test in the suite passes a `promptResolver` to `agentTool` (`grep promptResolver __tests__/` → 0 hits). Consequence: deleting the entire `if (deps.promptResolver) { … }` block from `agentTool` leaves the suite GREEN — the integration's own claim that "the snapshot's `systemPrompt` is the resolved compiler content" is unproven through the real tool. This is the gate's required scrutiny point #2 ("confirm no reader silently broke … systemPrompt is a COMPUTED compat shim"): in SESSION mode `tools/task.ts` reads the snapshot, and the snapshot is only compiler-populated when `agentTool` runs the resolver — which no test exercises. FIX: this is precisely what `session-e2e` is chartered to close (`[inv:real-session-start]`: drive the REAL `agent` tool with a real prompt-resolver, LLM boundary only mocked). It must call `agentTool({...}, { …, promptResolver })` — NOT re-implement the sequence inline — and the negative control (`session-e2e.3`) must break the resolver call and confirm the e2e flips RED. Recording here so `audit-integration` does not green the integration phase on the current proxy coverage.

---

## Notes (non-blocking, for awareness — do NOT gate on these)

- **Production wiring is intentionally deferred (transition window) — NOT a finding.** `index.ts` (`:112–122`) and `server.ts` (`:485–489`, `:658–665`) construct `SessionDeps`/`PolicyEngine` WITHOUT `promptResolver` / `policyTemplateRules` / `compiledTools`. Per `decisions.md` and every context's "legacy / transition-window path" framing, the live MCP server running without the compiler is the intended posture for this plan; `promptResolver` is `optional` by design. The plan never commits to wiring the live `agent` tool to the compiler. Flagged only so a later integration/wiring plan (or a follow-up DoD) does not assume the shipped server resolves prompts today. If the team intends the shipped server to resolve in this plan, that is a SCOPE escalation for the team-lead, not a defect against the recorded contract.
- `DEBT-006` (server.ts USAGE_GUIDE shows `systemPrompt` as required) is correctly disclosed and out of this plan's mutate scope. Fine as backlog.

---

## Verdict

Both blocking findings are about **test teeth / proof**, not core correctness — the integration core (cache key identity, compat-shim, retire safety, FK topology, policy template clamp, claudecli derivation logic) is sound. But this project's standard is explicit: a DoD clause backed by a test that stays green when the code is broken is **not** proven, and "Never mark a task complete on proxy evidence." `[policy-engine-bridge.3]` is backed by a reimplementation, and the `agentTool` resolver gate has no coverage at all. Default posture for this gate is NEEDS-WORK and neither blocker is resolvable by the reviewer — they require the owning states to add real-path tests. Routing: BLOCKING-1 → `policy-engine-bridge`; BLOCKING-2 → satisfied by `session-e2e` driving `agentTool` (confirm it does, and runs its negative control), then re-review.

VERDICT (initial pass, 2026-06-26): NEEDS-WORK

---

## RE-REVIEW (2026-06-26 — wave 5, after fixes)

**Re-diff:** `git diff agent-mcp-baseline-pre-registry..HEAD -- packages/ai/agent-mcp packages/ai/agent-mcp-types tsconfig.base.json docs/plan/agent-mcp-refactor/decisions.md`
**Evidence:** `npx --yes nx test agent-mcp` → **exit 0** (29 files passed, 3 skipped; **248 passed**, 4 skipped). `npx --yes nx build agent-mcp` → **exit 0** (clean TS compile). Both cache-served — valid under the project cache-trust policy.

### B1 `[policy-engine-bridge.3]` — RESOLVED (real teeth on production path)

The ternary is now an exported pure seam `computeClaudeBuiltinArgs(...)` (`providers/claudecli.ts:196–214`). The production `chat()` calls it directly (`claudecli.ts:335–338`) — single source of truth, no divergence. `policy-tool-reconcile.test.ts` imports the REAL seam (`:19`) and drives it: `compiledTools=["Read","Grep"]` vs `allowedBuiltinTools=["Bash"]` asserts `effectiveAllowed===["Read","Grep"]` and `"Bash" ∈ disallowedArgv` (`:250–263`); a second case asserts every non-compiled builtin is disallowed (`:271–291`); a fallback case proves `compiledTools=undefined` honours `allowedBuiltinTools` (`:293–304`). **Teeth confirmed by reasoning:** if the priority flipped to honour `allowedBuiltinTools` over `compiledTools`, line `:256`/`:279`/`:261` go RED. The prior subclass-reimplementation is gone. Commit `338cc02`.

### B2 `[compiler-integration.2 / inv:real-session-start]` — RESOLVED (drives REAL agentTool, reopen-proves-persistence)

`compiler-resolve.test.ts:350–466` now drives the REAL `agentTool({name},{…,promptResolver})` (`:384`) against a real on-disk SQLite DB with real `AgentStore`/`SessionStore`/`ComposedPromptStore`/`PolicyEngine` — only `compileAgentFn` is stubbed (the compiler boundary). It CLOSES + REOPENS the DB (`:388–389`) before asserting `snapshot.systemPrompt===COMPILED_CONTENT` (`:396`) and `composed_prompt_id` non-null on the raw row (`:407–409`). **Teeth confirmed by negative control** (`:414–466`): with no `promptResolver`, `composed_prompt_id` is NULL and `systemPrompt` is the original authored value — so deleting the `if (deps.promptResolver)` block in `tools/session.ts:74–91` makes the positive test RED. Commit `338cc02`.

### F-P6-8 (owner-added live wiring) — VERIFIED, backward compat preserved

`index.ts:195–198` builds `promptResolver` (gated on `AGENT_MCP_REGISTRY_DB_PATH`) and passes it to `startServer` (`:213`); `server.ts:499` + `:678` forward it to BOTH `agentTool` callsites (in-process handler + `CallToolRequestSchema` dispatcher). The transition-window NOTE in the initial pass ("production wiring intentionally deferred") is now correctly superseded — `decisions.md` Decision 5 records the explicit owner-call reversal of the deferral. **Backward compat proven with teeth:** `live-wiring.test.ts:296–355` (`[F-P6-8.flat-fallback]`) wires a REAL `promptResolver` (real `compileAgent`) yet a flat-only agent still resolves to its stored `systemPrompt` with `composed_prompt_id=NULL` — because `resolveComposedPrompt` returns `null` when `compileAgent` throws `AGENT_NOT_FOUND` (`prompt-resolver.ts:146–155`) and `agentTool` falls back (`session.ts:87–97`). The full 248-test suite green (default `AGENT_MCP_REGISTRY_DB_PATH` absent ⇒ `promptResolver=undefined` ⇒ server runs exactly as before) is the non-regression proof. Commit `0e600b1`.

### F-P6-8b (composition-root factory) — VERIFIED (genuinely covered, real teeth)

`buildPromptResolver(...)` is extracted to `index.ts:80–101` and is the same factory `main()` calls (`:195`). `index-wiring.test.ts` imports the REAL export (`:68`) and: (a) `[factory-no-path]` asserts `undefined` for absent/`undefined`/empty-string path (`:195–210`); (b) `[factory-with-path]` asserts a wired `PromptResolverDeps` with the real `compileAgentFn` (`:218–232`); (c) `[end-to-end-wiring]` passes the factory output into the REAL `agentTool` against a real seeded registry DB using the REAL `compileAgent`, reopens the DB, and asserts the compiled anchor in the snapshot + non-null `composed_prompt_id` (`:252–303`); (d) `[negative-control]` proves without a resolver the compiled anchor is ABSENT (`:321–362`). This closes the composition-root gap (the prior "deleting the wiring block leaves the suite green" hole). Commit `c8aa396`.

### Regression scan

Diff scope is confined to `agent-mcp{,-types}` + `tsconfig.base.json` + `decisions.md`. `domain.ts` `systemPrompt?:` compat-shim is unchanged from the initial-pass CORRECT finding (still computed, never authored). Only new backlog entry is the previously-disclosed `DEBT-006` (out-of-scope `server.ts` USAGE_GUIDE doc text) — no new blocking debt. Build clean, 248/252 tests pass (4 pre-existing skips). Nothing new regressed.

### Re-review verdict

B1 and B2 are now proven by tests with real teeth ON THE PRODUCTION PATH (each has a verified negative control that flips the owning test RED when the seam is broken). The owner-added live wiring (F-P6-8) is in place with backward compatibility proven, and the composition-root factory (F-P6-8b) is genuinely covered. Both prior blockers are fully resolved; no new blocking findings. This gate is APPROVED.

VERDICT: APPROVED
