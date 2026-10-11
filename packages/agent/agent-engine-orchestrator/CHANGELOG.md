## 2.3.13 (2026-10-11)

### 🚀 Features

- **agent-engine-orchestrator:** persist budget:unpriced_model and provider:builtin_bypass as typed task events (20772a0b AC1 AC2 AC3 AC4) ([a6b1150b](https://github.com/PseudoSky/adhd/commit/a6b1150b))
- **agent-engine-orchestrator:** disclose claudecli built-in bypass of engine tool pipeline (e0d71436 AC1 AC2 AC3) ([bb5bc7e4](https://github.com/PseudoSky/adhd/commit/bb5bc7e4))

### 🩹 Fixes

- **agent-engine-orchestrator:** limiter keeps its slot across abort, spec-mode bypass honors the gate, bypass emit is awaited (cf7e0e5c review-4 review-5 review-6) ([4b0c0734](https://github.com/PseudoSky/adhd/commit/4b0c0734))
- **agent-engine-orchestrator:** drop queued bridge calls on cancel, margin sampled cache-guard counts, real-task D6 + HITL limiter tests (ea8f6f92 B2 review M1-M4) ([a3ff1f81](https://github.com/PseudoSky/adhd/commit/a3ff1f81))
- **agent-engine-orchestrator:** parse block-style spec tools, disclose bypass once per task, host-wiring test seam (e0d71436 review-M1 M2, 20772a0b review-M1 M2 L3 L4) ([e14b93a4](https://github.com/PseudoSky/adhd/commit/e14b93a4))
- **agent-engine-orchestrator:** share one per-task tool limiter with the claudecli bridge and bound the cache-guard tokenizer (ea8f6f92 AC1 AC2 AC3 AC4 AC5) ([488a52cc](https://github.com/PseudoSky/adhd/commit/488a52cc))

### ❤️ Thank You

- pseudosky

## 2.3.12 (2026-10-11)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## Unreleased

### 🩹 Fixes

- **agent-engine-orchestrator:** a one-shot (ephemeral `agent_name`) task now builds its provider with `sessionResumable:false` (via `buildProviderForSelection`), so claudecli retains no session transcript for it; session-bound tasks are unchanged. (ad988fda AC6, 95ee2a24 AC4)
- **agent-engine-orchestrator:** claudecli readOnlyHint applies only to agent-mcp's own bridge route (a foreign server's `task` is no longer hinted); session ids are UUID-validated before they enter the transcript delete set; the resume key covers bridged tool names/descriptions/schemas, `--setting-sources`, permission mode and the gate-filtered built-in tools; orphan transcripts of dead processes are swept on provider start via per-process ledgers, SIGTERM/SIGINT release retained transcripts, never-resumed sessions are evicted first and `sessionResumable:false` retains nothing; the claude-version e2e pin is one explicit tripwire instead of a lane-wide failure (95ee2a24 AC1 AC2 AC3 AC4 AC5)

### 🚀 Features

- **agent-engine-orchestrator:** claudecli retains the CLI session per engine session and resumes it (`--resume --fork-session`, uncovered tail only) for follow-up tasks: second-task 1h cache write 6,312 -> 121 tokens, first-turn cache_read/context 0.00 -> 0.98 on claude-haiku-4-5; any history the transcript does not provably cover falls back to the text replay (b31e1fe5)

### 🩹 Fixes

- **agent-engine-orchestrator:** `usage_query` no longer fails with "too many SQL variables" for a scope with thousands of tasks: the task, session and turn grains bind task ids in chunks of 500 per `IN (...)`. New tests: a 33,000-task scope at all three grains (with a negative control), `mergeProviderUsage` handling every `TokenUsage` field (a new field fails typecheck until classified), and an unmeasured-only task recording `stop_reason: "error"`. The `est_cost_usd` snake_case naming in the usage summary is documented as deliberate. (b3999dfa AC2 AC3 AC8 AC9)

## 2.3.11 (2026-10-10)

### 🚀 Features

- **agent-engine-orchestrator:** claudecli and anthropic classify 429/529/usage-window faults, retry transient ones with Retry-After backoff, fail fast on quota windows, share a per-credential limiter (de6bee5d 9ed453c1 FLT-AC1..AC6) ([3fac822e](https://github.com/PseudoSky/adhd/commit/3fac822e))

### 🩹 Fixes

- **agent-engine-orchestrator:** engine preserves typed provider failures (de6bee5d FLT-AC1) ([4b6f0c11](https://github.com/PseudoSky/adhd/commit/4b6f0c11))

### ❤️ Thank You

- pseudosky

## 2.3.10 (2026-10-10)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.3.9 (2026-10-10)

### 🚀 Features

- **agent-mcp:** optional spill-to-file for oversize tool results, read-allowed in the srt sandbox only when enabled (3ad735bb BK9, plan 9ed453c1) ([c599fe1f](https://github.com/PseudoSky/adhd/commit/c599fe1f))
- **agent-engine-orchestrator:** resolve claudecli model aliases and price per resolved model (79aebb26 BK8) ([145fdfc9](https://github.com/PseudoSky/adhd/commit/145fdfc9))
- **agent-engine-orchestrator:** cache_control breakpoints on the anthropic provider with per-breakpoint min-prefix guard (ae62e6b0 BK3) ([a825a0c3](https://github.com/PseudoSky/adhd/commit/a825a0c3))
- **agent-engine-orchestrator:** cap model-visible tool results with head+tail truncation (3ad735bb) ([c328b3ff](https://github.com/PseudoSky/adhd/commit/c328b3ff))
- **agent-engine-orchestrator:** route provider and MCP-client egress through EngineConfig.wire; hooks on task providers; agent-mcp WireSeams (c536ce29 TRC-AC2 AC3 AC5 AC6 P1-AC-A) ([4fd865e7](https://github.com/PseudoSky/adhd/commit/4fd865e7))
- **agent-engine-orchestrator:** provider failure hooks decorator, compaction purpose tag; agent-plugin-tracing model_call.error and provider/budget mappings (c536ce29 TRC-AC25 AC26 W4-AC-A) ([aeec6242](https://github.com/PseudoSky/adhd/commit/aeec6242))
- **agent-mcp:** traced fetch/spawn/MCP-transport wire wrappers and EngineConfig.wire seams (c536ce29 TRC-AC2 AC3 AC4 AC5w AC6w AC9) ([5790a393](https://github.com/PseudoSky/adhd/commit/5790a393))
- **agent-engine-orchestrator:** usage_query read path — response_model grouping, unpriced counts, price age, provenance fields (37f6c511) ([0d59e617](https://github.com/PseudoSky/adhd/commit/0d59e617))
- **agent-engine-orchestrator:** usage plugin records price provenance per turn via as-of price source (37f6c511) ([1cb6a4a9](https://github.com/PseudoSky/adhd/commit/1cb6a4a9))
- **agent-engine-orchestrator:** capture provider response model; build usage test fixtures from real migrations (1f1c8598) ([cfc9d936](https://github.com/PseudoSky/adhd/commit/cfc9d936))
- **agent-core-provider:** wire OpenRouter pricing.json snapshot into estimateCostUsd (37f6c511) ([4f1e4427](https://github.com/PseudoSky/adhd/commit/4f1e4427))
- **nx-build:** release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069) ([35bbcbf0](https://github.com/PseudoSky/adhd/commit/35bbcbf0))
- **agent-engine-orchestrator:** ask escalation climbs transitively to the nearest interactive ancestor, root-terminal deny (fc466f0b) ([6bd3e4f6](https://github.com/PseudoSky/adhd/commit/6bd3e4f6))
- **agent-engine-orchestrator:** emit permission:decision, hitl:suspend, hitl:resume, session:closed (f376e27a TRACE-2) ([9f2e7dc5](https://github.com/PseudoSky/adhd/commit/9f2e7dc5))
- **agent-engine-orchestrator:** un-weld agent from provider; resolveSelection chain + session-held binding + fail-closed NO_PROVIDER_SELECTED (5ad2cf37 D-G(2)) ([b5f3f6d8](https://github.com/PseudoSky/adhd/commit/b5f3f6d8))
- **agent:** pass the adopted shell server's ALLOW_PATTERNS through ([f74e9b05](https://github.com/PseudoSky/adhd/commit/f74e9b05))
- **agent-mcp,agent-core-native-tooling:** portable multi-root fs + caller-supplied cwd + global allowed-root map (ADR-0008 D4/D7/D8) ([99f43c07](https://github.com/PseudoSky/adhd/commit/99f43c07))
- **agent-engine-orchestrator:** enforce the resolved native-tooling permission gate (NAT-TOOL-6) ([0103dc2f](https://github.com/PseudoSky/adhd/commit/0103dc2f))
- **agent-engine-orchestrator:** thread cwd + subprocessEnv into MCP clients (ADR-0008 D9 / NAT-TOOL-3) ([919d6e86](https://github.com/PseudoSky/adhd/commit/919d6e86))
- **agent-base-types:** nativeTooling typed config + stdio cwd (ADR-0008 NAT-TOOL-1) ([a2840f17](https://github.com/PseudoSky/adhd/commit/a2840f17))
- **agent-engine-orchestrator,agent-mcp:** gate agent systemPrompt behind explicit opt-in ([4a6ae079](https://github.com/PseudoSky/adhd/commit/4a6ae079))
- **agent-engine-orchestrator:** provider-native web_search/web_fetch in the default toolset (1abd2d84) ([e95bc2df](https://github.com/PseudoSky/adhd/commit/e95bc2df))
- **agent-engine-orchestrator:** native tasks_batch bulk/parallel dispatch primitive (05cc1db4) ([182d741c](https://github.com/PseudoSky/adhd/commit/182d741c))
- **agent-engine-orchestrator,agent-mcp:** add agent_verify_mcp handshake check ([88171d7c](https://github.com/PseudoSky/adhd/commit/88171d7c))
- **agent-engine-orchestrator,agent-mcp:** surface open sessions on agent_update ([492092a2](https://github.com/PseudoSky/adhd/commit/492092a2))
- **agent-engine-orchestrator:** bound and filter task_list/result output ([d237241f](https://github.com/PseudoSky/adhd/commit/d237241f))
- **agent-mcp:** load budget plugin by default with conservative cap (5339c2e5) ([3ccb0e86](https://github.com/PseudoSky/adhd/commit/3ccb0e86))
- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([b2022986](https://github.com/PseudoSky/adhd/commit/b2022986))
- **agent-plugin-budget:** rename tokens cap to context with peak semantics + contextWindowFraction (Packet B, BUG-AGENTMCP-009) ([0ec6c3f2](https://github.com/PseudoSky/adhd/commit/0ec6c3f2))
- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2) ([b777b50b](https://github.com/PseudoSky/adhd/commit/b777b50b))
- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes ([91621210](https://github.com/PseudoSky/adhd/commit/91621210))

### 🩹 Fixes

- **agent-engine-orchestrator:** bridged claudecli calls get events, coercion and a per-call timeout; fail redispatch on a missing cwd; skip home file in store-path warning (9ed453c1 BLIND F4 F6 F8 F9) ([7adb975e](https://github.com/PseudoSky/adhd/commit/7adb975e))
- **agent-engine-orchestrator:** spill ownership markers, collision-free names, last-spill retention, cap-bounded stub (9ed453c1 BLIND F1/F2/F3/F5) ([a4fa25a3](https://github.com/PseudoSky/adhd/commit/a4fa25a3))
- **agent-engine-orchestrator:** canonicalize server-rendered allow-lists so the tools block is byte-stable and the prompt cache hits (9ed453c1 CACHE) ([c8d1f08c](https://github.com/PseudoSky/adhd/commit/c8d1f08c))
- **agent-engine-orchestrator:** do not bridge engine builtin__ pseudo-tools under claudecli (9ed453c1 BRIDGE) ([f25e369b](https://github.com/PseudoSky/adhd/commit/f25e369b))
- **agent-engine-orchestrator:** claudecli executes each MCP tool exactly once via a loopback MCP bridge (9ed453c1 BRIDGE) ([03243874](https://github.com/PseudoSky/adhd/commit/03243874))
- **agent-engine-orchestrator:** spawn claudecli in the task dispatching cwd and persist it for redispatch (9ed453c1 CWD) ([d479f8c8](https://github.com/PseudoSky/adhd/commit/d479f8c8))
- **agent-plugin-budget:** warn mode never alters a call; opt-in soft-block; windowed input/output caps sum their own direction (9ed453c1 BUDGET-B1) ([88c840ca](https://github.com/PseudoSky/adhd/commit/88c840ca))
- **agent-mcp:** allowlist the srt spill read dir; give e2e/unit hooks explicit budgets (9ed453c1 HARD-H1/H2/H3) ([4cff3032](https://github.com/PseudoSky/adhd/commit/4cff3032))
- **agent-engine-orchestrator:** claudecli no longer SIGTERMs a child that is exiting on its own; bounded grace then SIGTERM/SIGKILL (322a1efb) ([d7aa3521](https://github.com/PseudoSky/adhd/commit/d7aa3521))
- **agent-mcp:** e2e lane builds default plugins; loud prerequisite check; default-plugin load failures surface to stderr + ops (c536ce29 E2E-PREREQ, 9ed453c1) ([41171795](https://github.com/PseudoSky/adhd/commit/41171795))
- **agent-engine-orchestrator:** compaction uses true per-response context; peak_context_at is the real call index (7ead5eaa AC4.5, AC4.6) ([2c2eef51](https://github.com/PseudoSky/adhd/commit/2c2eef51))
- **agent-engine-orchestrator:** claudecli reports true per-turn peak context; turn grain re-prices multi-model responses (7ead5eaa BK4) ([47598da4](https://github.com/PseudoSky/adhd/commit/47598da4))
- **agent-engine-orchestrator:** coerce stringified array/object tool arguments per declared schema (114e014c) ([36e7160d](https://github.com/PseudoSky/adhd/commit/36e7160d))
- **agent-mcp:** blind-review findings M1-M3, L1-L10 on the tracing delta (c536ce29) ([0f88a9c5](https://github.com/PseudoSky/adhd/commit/0f88a9c5))
- **agent-core-provider:** price cache writes by TTL tier so 1h writes use the 1h rate (b726a987) ([684c60ca](https://github.com/PseudoSky/adhd/commit/684c60ca))
- **agent-mcp:** host injects namespaced tempDir, claudecli drops os.tmpdir fallback, stop/shutdown pair, component on every ops record (c536ce29 S8B-AC1 F1-AC-A F1-AC-B F1-AC-C TRC-AC18, 03be90c3) ([ecfdf523](https://github.com/PseudoSky/adhd/commit/ecfdf523))
- **agent-mcp:** route tail DB path, srt run-policy and claudecli scratch through the namespaced environment roots (c536ce29 S8B-AC1 S8B-AC2, 03be90c3) ([d671a613](https://github.com/PseudoSky/adhd/commit/d671a613))
- **agent-engine-orchestrator:** exclude __tests__ from lib tsconfig so test fixtures stay out of dist (release-blocker orch-publish-hygiene) ([d0c78587](https://github.com/PseudoSky/adhd/commit/d0c78587))
- **agent-engine-orchestrator): sticky-NULL est_cost_usd once any turn is unpriced (37f6c511, 1f1c8598); refactor(agent-core-provider:** single perMillion conversion, correct alias JSDoc ([f2ab99fc](https://github.com/PseudoSky/adhd/commit/f2ab99fc))
- **agent-plugin-budget:** policy denials are not errors (df7c3af9 AC1-AC3) ([293dce21](https://github.com/PseudoSky/adhd/commit/293dce21))
- **agent-engine-orchestrator:** claudecli worker isolation - strict empty MCP config, --tools allowlist, no session persistence, no spurious built-in tool_result, lean CLAUDE.md/memory env ([3b782983](https://github.com/PseudoSky/adhd/commit/3b782983))
- **agent-engine-orchestrator:** claudecli reports CLI-internal tool uses and num_turns for usage accounting (98f9da19) ([f30285b2](https://github.com/PseudoSky/adhd/commit/f30285b2))
- **agent-engine-orchestrator:** agent_create/agent_update input accepts legacy apiKeyEnv/authTokenEnv (mapped to env.secret); document PF-1 provider fields and strict input in agent-mcp (2eddcf91, 3864449b) ([3848205c](https://github.com/PseudoSky/adhd/commit/3848205c))
- **agent-engine-orchestrator:** provider schema accepts PF-1 fields, strict provider/patch schemas, patch includes toolAdvertisement (a388103a, 96fd2773) ([49b8d3f0](https://github.com/PseudoSky/adhd/commit/49b8d3f0))
- **agent-engine-orchestrator:** reconstruct rootTaskId/callingAgentName on re-dispatch (0d77376f) ([90df4a43](https://github.com/PseudoSky/adhd/commit/90df4a43))
- **agent-engine-orchestrator:** named fail-fast connectTimeoutMs, no doubled reconnect after listAllTools (c9f0a791) ([78104bf3](https://github.com/PseudoSky/adhd/commit/78104bf3))
- **agent-store-runtime:** getSelection fails loudly on an unmigrated sessions table (aafd6561 e) ([423350ea](https://github.com/PseudoSky/adhd/commit/423350ea))
- **agent-engine-orchestrator:** stop caller-cwd test 4 spawning a real npx MCP server ([9bcfa290](https://github.com/PseudoSky/adhd/commit/9bcfa290))
- **agent-engine-orchestrator:** validate shell.root as a portable hint; reject comma allowPatterns ([ec469516](https://github.com/PseudoSky/adhd/commit/ec469516))
- **agent-engine-orchestrator:** approved suspend executes; escalate always restores parent ([f7a640a5](https://github.com/PseudoSky/adhd/commit/f7a640a5))
- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-engine-orchestrator:** route an escalated ask to the parent task (a0c0a826) ([85fa0dba](https://github.com/PseudoSky/adhd/commit/85fa0dba))
- **agent-engine-orchestrator:** require explicit approval for a permission ask (FIX 5) ([890076cb](https://github.com/PseudoSky/adhd/commit/890076cb))
- **agent-engine-orchestrator:** unify HITL gate on effectiveHitl; fail synchronous asks closed ([17f6dfb7](https://github.com/PseudoSky/adhd/commit/17f6dfb7))
- **agent-mcp,agent-store-runtime:** collapse duplicate vite plugins keys; sweep all configs (50b77657) ([f2e8ceba](https://github.com/PseudoSky/adhd/commit/f2e8ceba))
- **agent-mcp:** resolve default budget plugin from agent-mcp's own module base (cc636860) ([dd0ed875](https://github.com/PseudoSky/adhd/commit/dd0ed875))
- **agent-engine-orchestrator:** collapse duplicate vite plugins key (50b77657) ([6b6458d2](https://github.com/PseudoSky/adhd/commit/6b6458d2))
- **agent-engine-orchestrator:** compile the spec corpus with a typecheck-spec ratchet ([4c254146](https://github.com/PseudoSky/adhd/commit/4c254146))
- **agent-engine-orchestrator:** enforce task depends_on gating before dispatch (ac115447) ([2f5a556a](https://github.com/PseudoSky/adhd/commit/2f5a556a))
- **agent-engine-orchestrator:** resolve the default budget plugin from the engine (dfb03557) ([976e4a2a](https://github.com/PseudoSky/adhd/commit/976e4a2a))
- **agent-engine-orchestrator:** type projected taskList/resultTool as ProjectedTask ([6ee04cea](https://github.com/PseudoSky/adhd/commit/6ee04cea))
- **agent-engine-orchestrator,agent-mcp:** wire full/fields opt-in into agent_update response ([d0d26495](https://github.com/PseudoSky/adhd/commit/d0d26495))
- **agent-engine-orchestrator:** tri-state status for agent_verify_mcp results ([30b04c74](https://github.com/PseudoSky/adhd/commit/30b04c74))
- **agent-engine-orchestrator:** route provider SDK client timeout through the raised default (36a73117) ([f6213b58](https://github.com/PseudoSky/adhd/commit/f6213b58))
- **dispatch-orchestrator:** surface agent-mcp policy violations through dispatch_log (4e829a08) ([b6884f67](https://github.com/PseudoSky/adhd/commit/b6884f67))
- **agent-engine-orchestrator:** raise default provider timeout 60s->300s (36a73117) ([08544fae](https://github.com/PseudoSky/adhd/commit/08544fae))
- **agent-engine-orchestrator:** clamp claudecli env bleed + group-aware teardown (322a1efb) ([37ce3c0d](https://github.com/PseudoSky/adhd/commit/37ce3c0d))
- **agent-engine-orchestrator,agent-mcp:** add delete/rename semantics to mcpServers patch ([37ce3650](https://github.com/PseudoSky/adhd/commit/37ce3650))
- **vite:** restore import.meta.url in CJS output under vite 8 ([9690844d](https://github.com/PseudoSky/adhd/commit/9690844d))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([4ccdb53e](https://github.com/PseudoSky/adhd/commit/4ccdb53e))
- **nx:** drop self-referential scripts.build wrappers to restore build cache ([d6b2331d](https://github.com/PseudoSky/adhd/commit/d6b2331d))
- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes) ([8698ee5f](https://github.com/PseudoSky/adhd/commit/8698ee5f))
- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — close HITL error-path races (emit leak + abort-race rejection) ([634bf7fc](https://github.com/PseudoSky/adhd/commit/634bf7fc))
- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — typed TestDb access + hitl resolver-before-status ordering ([8ca684a5](https://github.com/PseudoSky/adhd/commit/8ca684a5))
- **apigen-cli:** restore 2768 files mass-deleted by 6b36a38a (BUG-APIGEN-052) ([8202f672](https://github.com/PseudoSky/adhd/commit/8202f672))
- **release:** finish agent-mcp usage-accounting release + fix two nx-build publish/version bugs ([114587f1](https://github.com/PseudoSky/adhd/commit/114587f1))
- **agent-mcp:** bump orchestrator 2.1.6 + agent-mcp 2.1.5, add missing budget-plugin dep ([6b61dcd2](https://github.com/PseudoSky/adhd/commit/6b61dcd2))
- **agent-mcp:** cache-preserving context mgmt, provider-neutral token accounting, refactor-parity fixes; prep 2.1.0 family release ([29ab8497](https://github.com/PseudoSky/adhd/commit/29ab8497))

### 🔥 Performance

- **agent-engine-orchestrator:** lean per-turn context for dispatched agents — compact tool schemas, cap claudecli bridge results, 6000-char default cap, --setting-sources project (9ed453c1 CTX) ([82727867](https://github.com/PseudoSky/adhd/commit/82727867))

### ❤️ Thank You

- pseudosky

## 2.3.8 (2026-10-09)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## Unreleased

### 🐛 Bug Fixes

- **The cache guard's estimator is now checked against the API on the measured fixtures.** New exports `estimatePrefixTokens` / `estimateToolsTokens` (the pure estimator `applyCacheBreakpoints` already gated on; no behavior change) and `CACHE_ESTIMATE_LOWER_TOLERANCE` (0.78). `cacheguard-estimator-tolerance.test.ts` runs the estimator over the three real logged haiku-4-5 requests and asserts `0.78 * real <= estimate <= real` (measured ratios 0.809 / 0.810 / 0.800 of `input_tokens` 3130 / 4404 / 4714), that the tools-block estimate is `countTokens(JSON.stringify(tools)) + serverToolTokens(tools)`, and that the server-tool credit is 2180 on this fixture. (ebfe7421 AC2)
- **The Anthropic cache guard no longer skips prefixes the API would cache.** The `gpt-tokenizer` estimate undercounted the API by up to 20% even after the server-tool credit (real turns: `input_tokens` 3130 / 4404 / 4714 vs estimates 2532 / 3566 / 3770), so turns 2 and 3 of a real Haiku 4.5 task (above its 4096 minimum) never received a breakpoint. `applyCacheBreakpoints` now gates on `cacheGuardThreshold(model)` = 0.75 x the model minimum (new exports `CACHE_GUARD_SAFETY_RATIO`, `cacheGuardThreshold`); the per-model minimum table and the unknown-model 4096 default are unchanged, and a clearly small prefix still places nothing. The module header no longer claims a write premium on sub-minimum prefixes (the docs say such a prompt is simply not cached). Tests: `cacheguard-undercount.test.ts` with the three real logged requests as fixtures. (ebfe7421 CG)
- **Bridged `claudecli` tool calls are observable like engine-native ones, and each is bounded.** A tool call that reaches an MCP server through the loopback bridge now records `TOOL_CALL`/`TOOL_RESULT` task events (call ids `bridge-<n>`) and stream events, applies BK2 argument coercion (a stringified array reaches the server as an array, with a `TOOL_ARG_COERCED` event), and keeps the head+tail cap/spill. Each bridged call also has a per-call time limit (the agent's `provider.timeoutMs`, default 300000 ms): a hung tool returns a clear `isError` result naming the tool, server, and limit instead of stalling the turn. (9ed453c1 BLIND F6a/F6b)
- **A redispatched task whose persisted `cwd` is gone fails with a clear error.** `enqueueExistingTask` checks the stored dispatching directory; if it no longer exists (or is not a directory) the task is marked `failed` with a message naming the path. It never falls back to another directory and no `claude` process is spawned. (9ed453c1 BLIND F9)

- **The advertised tool block is byte-stable across tasks, so the prompt cache hits.** The Anthropic `tools` array precedes `system` in the cached prefix, and it differed on every task: `mcp-shell-server` (the default `shell_execute` tool) renders its `Allowed commands: ...` line from a Python `set`, whose order follows the per-process `PYTHONHASHSEED` (verified against the real `mcp-shell-server==1.1.12`: three spawns, three orders), so every task re-wrote the whole ~8k prefix. The orchestrator now passes the registry's tool list through `canonicalizeToolDefinitions` before it reaches any provider path (`full`/`names` advertisement and the `claudecli` loopback bridge): every `Allowed <what>: a, b, c` description line has its items sorted (code-unit order; item set and all other text unchanged; idempotent). Server-agnostic, no fork of the third-party server, no spawn-env change. New exports `canonicalizeToolDefinitions`, `canonicalizeDescription`. Tests: `cp-cache-tool-determinism.test.ts`, `ctx-lean-context.test.ts`, `cp-cache-tool-determinism.e2e.test.ts` (five real `uvx` server spawns at `PYTHONHASHSEED=1..5` plus a shuffling fixture: raw hashes differ, canonical hashes equal; `claudecli` bridge `tools/list` identical across two `chat()` calls). (9ed453c1 CACHE)

### 🐛 Bug Fixes

- **`claudecli` executes each MCP tool exactly once.** Every declared `mcp__*` tool used to run twice per call: once by the `claude` child (which was given the real servers through `--mcp-config`) and once by the engine loop, which answered the same `tool_use` with a synthetic stdin `tool_result` (visible as two backlog processes per command and doubled side effects, e.g. a second `release-noop`). `chat()` now starts a per-call loopback Streamable-HTTP MCP bridge (`providers/claudecli-tool-bridge.ts`; 127.0.0.1, random per-call bearer token, Host check, stateless JSON responses, one route per advertised server so the model still sees `mcp__<server>__<tool>`) whose `tools/call` goes through `request.executeTool`; claude's `--mcp-config` (0600) contains only those bridge entries, never a server command, env or header. The loop-execute branch and `isLoopExecutedToolUse` are deleted, there is no toggle, the bridge is closed in `finally` (resolve, reject and abort), and advertising MCP tools without an `executeTool` callback now fails loud with `PROVIDER_ERROR` before anything is spawned. Behaviour change: the engine's registry client is now the only launcher of MCP servers, so per-server `cwd`/`env`/srt apply to `claudecli` tools (claude no longer inherits them). Engine-internal `builtin__*` pseudo-tools (HITL) are not bridged (claude never saw them). Verified against the real `claude` CLI (haiku-4-5): one `bump` call -> counter file 1 line, one server process, model replied `seq=1`. Tests: `claudecli-tool-bridge.e2e.test.ts`, `claudecli-bridge-config.test.ts`. (9ed453c1 BRIDGE)

### 🚀 Features

- **Optional tool-result spill.** With `EngineConfig.toolResult.spill = { enabled: true, dir, ttlMs }` a result the cap would truncate is written in full to `<dir>/<taskId>/<callId>.txt` (`0600`, dirs `0700`, `O_EXCL`, no symlink following; an MCP text-block array is written as plain text lines) and the model sees a stub with the path, size and a 2000-char preview. Any spill failure falls back to the head+tail cap and never throws; `TOOL_RESULT` events gain `spilled: true` and `spill_path`. Disabled or absent, behaviour is byte-identical to `capToolResult`. New exports: `capOrSpillToolResult`, `resolveToolResultSpill`, `validateToolResultSpillDir`, `parseToolResultSpillTtlHours`, `writeToolResultSpillFile`, `sweepToolResultSpill`, `removeTaskSpill`, `renderSpillStub`, the `TOOL_RESULT_SPILL_*` key/env constants, and the `ToolResultSpillConfig` / `ToolResultSpillOutcome` types. (3ad735bb)
- **Tool-result spill ownership, collision-free names, last-spill retention, cap-bounded stub.** The spill directory is claimed with a `.adhd-spill-root` marker and each task directory with a `.adhd-spill-task` marker; a non-empty unclaimed directory is refused (startup `RangeError` via `resolveToolResultSpill`, cap fallback at the first spill) and `sweepToolResultSpill` / `removeTaskSpill` remove only marker-bearing task directories the spill created, so pointing `ADHD_AGENT_TOOL_RESULT_SPILL_DIR` at a directory with other content can no longer delete it. Distinct ids never share a path (non-safe ids get a `~<sha256>` suffix; an existing regular file is never overwritten, a unique sibling name is used). Retention runs from the last spill in a task (the marker is refreshed on every spill and the newest file counts). The stub names the path once and the whole stub is at most the cap. New exports: `assertToolResultSpillDirUsable`, `SPILL_ROOT_MARKER`, `SPILL_TASK_MARKER`. (9ed453c1 BLIND F1/F2/F3/F5)
- **Explicit model resolution for `claudecli`.** An alias model (`haiku`, `sonnet`, `opus`) is resolved to the concrete id the CLI reports (`result.modelUsage` keys, falling back to the `init` event's `model`; no alias table). `task_usage.model` and `response_model` hold the resolved id, `requested_model` keeps the configured value, and cost is priced PER resolved model at its own rate card and summed (the model with the most tokens is `model`; `model_breakdown_json` records all of them). A resolved id with no rate card is `unpriced_model` with `est_cost_usd` NULL, never priced at another model's rate; the CLI's `total_cost_usd` is stored in `cli_reported_cost_usd` for cross-check. `usage_query` turn re-pricing is strict for these tasks too. Pin concrete ids for benchmarks: aliases move (`--model haiku` resolved to `claude-haiku-5-5`). Recorded-stream replay tests: `claudecli-model-resolution.test.ts`. (79aebb26)

### 🐛 Bug Fixes

- **A `claudecli` task now spawns `claude` in the task's dispatching cwd.** `buildProviderForSelection` now overrides the host-global `EngineConfig.cwd` with `ExecutionContext.cwd` (the caller-supplied, parent-inherited or persisted cwd), so `claude`, its `roots/list` answer, and every MCP child it launches share the cwd the task was dispatched with (ADR-0008 D9). Before, every task ran in the host's startup cwd, so the `fs` server (argv root = task cwd) rejected every read with "Access denied ... not in <host cwd>". A restart / DAG redispatch (`enqueueExistingTask`) now restores the persisted cwd instead of dropping it (9ed453c1 CWD).

- **`loadExternalPlugins` reports every skipped plugin.** New `overrides.onPluginLoadFailed(failure)` callback receives `{ specifier, stage, reason, isDefault }` for each entry skipped at the `resolve`, `import`, `config`, `factory-missing`, `instantiate` or `install` stage, independent of the injected logger. Types `PluginLoadFailure`, `PluginLoadFailureHandler` and `PluginLoadFailureStage` are exported. Skip behaviour is unchanged; a throwing handler never aborts the load loop. (c536ce29 E2E-PREREQ)
- **Compaction uses the true per-response context.** The orchestrator fed `usage.inputTokens` to the compaction decision; for `claudecli` that is the cumulative sum across CLI turns, so compaction could fire on an inflated number. It now uses `peakContextTokens` when the provider reports it, else `inputTokens`. (7ead5eaa AC4.5)
- **`task_usage.peak_context_at` is the actual 1-based model-call index.** The first insert hard-coded `1` regardless of how many calls the response folded (a 5-turn `claudecli` response peaked at call 1); it is now the response's call count, consistent with the update path, which moves it only when the peak strictly increases. Documented in `logging.md`. (7ead5eaa AC4.6)
- **`claudecli` no longer SIGTERMs a child that is exiting on its own.** `chat()` used to send `process.kill(-pid, "SIGTERM")` to the `claude` process group in `finally` right after the `result` line, before the child had exited; under CPU load that beat the child's own `exit(0)` (traced `spawn.exit {code: null, signal: "SIGTERM"}`, flaky `provider-wire` TRC-AC5) and would kill a real CLI mid session-flush. The success path now closes stdin and reaps the child detached (chat() is not delayed): it waits `exitGraceMs` (default 5000) for the child's own exit, then group SIGTERM, then group SIGKILL after `killEscalationMs` (default 2000), keeping the grandchild-leak protection. Error and abort paths still SIGTERM the group immediately. The signalling guard now also checks `signalCode`. Timings are injectable via the optional 6th `ClaudeCliProvider` constructor argument (`Partial<ClaudeCliReapTimings>`; `ClaudeCliReapTimings` and `DEFAULT_CLAUDECLI_REAP_TIMINGS` are exported from `providers/claudecli.ts`, not the package index). Tests: `claudecli-reap.e2e.test.ts` (held-child never signalled, SIGTERM-ignoring child and grandchild reaped, abort terminates immediately); `fake-claude.mjs` gains `ADHD_FAKE_CLAUDE_HOLD` modes. (322a1efb, plan 9ed453c1)
- **`claudecli` reports the true per-turn peak context.** `task_usage.peak_context_tokens` (and `usage_query`'s `context_size`) previously equalled the CLI's cross-turn SUM for `claudecli` tasks (a 5-turn run stored 36,589 where the largest single turn was 9,149). The provider now takes the max over the stream's per-turn `assistant` usage (`input + cache_read + cache_creation`) and returns it as `TokenUsage.peakContextTokens`; `UsagePlugin` and the turn grain use it (falling back to `inputTokens` when absent, so every other provider is unchanged). `inputTokens` keeps its cumulative, cache-inclusive meaning and cost is untouched; `logging.md` now states which field is per-turn and which is cumulative. Replay tests: `claudecli-peak-context.test.ts` (recorded runs B1 -> 9,149, B2 -> 14,757). (7ead5eaa)
- **`usage_query` turn grain re-prices a multi-model `claudecli` response per model.** The `MODEL_RESPONSE` event payload now carries `modelBreakdown` (and `peakContextTokens`), and the turn grain prices each entry at its own rate card, strict like the write path, instead of pricing the whole turn at the task's primary model. New export `priceModelBreakdown` (shared by the write and read paths). (7ead5eaa)
- **Stringified array/object tool arguments are repaired.** Before `callTool` the orchestrator JSON-parses a string argument whose declared `input_schema` type is exactly `array` or `object` (top-level properties only, no union/`anyOf`/`oneOf`/`allOf`/`$ref`; arrays of string must parse to all strings). Each repair records a `TOOL_ARG_COERCED` event `{taskId, tool, property, from, to}` and a warning; a string that does not parse to the declared type is rejected without calling the tool, with an error naming the property, the declared type and a worked example. This removes the failure where Haiku sent the shell tool's argv as `"[\"adhd-backlog\", ...]"` three times in a row and exhausted the `consecutiveErrors` budget. `EngineConfig.toolArgCoercion.enabled` (default on) is the test switch; `TaskEventType` gains `TOOL_ARG_COERCED`; new exports `coerceToolArguments`, `ToolArgCoercion`, `ToolArgCoercionOutcome`, `ToolArgMismatch`. (114e014c)
- **Cache-write 1h tier.** `normaliseAnthropicUsage` carries `usage.cache_creation.ephemeral_1h_input_tokens` as `cacheCreation1hTokens`; `UsagePlugin` and the `usage_query` turn re-pricing pass it to `estimateCost`, and the `MODEL_RESPONSE` event payload records it, so stored `est_cost_usd` for a cold-cache `claudecli`/`anthropic` call matches the vendor total. 5-minute-only and unsplit usage is priced as before. (b726a987)

### 🚀 Features

- **Tool-result cap.** The orchestrator bounds each tool result before the tool message is appended, for all providers and sub-agent results: above `EngineConfig.toolResult.maxChars` (default `20000`, `0` disables) the model sees the first 75% and last 25% around `[tool result truncated: showing first N and last M of T chars; re-run with a narrower command (e.g. grep, head, sed -n 'a,bp')]`. Error results of 4000 chars or fewer are never truncated; cuts never split a UTF-16 surrogate pair. `TOOL_RESULT` events carry `truncated: true` and `original_chars`; `tool_call_est_result_tokens`, `post:tool_call` and the SSE event still carry the full result; the persisted session history holds the capped form. New exports: `capToolResult`, `validateToolResultMaxChars`, `parseToolResultMaxChars`, `DEFAULT_TOOL_RESULT_MAX_CHARS`, `ERROR_RESULT_FLOOR_CHARS`. (3ad735bb)
- **Prompt-cache breakpoints on the `anthropic` provider.** Requests now carry up to three 5-minute `cache_control` breakpoints (last `tools` entry, last `system` block, last cacheable block of the final message), each guarded by the model's minimum cacheable prefix (`claude-haiku-4-5` 4096, `claude-haiku-5-5` 512, sonnet-4-6/sonnet-5 1024, opus-4-5/4-6 4096, unknown model 4096) so short prompts are byte-identical to before; the OAuth identity system block is never touched. Previously every turn of every task was billed as fully uncached input. New `providers/anthropic-cache.ts` (`applyCacheBreakpoints`, `minCacheableTokens`); optional 4th constructor argument `new AnthropicProvider(cfg, engine, logger, { promptCaching })` (default `true`; `false` restores the pre-change body). Covered by a loopback E2E that asserts the real request body and that cache read/creation usage reaches `task_usage` at the rate-card cost. (ae62e6b0, plan 9ed453c1)
- **Response-model capture.** Provider adapters (`anthropic`, `openai`) return `responseModel`; the orchestrator forwards it on the `post:model_response` hook payload and the turn event. `claudecli` sets it from `result.modelUsage` (79aebb26). (1f1c8598) ([cfc9d936](https://github.com/PseudoSky/adhd/commit/cfc9d936))
- **Per-turn price provenance in `UsagePlugin`.** Each turn is priced as of its own instant through an as-of price source (`new UsagePlugin(db, logger?, {priceSource?, now?})`; default `createPriceSource(db)`) and records `response_model`, `cost_basis`, `pricing_ref`, `cost_status` (`priced` | `unpriced_model` | `partial`), `priced_cost_usd` and `unpriced_tokens` on `task_usage`. `est_cost_usd` is NULL as soon as any turn is unpriced, while `priced_cost_usd` keeps the priced portion. An unpriced model logs one WARN per provider and model per plugin instance (to stderr by default). (37f6c511 1f1c8598) ([1cb6a4a9](https://github.com/PseudoSky/adhd/commit/1cb6a4a9))
- **`usage_query` read path.** New `group_by: "response_model"` (legacy rows without a captured model group under `(unknown)`); rows carry `response_model`, `cost_status`, `cost_basis` and `pricing_ref`; summaries carry `priced_cost_usd`, `unpriced_tasks`, `unpriced_turns` (exact count, on the un-grouped shape), `unpriced_tokens`, `unpriced_models`, `cost_bases` and `price_age_hours`. Example: `usage_query { "group_by": "response_model" }`. (37f6c511 1f1c8598) ([0d59e617](https://github.com/PseudoSky/adhd/commit/0d59e617))

### Known limits

- Provenance is `NULL` on rows written before this change (unknown, not unpriced) and they are not counted in `unpriced_tasks`.
- DeepSeek-direct cost is an estimate from OpenRouter rates under the owner-assumed `deepseek-flash` alias.

### Release note (owner)

Additive (new optional hook field, new optional response fields, new `group_by` value, optional constructor argument): minor bump recommended (2.3.6 to 2.4.0). Not bumped here.

## 2.3.7 (2026-10-08)

### 🩹 Fixes

- **agent-engine-orchestrator:** agent_create/agent_update input accepts legacy apiKeyEnv/authTokenEnv (mapped to env.secret); document PF-1 provider fields and strict input in agent-mcp (2eddcf91, 3864449b) ([3848205c](https://github.com/PseudoSky/adhd/commit/3848205c))

### ❤️ Thank You

- pseudosky

## 2.3.6 (2026-10-07)

### 🩹 Fixes

- **agent-engine-orchestrator:** provider schema accepts PF-1 fields, strict provider/patch schemas, patch includes toolAdvertisement (a388103a, 96fd2773) ([49b8d3f0](https://github.com/PseudoSky/adhd/commit/49b8d3f0))

### ❤️ Thank You

- pseudosky

## 2.3.5 (2026-10-07)

### 🚀 Features

- **nx-build:** release/CI/toolchain integrity gates (a4d346ae df9de4da 8c0c314e 255394d0 b83f167d 420a7051 e92e2b92 7b7d5e38 ddceb069) ([35bbcbf0](https://github.com/PseudoSky/adhd/commit/35bbcbf0))
- **agent-engine-orchestrator:** ask escalation climbs transitively to the nearest interactive ancestor, root-terminal deny (fc466f0b) ([6bd3e4f6](https://github.com/PseudoSky/adhd/commit/6bd3e4f6))
- **agent-engine-orchestrator:** emit permission:decision, hitl:suspend, hitl:resume, session:closed (f376e27a TRACE-2) ([9f2e7dc5](https://github.com/PseudoSky/adhd/commit/9f2e7dc5))
- **agent-engine-orchestrator:** un-weld agent from provider; resolveSelection chain + session-held binding + fail-closed NO_PROVIDER_SELECTED (5ad2cf37 D-G(2)) ([b5f3f6d8](https://github.com/PseudoSky/adhd/commit/b5f3f6d8))

### 🩹 Fixes

- **agent-engine-orchestrator:** reconstruct rootTaskId/callingAgentName on re-dispatch (0d77376f) ([90df4a43](https://github.com/PseudoSky/adhd/commit/90df4a43))
- **agent-engine-orchestrator:** named fail-fast connectTimeoutMs, no doubled reconnect after listAllTools (c9f0a791) ([78104bf3](https://github.com/PseudoSky/adhd/commit/78104bf3))
- **agent-store-runtime:** getSelection fails loudly on an unmigrated sessions table (aafd6561 e) ([423350ea](https://github.com/PseudoSky/adhd/commit/423350ea))
- **agent-engine-orchestrator:** stop caller-cwd test 4 spawning a real npx MCP server ([9bcfa290](https://github.com/PseudoSky/adhd/commit/9bcfa290))

### ❤️ Thank You

- pseudosky

## 2.3.4 (2026-10-06)

### 🚀 Features

- **agent-engine-orchestrator:** enforce the resolved native-tooling permission gate (NAT-TOOL-6) ([0103dc2f](https://github.com/PseudoSky/adhd/commit/0103dc2f))
- **agent-engine-orchestrator:** thread cwd + subprocessEnv into MCP clients (ADR-0008 D9 / NAT-TOOL-3) ([919d6e86](https://github.com/PseudoSky/adhd/commit/919d6e86))
- **agent-base-types:** nativeTooling typed config + stdio cwd (ADR-0008 NAT-TOOL-1) ([a2840f17](https://github.com/PseudoSky/adhd/commit/a2840f17))
- **agent-engine-orchestrator,agent-mcp:** gate agent systemPrompt behind explicit opt-in ([4a6ae079](https://github.com/PseudoSky/adhd/commit/4a6ae079))
- **agent-engine-orchestrator:** provider-native web_search/web_fetch in the default toolset (1abd2d84) ([e95bc2df](https://github.com/PseudoSky/adhd/commit/e95bc2df))
- **agent-engine-orchestrator:** native tasks_batch bulk/parallel dispatch primitive (05cc1db4) ([182d741c](https://github.com/PseudoSky/adhd/commit/182d741c))
- **agent-engine-orchestrator,agent-mcp:** add agent_verify_mcp handshake check ([88171d7c](https://github.com/PseudoSky/adhd/commit/88171d7c))
- **agent-engine-orchestrator,agent-mcp:** surface open sessions on agent_update ([492092a2](https://github.com/PseudoSky/adhd/commit/492092a2))
- **agent-engine-orchestrator:** bound and filter task_list/result output ([d237241f](https://github.com/PseudoSky/adhd/commit/d237241f))
- **agent-mcp:** load budget plugin by default with conservative cap (5339c2e5) ([3ccb0e86](https://github.com/PseudoSky/adhd/commit/3ccb0e86))

### 🩹 Fixes

- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-engine-orchestrator:** route an escalated ask to the parent task (a0c0a826) ([85fa0dba](https://github.com/PseudoSky/adhd/commit/85fa0dba))
- **agent-engine-orchestrator:** require explicit approval for a permission ask (FIX 5) ([890076cb](https://github.com/PseudoSky/adhd/commit/890076cb))
- **agent-engine-orchestrator:** unify HITL gate on effectiveHitl; fail synchronous asks closed ([17f6dfb7](https://github.com/PseudoSky/adhd/commit/17f6dfb7))
- **agent-mcp,agent-store-runtime:** collapse duplicate vite plugins keys; sweep all configs (50b77657) ([f2e8ceba](https://github.com/PseudoSky/adhd/commit/f2e8ceba))
- **agent-mcp:** resolve default budget plugin from agent-mcp's own module base (cc636860) ([dd0ed875](https://github.com/PseudoSky/adhd/commit/dd0ed875))
- **agent-engine-orchestrator:** collapse duplicate vite plugins key (50b77657) ([6b6458d2](https://github.com/PseudoSky/adhd/commit/6b6458d2))
- **agent-engine-orchestrator:** compile the spec corpus with a typecheck-spec ratchet ([4c254146](https://github.com/PseudoSky/adhd/commit/4c254146))
- **agent-engine-orchestrator:** enforce task depends_on gating before dispatch (ac115447) ([2f5a556a](https://github.com/PseudoSky/adhd/commit/2f5a556a))
- **agent-engine-orchestrator:** resolve the default budget plugin from the engine (dfb03557) ([976e4a2a](https://github.com/PseudoSky/adhd/commit/976e4a2a))
- **agent-engine-orchestrator:** type projected taskList/resultTool as ProjectedTask ([6ee04cea](https://github.com/PseudoSky/adhd/commit/6ee04cea))
- **agent-engine-orchestrator,agent-mcp:** wire full/fields opt-in into agent_update response ([d0d26495](https://github.com/PseudoSky/adhd/commit/d0d26495))
- **agent-engine-orchestrator:** tri-state status for agent_verify_mcp results ([30b04c74](https://github.com/PseudoSky/adhd/commit/30b04c74))
- **agent-engine-orchestrator:** route provider SDK client timeout through the raised default (36a73117) ([f6213b58](https://github.com/PseudoSky/adhd/commit/f6213b58))
- **dispatch-orchestrator:** surface agent-mcp policy violations through dispatch_log (4e829a08) ([b6884f67](https://github.com/PseudoSky/adhd/commit/b6884f67))
- **agent-engine-orchestrator:** raise default provider timeout 60s->300s (36a73117) ([08544fae](https://github.com/PseudoSky/adhd/commit/08544fae))
- **agent-engine-orchestrator:** clamp claudecli env bleed + group-aware teardown (322a1efb) ([37ce3c0d](https://github.com/PseudoSky/adhd/commit/37ce3c0d))
- **agent-engine-orchestrator,agent-mcp:** add delete/rename semantics to mcpServers patch ([37ce3650](https://github.com/PseudoSky/adhd/commit/37ce3650))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.1 (2026-09-24)


### 🩹 Fixes

- **nx:** drop self-referential scripts.build wrappers to restore build cache


### ❤️  Thank You

- parity-harness-self-test
- pseudosky
- Sky

## 2.3.0 (2026-08-11)


### 🚀 Features

- **agent-plugin-budget:** rename tokens cap to context with peak semantics + contextWindowFraction (Packet B, BUG-AGENTMCP-009)


### 🩹 Fixes

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)

- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — typed TestDb access + hitl resolver-before-status ordering

- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — close HITL error-path races (emit leak + abort-race rejection)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 2.1.7 (2026-07-26)

Ships proper usage accounting and budget enforcement, plus the claudecli provider usage fix (e660126b) — required by `@adhd/agent-mcp@2.1.5` (BUG-MCP-PLUGIN-CONFIG-001). Republished as part of unbreaking the `@adhd/agent-mcp` install chain (BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001) after the prior `agent-engine-orchestrator@2.1.6` was published broken (empty tarball, via the retired `nx release publish`) by a separate, since-terminated agent session.

## 2.1.6 (2026-07-25)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.1.5 (2026-07-24)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.1.4 (2026-07-24)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)

This was a version bump only for agent-engine-orchestrator to align it with other projects, there were no code changes.