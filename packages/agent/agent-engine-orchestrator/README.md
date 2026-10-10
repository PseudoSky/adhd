# @adhd/agent-engine-orchestrator

Orchestration engine for @adhd/agent-mcp. Implements the core agent execution loop, provider adapters, message windowing, tool calling, and delegation supervision.

**Status:** Core engine (shipped v0.0.1)  
**Package:** `npm install @adhd/agent-engine-orchestrator`  
**Consumers:** `@adhd/agent-mcp` (primary)

## What it does

- **Agent orchestration loop** — coordinates model calls, tool execution, message history, and task completion
- **Provider adapters** — normalizes the three real provider types — `anthropic`, `openai` (which also covers OpenAI-compatible endpoints such as DeepSeek via an explicit `baseURL`), and `claudecli` (subprocess) — to a unified interface. There is no separate `deepseek` or `gemini` adapter.
- **Context management** — implements append-only message history with intelligent collapse (2.0.2+)
- **Token accounting** — provider-neutral usage tracking with cache-aware fields
- **Cost provenance** — `UsagePlugin` prices each turn as of its own instant and records `response_model`, `cost_basis`, `pricing_ref` and `cost_status`; `usage_query` supports `group_by: "response_model"` and reports `priced_cost_usd`, `unpriced_*`, `cost_bases` and `price_age_hours`. `est_cost_usd` is `null` (never 0) for an unpriced model. `claudecli` reports no response model.
- **Delegation supervision** — enforces delegation depth, budget caps, and permission inheritance for child agents
- **Hook system** — pre/post interceptors for policy enforcement and observability

## Usage

This package is **published and importable** (`npm install @adhd/agent-engine-orchestrator`) — it is not truly `private`. Primary consumer is `@adhd/agent-mcp`, whose end users interact with it through the MCP server's tools (`task`, `result`, `agent_create`, etc.).

⚠️ **A direct (non-agent-mcp) consumer MUST wire provider credentials itself.** The engine ships `EngineConfig` as an **interface only** (`src/interfaces.ts`); there is no built-in `Environment`-backed default. In particular `createProvider(...)` resolves a credential via `EngineConfig.getProviderConfig(...)`; if you construct the engine without that wiring, every provider call fails with:

```
No credential for <provider>; set ADHD_AGENT_<PROVIDER>_SECRET
```

