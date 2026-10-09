## 2.3.8 (2026-10-09)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## Unreleased

### 🚀 Features

- **`task_usage` records the resolved model.** For `claudecli` agents `model` is the concrete id the CLI reports (`--model haiku` -> `claude-haiku-5-5`), `requested_model` keeps the configured alias, and cost is priced against the resolved id (`claude-haiku-5-5` is ~10x cheaper than `claude-haiku-4-5`). New columns `requested_model`, `cli_reported_cost_usd`, `model_breakdown_json` (migration 0013). See `docs/logging.md`, "Cost and pricing data". Pin concrete ids for benchmarks; aliases move. (79aebb26)

### 🐛 Bug Fixes

- **The store no longer depends on the launch directory.** A server started from the repo root with no overrides opened `data/agent-mcp/agents-dev.db` (the repo `.env` line `ADHD_AGENT_DATABASE_PATH=data/agent-mcp/agents-dev.db`, read relative to the cwd) while the same server launched from any other directory opened the production store `~/.adhd/agent-mcp/production/data/agents.db`. Now the production store is the default from every directory. `<cwd>/.env` and `<cwd>/.adhd/.env` can no longer set `ADHD_AGENT_DATABASE_PATH` (ignored, with a stderr warning naming the file); a relative `ADHD_AGENT_DATABASE_PATH` in the process environment fails startup (`must be an absolute path`) instead of resolving against the cwd; a relative path in `~/.adhd/.env` or the global `config.yaml` is anchored to that file's directory. Every start logs `store=<abs> mode=<production|custom> source=<env|cascade|default>`; `server.start` ops records gain `store_source` and `store_mode`; `mode` is derived from the path, there is no mode switch. (de046157)
- **Migration note.** If you relied on the repo `.env` to select the dev database, set an absolute path instead, in the process environment or in `~/.adhd/.env`: `ADHD_AGENT_DATABASE_PATH=/Users/you/dev/node/adhd/data/agent-mcp/agents-dev.db`. Your `.env` values are not modified. Your dev database file is untouched; it is simply no longer opened unless you name it by absolute path.

- **Cache-write 1h tier.** Cold-cache `claudecli` cache writes are priced at the 1-hour rate when usage reports `cache_creation.ephemeral_1h_input_tokens`, so `task_usage.est_cost_usd` matches the vendor `total_cost_usd` (0.009595 vs the old 0.0060925 in the audited example). `pricing_history` rows gain `cache_write_1h_per_m`. (b726a987)

### 🚀 Features

