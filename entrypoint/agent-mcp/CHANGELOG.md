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