The `env: { secret: "ADHD_AGENT_..." }` pointers on agent definitions only resolve when the host supplies an `EngineConfig` whose `getProviderConfig` is backed by `@adhd/environment` (as `@adhd/agent-mcp` does in `entrypoint/agent-mcp/src/config.ts`'s `toEngineConfig()`). See `entrypoint/agent-mcp/src/__tests__/config.provider-credentials.test.ts` for the negative control that asserts this failure mode with no env layers.

For engine integration:

```typescript
import { Orchestrator } from '@adhd/agent-engine-orchestrator';

// `run()` is an instance method taking the full dependency set; the
// constructor takes no dependencies. The host supplies an EngineConfig.
const orchestrator = new Orchestrator();

const result = await orchestrator.run({
  executionContext,   // { taskId, sessionId, agentName, agentDefinition, recursionDepth, toolCallCount }
  messages,
  registry,           // McpClientRegistry
  provider,           // an LLMProvider (createProvider(agentDefinition.provider, ...))
  policy,             // PolicyEngine
  taskStore,
  sessionStore,
  signal: new AbortController().signal,
  taskId: executionContext.taskId,
  config: engineConfig, // REQUIRED for provider credentials
});
```

## Key files

- `src/engine/orchestrator.ts` — main orchestration loop
- `src/providers/` — `anthropic`, `openai` (incl. OpenAI-compatible endpoints), and `claudecli` adapters
- `src/engine/policy.ts` — `PolicyEngine` (depth / tool-loop / delegation-allowlist enforcement)
- `src/plugins/` — hook system, config-file + default plugin loading

## `anthropic` provider: prompt-cache breakpoints and server tools

`providers/anthropic-cache.ts` places at most three 5-minute `cache_control` breakpoints (last tool, last
system block, last message block), each only when the estimated prefix reaches the model's minimum
cacheable size. The estimate is a lower bound. Server-executed tools (`web_search_*`, `web_fetch_*`)
are tiny `{type,name}` stubs on the wire but the API expands them into full definitions, so
`SERVER_TOOL_TOKEN_WEIGHTS` credits each its measured real weight (1090 tokens; measured on
`claude-haiku-4-5`: the pair adds >= 2190 tokens of turn-1 input). Without that credit an agent whose
real prefix was 6.1k tokens estimated at 2.4k and was never cached (`ebfe7421`). Prefixes with no server
tool are estimated as before. Operator view: `entrypoint/agent-mcp/docs/logging.md`.

### Cache guard calibration (`ebfe7421` CG)

The estimator is a `gpt-tokenizer` lower bound and stays short of the API after the server-tool credit. Three
real `claude-haiku-4-5` turns (shell_execute + `web_search_20250305` + `web_fetch_20250910`, OAuth two-block
system, 1/3/5 messages) were billed at `input_tokens` 3130 / 4404 / 4714 against estimates of 2532 / 3566 / 3770
(598 / 838 / 944 short; worst 20% of the real count: fixed per-request tool overhead, per-message framing, and
the tokenizer ratio on text). With the exact `estimate >= minimum` gate, turns 2 and 3 (both above Haiku 4.5's
4096 minimum) were never cached. The guard therefore places a breakpoint when the estimate reaches
`CACHE_GUARD_SAFETY_RATIO` (0.75) of the model minimum (`cacheGuardThreshold(model)`, 3072 for Haiku 4.5 and for an
unknown model). The per-model minimum table is unchanged and an unknown model still assumes 4096. A prefix far
below the minimum (about 1.5k tokens) and the real 3130-token turn 1 still place nothing.

Premium question: Anthropic's prompt-caching docs state that a prompt shorter than the model minimum is simply not
cached (no cache write, no premium), which is why a margin is acceptable. The live confirmation of that claim
(one small `claude-haiku-4-5` call with `cache_control` on a ~3.5k-token prefix, reading
`usage.cache_creation_input_tokens`) is NOT yet recorded here: it was blocked by the credential policy of the
session that implemented this change. Record the raw usage numbers in this section when it is run.

## `claudecli` provider: MCP tools run once, in the engine

`claude` is never handed your MCP servers. For each `chat()` that advertises tools, the provider starts a loopback Streamable-HTTP MCP bridge (127.0.0.1, random bearer token, Host-checked, closed when the call ends) and writes a `--mcp-config` that points only at it, one route per server so tool names stay `mcp__<server>__<tool>`. Every `tools/call` claude makes goes through the engine's `executeTool`, so each tool executes exactly once, under the engine registry client's `cwd`/`env`/srt and server/tool allowlist. Advertising MCP tools without an `executeTool` callback fails with `PROVIDER_ERROR`. Claude's own built-in tools are unchanged (`--tools` allowlist).

## `claudecli` provider: a missing binary is not an auth error

If the `claude` child cannot start (not on `PATH` -> `spawn claude ENOENT`, or not executable), `chat()`
rejects with `PROVIDER_ERROR` whose message names the binary and the `PATH` searched, and carries
`data.spawnErrorCode`. `PROVIDER_AUTH_ERROR` ("returned empty result ... `claude auth status`") is reserved
for a CLI that started but returned nothing. Set the provider's `claudePath` to point at a non-PATH install.

## `claudecli` provider: isolation defaults

The `claudecli` adapter spawns `claude -p` as a worker, not as an interactive session. It always passes:

- `--strict-mcp-config` with `--mcp-config` set to the agent's own servers (an inline empty config when it declares none), so the child never loads the operator's MCP set (which includes agent-mcp itself).
- `--tools <allowedBuiltinTools>` (an allowlist; no tools -> `--tools ""`), so no newer built-in (Workflow, Skill, SendMessage, Cron*, Task*, ...) is available. Ignored in `systemPromptIsAgentSpec` mode, where the spec's `tools:` header governs.
- `--no-session-persistence`, so tasks do not write transcripts into `~/.claude/projects`. Keep them for diagnosis with `keepSessionTranscript: true` on the provider config or `ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT=1`.
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the child env (unless already set explicitly), so the operator's CLAUDE.md files and auto-memory are not injected into every task.
- `--setting-sources project` (non-spec mode), so the operator's user-level plugins, skills, agents and hooks are not listed into every task's first request (measured -953 input tokens per turn for a shell-only agent; 9ed453c1 CTX). Override with `settingSources` on the provider config (a comma list or array of `user|project|local`, or `"inherit"` for the CLI default) or `ADHD_AGENT_CLAUDECLI_SETTING_SOURCES`.

Tool results the CLI receives through the loopback bridge are bounded by the same head+tail cap as the API path (`ADHD_AGENT_TOOL_RESULT_MAX_CHARS`, default 6000), so one oversized `cat` is not re-sent on every later turn of the CLI's own loop.

The CLI executes its own built-in tools inside the one invocation, so the adapter only answers `tool_use` blocks for `mcp__`-prefixed tools the agent declared.

## Architecture

- Part of the 6-package agent framework family
- Depends on: `@adhd/agent-base-types`, `@adhd/agent-store-runtime`
- Depended on by: `@adhd/agent-mcp`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