- **Tool-result size cap.** A tool result longer than `ADHD_AGENT_TOOL_RESULT_MAX_CHARS` (config key `agent.toolResult.maxChars`, default `20000`) is shown to the model as its first 15000 chars, a marker, and its last 5000 chars, for every provider. Example: a 100,000-char `cat SKILL.md` result is re-sent each turn as about 20 KB instead of 100 KB (the measured cost was about 30k tokens per turn). `0` disables the cap; an invalid value fails at startup. Usage telemetry still measures the full result, and `TOOL_RESULT` events gain `truncated: true` and `original_chars`. See `docs/logging.md`. (3ad735bb)
- **Live model prices.** The server now prices usage from an append-only price history instead of a fixed table. On start it seeds the bundled OpenRouter snapshot (467 models, fetched 2026-10-08), then pulls the public `https://openrouter.ai/api/v1/models` feed every 24 hours (no API key, no credentials; 30 s timeout; one retry after `Retry-After`, capped at 120 s, on a network error, 5xx or 429). Several servers sharing one database coordinate through a ledger claim, so exactly one pulls. `PACKAGE_VERSION` is now exported from `server.ts` and sent in the pull's `User-Agent`. (37f6c511 1f1c8598) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **`pricing_refresh` tool** pulls now, bypassing the 24 h gate: `pricing_refresh { "accept": ["some/model-id"] }` returns `{status, ledger_id, fetched_at, models, new, changed, unchanged, anomalies, duration_ms, error?}`. A failed, invalid, empty or shrunk (under 50% of the previous model count) pull changes nothing, logs an ERROR, and the last good prices keep serving. (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **`pricing_history` tool** returns a model's observed price series ($ per million tokens, `observed_at` order, with `source` and `ledger_id`) plus pull status: `pricing_history { "model": "deepseek/deepseek-v4.1-flash" }` returns `{model, unit, rows, status: {last_ok, last_failed, price_age_hours, next_scheduled, anomaly_thresholds}}`. (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **Anomaly hold.** A price move of 20x or more (input or output, either direction) or an input price above $1000/M is held, not applied, and reported in `anomalies`; re-run `pricing_refresh` with `accept: [modelId]` to apply it. A 10x to 20x move is applied with a warning. (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))
- **`usage_query` cost provenance and `group_by: "response_model"`.** Rows carry `response_model`, `cost_status` (`priced` | `unpriced_model` | `partial`), `cost_basis` (`vendor-direct` | `openrouter-estimate` | `owner-assumption`) and `pricing_ref`; summaries carry `priced_cost_usd`, `unpriced_tasks`, `unpriced_tokens`, `unpriced_models` and `price_age_hours`. `est_cost_usd` stays `null` (never 0) for an unpriced model. Example: `usage_query { "group_by": "response_model" }` groups spend by the model the provider reported serving each call. (37f6c511) ([0d59e617](https://github.com/PseudoSky/adhd/commit/0d59e617))
- **Migration 0012** adds `model_price_history` (append-only, enforced by triggers), `price_pull_ledger`, and six nullable provenance columns on `task_usage`. It is additive; legacy rows keep NULL provenance. (1f1c8598 37f6c511) ([bc340a5b](https://github.com/PseudoSky/adhd/commit/bc340a5b))
- **Host wiring:** the pricing service is created in `index.ts`, handed to `UsagePlugin` as its price source, passed to the server for the two tools, and stopped first on shutdown (the scheduler's timer is `unref`'d and an in-flight pull is aborted and its ledger row closed). (37f6c511) ([bcde95eb](https://github.com/PseudoSky/adhd/commit/bcde95eb))

### Known limits

- DeepSeek-direct traffic is billed by DeepSeek, not OpenRouter; its cost is an estimate from OpenRouter rates. `deepseek-flash` is priced as `deepseek/deepseek-v4.1-flash` under an owner-set assumption (`cost_basis: "owner-assumption"`, ticket 37f6c511). Use `group_by: "response_model"` to check which revision actually served the calls; the `claudecli` provider reports no response model.
- A held anomaly stays unapplied until someone calls `pricing_refresh` with `accept`; the daily pull never accepts one on its own.
- The feed carries no effective date, so a price is stamped with the time this server observed it; accuracy is bounded by the 24 h cadence. Time-of-day / tier `pricing.overrides` are stored verbatim and applied to nothing.
- The real-socket pricing tests (`pricing-pull.e2e.test.ts`, `pricing-live-feed.e2e.test.ts`) exist, but the e2e lane is paused locally by owner decision (backlog 8963c3cb); the unit lane uses an injected fake `fetch`.
- There is no setting to disable the daily pull.

### Release note (owner)

All changes in this section are additive for `@adhd/agent-mcp` consumers (new tools, new optional response fields, additive migration): minor bump recommended (2.3.6 to 2.4.0). Not bumped here.

## 2.3.7 (2026-10-08)

### 🚀 Features

- **agent-mcp:** default-load agent-plugin-tracing with typed tracing config, reuse existing telemetry provider, audit script + docs (0f760dcd, 5dff26e6) ([0891a3bc](https://github.com/PseudoSky/adhd/commit/0891a3bc))

### 🩹 Fixes

- **agent-mcp:** --help/--version/unknown-flag answered before any DB-opening import; prepare only sets core.hooksPath in the main checkout (3d6860dd, f2b26b12) ([9b881398](https://github.com/PseudoSky/adhd/commit/9b881398))
- **agent-engine-orchestrator:** agent_create/agent_update input accepts legacy apiKeyEnv/authTokenEnv (mapped to env.secret); document PF-1 provider fields and strict input in agent-mcp (2eddcf91, 3864449b) ([3848205c](https://github.com/PseudoSky/adhd/commit/3848205c))
- **agent-mcp:** agent_update is a no-op (no version bump/write) when the patch changes nothing (F-PERF-3) ([beb25964](https://github.com/PseudoSky/adhd/commit/beb25964))
- **githooks:** pre-push runs test only, e2e stays CI-only; machine-check NAT_TOOL_LIVE gate tables (8963c3cb, 90d07610) ([b3106036](https://github.com/PseudoSky/adhd/commit/b3106036))

### ❤️ Thank You

- pseudosky

## 2.3.6 (2026-10-07)

### 🚀 Features

- **agent-engine-orchestrator:** ask escalation climbs transitively to the nearest interactive ancestor, root-terminal deny (fc466f0b) ([6bd3e4f6](https://github.com/PseudoSky/adhd/commit/6bd3e4f6))
- **dispatch-orchestrator:** drop implicit claudecli agent default (fail closed); document session_update + provider selection (5ad2cf37 D-G(2)) ([5667dff8](https://github.com/PseudoSky/adhd/commit/5667dff8))
- **agent-mcp:** session_update tool, host default provider tier, registry seeding + provider-selection e2e (5ad2cf37 D-G(2)) ([ef9f72e6](https://github.com/PseudoSky/adhd/commit/ef9f72e6))

### 🩹 Fixes

- **agent-engine-orchestrator:** reconstruct rootTaskId/callingAgentName on re-dispatch (0d77376f) ([90df4a43](https://github.com/PseudoSky/adhd/commit/90df4a43))
- **agent-mcp:** silence dotenv banner on stdio stdout (a0806529) ([eae6661c](https://github.com/PseudoSky/adhd/commit/eae6661c))
- **agent-mcp:** assert pinned node fs launch + pinned shell, drop npm registry from srt allowlist, connectTimeoutMs type, docs (c9f0a791) ([b9ab73bc](https://github.com/PseudoSky/adhd/commit/b9ab73bc))
- **agent-mcp:** move gitnexus-singleton contract out of gitnexus-owned skill dir (2cd99264) ([ed73dec1](https://github.com/PseudoSky/adhd/commit/ed73dec1))
- **agent-mcp:** union caller cwd into srt allowWrite when fs.root is explicit; add 48dc agent-portability e2e (7e854708, 33713d33) ([5fee7923](https://github.com/PseudoSky/adhd/commit/5fee7923))

### ❤️ Thank You

- pseudosky

## 2.3.5 (2026-10-06)

### 🩹 Fixes

- **agent-mcp,dispatch-cli,agent-engine-orchestrator:** wire nativeTooling config + single self producer + per-run srt policy (bucket A) ([1cf338b0](https://github.com/PseudoSky/adhd/commit/1cf338b0))
- **agent,environment:** static-review bucket B — declarative session snapshot, drop denyCommands, cache+freeze permission map ([1749a443](https://github.com/PseudoSky/adhd/commit/1749a443))
- **agent-engine-orchestrator:** route an escalated ask to the parent task (a0c0a826) ([85fa0dba](https://github.com/PseudoSky/adhd/commit/85fa0dba))
- **agent-engine-orchestrator:** require explicit approval for a permission ask (FIX 5) ([890076cb](https://github.com/PseudoSky/adhd/commit/890076cb))
- **agent-engine-orchestrator:** unify HITL gate on effectiveHitl; fail synchronous asks closed ([17f6dfb7](https://github.com/PseudoSky/adhd/commit/17f6dfb7))

### ❤️ Thank You

- pseudosky

## 2.3.3 (2026-09-26)

### 🚀 Features

- **vite-plugins:** absorb perf/test-resolve-fix — test-time @adhd/* source resolution ([3e344506](https://github.com/PseudoSky/adhd/commit/3e344506))

### 🩹 Fixes

- **test:** make the full affected gate green (3 latent test-hermeticity fixes) ([734f756d](https://github.com/PseudoSky/adhd/commit/734f756d))
- **nx:** restore main's load-bearing test.dependsOn the remodel silently dropped ([cff62c50](https://github.com/PseudoSky/adhd/commit/cff62c50))
- **vite:** restore import.meta.url in CJS output under vite 8 ([7916e639](https://github.com/PseudoSky/adhd/commit/7916e639))
- **nx:** finish the ESLint v9 flat-config migration and unblock the gate ([53f4ff3e](https://github.com/PseudoSky/adhd/commit/53f4ff3e))

### ❤️ Thank You

- pseudosky

## 2.3.2 (2026-09-24)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.3.1 (2026-08-14)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.3.0 (2026-08-11)


### 🩹 Fixes

- **agent-mcp:** reject bare trailing --host instead of installing to all hosts (DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001)

- **backlog:** DEBT-AGENTMCP-MIGRATION-PINNED-MARKER-001 — defer migration when operational DB is pinned to the flat legacy path

- **agent-mcp:** DEBT-AGENTMCP-HITL-TEST-CLEANUP-001 — typed TestDb access + hitl resolver-before-status ordering

- **agent-mcp:** reject bare trailing --scope instead of silently installing to all hosts (DEBT-AGENTMCP-INSTALL-HOST-DEFAULT-001 scope mirror)

- **agent:** typecheck targets no longer fail TS6305 in fresh worktrees (additive typecheck configs + real type fixes)


### ❤️  Thank You

- pseudosky

## Unreleased


### 🚀 Features

- **agent-mcp:** new `agent-mcp-install` bin registers the MCP server into claude/opencode/codex host configs at user or project scope — `npx -y --package @adhd/agent-mcp@latest agent-mcp-install --host opencode --scope user` (BUG-AGENTMCP-006)

- **agent-mcp:** standardized, portable native tooling — `AgentDefinition.nativeTooling` (`{ fs?, shell?, dispatch?, hitl? }`) is resolved at **task time** against the dispatching cwd by `@adhd/agent-core-native-tooling`, with `ADHD_AGENT_NATIVE_TOOLING_*` config overrides (ADR-0008)

### ⚠️ Breaking Changes

- **agent-mcp:** the authored `tools/mcp-shell/server.mjs` fallback and its `ADHD_AGENT_SHELL_MCP_PATH` path override are **removed** (NAT-TOOL-4). Shell execution is now the adopted `tumf/mcp-shell-server` (`uvx mcp-shell-server`, allowlisted argv — never a shell string) wrapped by `srt`, configured via `nativeTooling.shell.*`. The create-time `buildDefaultMcpServers` helper is gone; `@adhd/agent-core-native-tooling` is the single fs/shell producer and `withDefaultMcpServers` merges at task time.

- **agent-mcp:** the resolved `nativeTooling.*.permissions` gate is **enforced** before every native tool call (NAT-TOOL-6). `deny` returns a typed `PERMISSION_DENIED` and the tool does not execute; `ask` resolves through the fixed chain `suspend → escalate → deny`. The retired `askPolicy`/`ephemeralAskPolicy` knobs no longer apply (ADR-0008 D5/D6).

## 2.2.3 (2026-08-08)


### 🩹 Fixes

- **agent-mcp:** assert a DELTA on REPO_ROOT/data, not an absolute — unblocks 2.2.2 publish

- **build:** route ESM packages' test target through dist-manifest + fail loud on type divergence (BUG-020)

- **agent-mcp:** pin operational data dir scope to global (DEBT-AGENTMCP-OPERATIONAL-DATA-SCOPE-001)


### ❤️  Thank You

- pseudosky

## 2.2.2 (2026-08-07)


### 🩹 Fixes

- **agent-mcp:** eliminate double-import flakiness in real-environment.e2e.test.ts

- **apigen-cli:** restore 2768 files mass-deleted by 0117eb22 (BUG-APIGEN-052)


### ❤️  Thank You

- parity-harness-self-test
- pseudosky

## 2.2.1 (2026-07-27)

Fixes BUG-011 (CRITICAL): the process-entrypoint guard in `src/index.ts`
compared `path.resolve(process.argv[1])` — which only normalizes a path and
never resolves symlinks — against `import.meta.url`, which Node always
resolves to the loaded module's realpath. Any symlinked launch (npm/npx's
`node_modules/.bin/agent-mcp`, pnpm's symlinked store, an MCP host's
`type:local` launcher, or macOS's `/tmp` -> `/private/tmp`) therefore always
had `argv[1]` (the symlink) mismatch `import.meta.url` (the realpath), so
`isMainModule` was always `false` and `main()` never ran — the process
loaded env then exited 0 silently: no server bound, no port, no DB touched.
This made every `npx @adhd/agent-mcp` / opencode `type:local` launch a
silent no-op. Fixed by resolving `argv[1]` through `realpathSync` before
comparing (falling back to the old normalize-only comparison if `argv[1]`
can't be realpath'd), with a `computeIsMainModule()` teeth test that spawns
the real built `dist/src/index.js` through an actual filesystem symlink and
asserts the real HTTP transport port becomes reachable — proven red against
the pre-fix guard (20s timeout, `ECONNREFUSED`, child exits 0 silently) and
green against the fix.

## 2.1.5 (2026-07-26)

Ships proper usage accounting and budget enforcement, plus the claudecli provider usage fix (e660126b) — fixes BUG-MCP-PLUGIN-CONFIG-001 (the `@adhd/agent-plugin-budget` dependency was missing from `package.json`, so the config-driven `loadExternalPlugins()` path could never actually resolve/load it at runtime, even though the config plumbing itself was already correct). Also fixes BUG-RELEASE-UNINSTALLABLE-AGENTMCP-001 downstream: republishing `@adhd/agent-store-tools`, `@adhd/agent-engine-orchestrator`, and the `@adhd/agent-core-*`/`@adhd/agent-store-*` family at their now-settled versions makes every internal `@adhd/*` dependency range in this release resolve to a real published version.

## 2.1.4 (2026-07-24)

This was a version bump only for agent-mcp to align it with other projects, there were no code changes.

## 2.1.3 (2026-07-23)


### 🚀 Features

- session batch — dispatch tool-exec + provider routing, publish hygiene, agent/env/apigen fixes

- **release:** nx release independent versioning + verify-dist-load publish gate (Agent 2)

- **agent-core-env:** shared registry-DB resolver + DI kills import-time DB-open side effect


### 🩹 Fixes

- **agent-mcp:** publish from dist — add packageRoot config, narrow asset glob (drops stray dist project.json), add publishConfig

- **agent-mcp:** 2.1.1 — ship drizzle migrations + pin external deps (2.1.0 was broken)

<!-- Historical entry (2.1.3, 2026-07-23): this agent-mcp-tail usage-accounting fix has no backlog graph ID — it was tracked pre-migration as BUG-AGENTMCP-006 in the old markdown BACKLOG.md (FIXED 2026-07-15, commit 2c42cf67), and that ID was later recycled for the opencode-install bug. Do not re-attach BUG-AGENTMCP-006 here (DEBT-AGENTMCP-CHANGELOG-ID-COLLISION-001). -->
- **agent-mcp:** agent-mcp-tail no longer fans per-task usage across every event

- **agent-mcp:** create + migrate registry DB on fresh machines instead of crashing SQLITE_CANTOPEN

- **agent-mcp:** eliminate SSE-port contention across concurrent stdio instances


### ❤️  Thank You

- pseudosky

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.2] - 2026-07-11

### Fixed

#### Cache-preserving context management (BUG-ORCH-008)

Fixes a critical regression where the context limiter destroyed provider prefix caching, causing 3-4x cost inflation.

**Problem:** When `ADHD_AGENT_CONTEXT_LIMIT > 0`, the `windowMessages` function dropped the oldest conversation messages to stay under the token limit. This mutated the message prefix, which all four major providers (Anthropic, OpenAI, DeepSeek, Gemini) use for efficient caching. Prefix caches provide up to 90% token cost reduction on stateless chat APIs; destroying the prefix on every trim forced full-price re-billing of the entire surviving history.

Measured on wire (DeepSeek v4-flash, 24 model calls):
- With prefix intact: 93-100% cache hit rate
- Calls where prefix was trimmed: 5-6% cache hit rate
- Full-price tokens wasted by 4 trim events: 154,224 tokens (81% of all full-price input in the run)
- Net cost inflation: ~3.15x–3.3x

**Fix:** Replaced with append-only message history. Context enforcement now:
1. Monitors the provider's exact `prompt_tokens` from each response (no more local estimation)
2. Only acts when approaching the model's real context ceiling (e.g., 90% of 1M for deepseek-v4-flash)
3. When action is needed, collapses middle messages into a single synthetic summary exactly once, preserving the prefix

**Breaking change:** `ADHD_AGENT_CONTEXT_LIMIT` now defaults to `0` (disabled). The previous hardcoded 30,000-token default is removed. Users should either:
- Keep the limit disabled (0) and rely on provider ceilings
- Implement input-capping at the source (limit individual tool-result sizes) instead of evicting from the conversation
- Set a per-model override if an operator-enforced cost cap is needed

**Related docs:** `docs/ideas/context-and-cache-strategy.md` in the monorepo contains the complete analysis, wire captures, and design rationale.

#### Provider-neutral token accounting (BUG-ORCH-009, BUG-ORCH-010)

Fixes a critical gap where cache-hit/miss tokens were dropped for OpenAI-compatible providers, and peak-context-size was never tracked.

**Problem:** 
- `inputTokens` is computed differently per provider: Anthropic excludes cached tokens, but OpenAI, DeepSeek, and Gemini include them. This silently broke cross-provider cost aggregation.
- No field tracked the peak prompt size in a single call; only cumulative sum existed. This made it impossible to distinguish "many small calls" (fix: fewer calls, preserve cache) from "one huge call" (fix: cap that input).
- DeepSeek and Anthropic responses carry cache-hit/miss breakdown, but the shipped OpenAI provider dropped these fields entirely on the wire.

**Fix:**
- New normalized usage fields (per-call and in task summary):
  - `uncachedInputTokens` — tokens billed at full rate (cache-miss rate for DeepSeek; input minus cached for Anthropic)
  - `cacheReadTokens` — tokens billed at cache-hit rate (cache-hit for DeepSeek; cache_read for Anthropic)
  - `cacheCreationTokens` — Anthropic cache-creation surcharge (undefined for DeepSeek/OpenAI, which don't charge writes separately)
  - `reasoningTokens` — inference tokens when the provider reports them
  - `peakContextTokens` — maximum prompt size in any single call (new, tracked per-task via `MAX()`, not sum)

- Task usage report now surfaces cache-hit rate and peak context alongside cumulative totals
- Provider mappings for OpenAI now capture `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `reasoning_tokens` from DeepSeek and reasoning-capable models

**Database migration:** `0008` adds:
- `task_usage.peak_context_tokens` (integer)
- `task_usage.peak_context_at` (integer — the 1-based model-call number that hit the peak)

**Breaking change:** Code reading `task_usage.inputTokens` must distinguish:
- `cumulativeBilledInputTokens` (what `inputTokens` was; cumulative sum across all calls)
- `peakContextTokens` (new; max single-call prompt size; the relevant metric for window limits)

#### Create-time environment-variable guard restored (BUG-ORCH-011)

Fixes a security regression where arbitrary host environment variables could be injected into agent provider credentials.

**Problem:** The `agent_create` and `agent_update` schemas had an `envNameGuard` validation rule that enforced `ADHD_AGENT_` prefix on all provider environment variable names. During refactoring to TypeScript, this was extracted into a factory function but never wired into the schemas, silently allowing injection of variables like `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, etc.

**Fix:** Re-wired `buildEnvNameGuard()` into both `agentCreateInputSchema` and `agentUpdateInputSchema`.

**Impact:** Existing agents with non-`ADHD_AGENT_` prefixed environment variables will fail validation on next update. These agents must be recreated with compliant env names.

#### Sessions→agents foreign-key cascade restored (BUG-ORCH-012)

Fixes a data-integrity regression where deleting an agent orphaned all its sessions and messages.

**Problem:** Migration `0007_smart_callisto.sql` restructured the schema, moving `agents` table from `agent-mcp` to `agent-store-runtime`. Drizzle's auto-generated migration silently dropped the `sessions.agent_name → agents.name ON DELETE CASCADE` foreign-key constraint. This meant `agent_delete` would delete the agent row but leave all sessions and messages orphaned, making them impossible to clean up without manual SQL.

**Fix:** Migration `0009_restore_fk_cascade.sql` restores the cascade constraint.

**Impact:** Existing orphaned sessions remain in the database (backward-compatible; no data is deleted). All future agent deletions will cascade correctly. Consider manual cleanup of orphaned sessions from prior 2.0.0/2.0.1 deletions if space is a concern.

#### Default tool advertisement restored to full JSON schemas (BUG-ORCH-013)

Fixes a silent breaking change where agents lost structured tool-call validation.

**Problem:** A new `toolAdvertisement` configuration field was added, defaulting to `'names'` (name + prose description only) for all non-claudecli providers. This was a silent wire-format change: every agent created under 2.0.0/2.0.1 without an explicit `toolAdvertisement` value lost full JSON-Schema function-calling definitions, replacing them with a prose-doc block in the system message. This affects provider-side validation and model-side tool-call accuracy.

**Fix:** Restored full JSON-Schema as the default for `toolAdvertisement`. Name-only mode remains available via explicit `toolAdvertisement: 'names'` on agent creation.

**Impact:** Agents created under 2.0.0/2.0.1 without explicit `toolAdvertisement` setting will now see full schemas in their next task. No migration needed; the change applies on next run.

#### Plugin global-config back-compat (BUG-ORCH-014)

Fixes a silent breaking change where existing global plugin configs stopped loading.

**Problem:** The plugin-loader's `findConfigFile()` function was updated to check `~/.adhd/agent-mcp/config.json` (new preferred location) but silently dropped the fallback to `~/.agent-mcp/config.json` (legacy location). Users with existing configs at the old path would get zero plugins loaded, with no warning.

**Fix:** Restored the fallback chain:
1. `~/.adhd/agent-mcp/config.json` (new preferred)
2. `./.adhd/agent-mcp/config.json` (project-local)
3. `~/.agent-mcp/config.json` (legacy, now explicitly supported)

**Impact:** Existing global configs at `~/.agent-mcp/config.json` will load again. No migration needed.

---

## [2.0.1] - (prior release)

Refer to commit history for 2.0.1 changes.

## [2.0.0] - (prior release)

Initial TypeScript rewrite of the agent-mcp runtime.
