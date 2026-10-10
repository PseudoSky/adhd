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
- **Failed-run accounting and first-turn context** — a `claudecli` run that fails, is cancelled or times out records the usage it spent (an `is_error` result's own usage/cost, the engine-discarded response of a fatal governance error, or the per-call usage seen on the stream, whose output tokens are mid-stream snapshots and so a lower bound; a run that reported nothing is a zero row with `cost_status: "unmeasured"`, `est_cost_usd: null`; a retried request sums every billed attempt). `usage_query` rows expose `task_status`, `usage_lower_bound`, `requested_model`, `cli_reported_cost_usd`, `cache_creation_1h_tokens`, and (turn grain) `first_turn` / `per_turn`; the task/result usage summaries carry `est_cost_usd`. See `entrypoint/agent-mcp/docs/logging.md`.
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

Estimator tolerance (`ebfe7421` AC2): the real tools-block count is not separately measurable (the API reports one
`input_tokens` per request), so the tolerance is stated on the whole prefix, using the production estimator
`estimatePrefixTokens` (the function `applyCacheBreakpoints` gates on) against the three real requests:
`CACHE_ESTIMATE_LOWER_TOLERANCE * real <= estimate <= real` with the constant at 0.78. Measured ratios are 0.809 /
0.810 / 0.800 (2532/3130, 3566/4404, 3770/4714). The upper bound keeps the estimate a lower bound; the lower bound
(above the 0.75 gate ratio) means the gate clears every real prefix at or above the model minimum. The tools-block
component is `countTokens(JSON.stringify(tools)) + serverToolTokens(tools)`; on this fixture the server-tool credit
is 2180. Enforced by `src/__tests__/cacheguard-estimator-tolerance.test.ts`.

Premium measurement (`ebfe7421` CG-AC3): a live run on `main` at `ca4851b5` against `claude-haiku-4-5` through the
anthropic provider (no tools; `cache_control` marks placed on the system and messages by the guard; real prefix
below the 4,096-token minimum) returned this usage per turn:

- turn 1: `input_tokens` 3571, `cache_creation_input_tokens` 0, `cache_read_input_tokens` 0, `output_tokens` 5,
  estimated cost 0.003596
- turn 2: `input_tokens` 3590, `cache_creation_input_tokens` 0, `cache_read_input_tokens` 0, `output_tokens` 5,
  estimated cost 0.003615

A `cache_control` prefix below the model minimum is billed as ordinary input, with no cache-write premium. This
is why the guard's margin is acceptable. Caveat: no same-prompt, no-breakpoint control exists, because the
provider's `promptCaching` option is not reachable from any agent or server setting. The conclusion rests on the
raw `cache_creation_input_tokens` of 0.

## `claudecli` provider: MCP tools run once, in the engine

`claude` is never handed your MCP servers. For each `chat()` that advertises tools, the provider starts a loopback Streamable-HTTP MCP bridge (127.0.0.1, random bearer token, Host-checked, closed when the call ends) and writes a `--mcp-config` that points only at it, one route per server so tool names stay `mcp__<server>__<tool>`. Every `tools/call` claude makes goes through the engine's `executeTool`, so each tool executes exactly once, under the engine registry client's `cwd`/`env`/srt and server/tool allowlist. Advertising MCP tools without an `executeTool` callback fails with `PROVIDER_ERROR`. Claude's own built-in tools are unchanged (`--tools` allowlist).

## `claudecli` provider: a missing binary is not an auth error

If the `claude` child cannot start (not on `PATH` -> `spawn claude ENOENT`, or not executable), `chat()`
rejects with `PROVIDER_ERROR` whose message names the binary and the `PATH` searched, and carries
`data.spawnErrorCode`. `PROVIDER_AUTH_ERROR` ("returned empty result ... `claude auth status`") is reserved
for a CLI that started but returned nothing. Set the provider's `claudePath` to point at a non-PATH install.

## Provider faults and rate limits (`anthropic`, `claudecli`)

Both adapters classify every failure with the PF-1 classifier (`@adhd/agent-core-provider`
`classifyProviderError`) and throw a `ProviderCallError`: a `ToolError` whose `data` is the typed
`ProviderFailure` (`class`, `retryable`, `resumable`, `retryAfterMs`, `credentialScope`, `source`) and whose
`resetAt` is the ISO time a limit lifts. `providers/provider-failure.ts` is the single retry owner for these
two adapters:

- **Transient** (`rate_limited` 429, `overloaded` 529, `unavailable` 5xx): at most 2 retries (3 attempts),
  waiting `max(Retry-After, full-jitter backoff)` (`retryConfig` overrides the defaults 500ms / 8s / x2 for
  `anthropic`). Waiting is bounded by the provider `timeoutMs` (or `retryWindowMs`); an in-flight attempt is
  never aborted by it.
- **Quota, billing or usage-window limit** (a spend-limit 429, a `Retry-After` beyond 60s, a claudecli
  `rate_limit_event` with `status: "rejected"`): **zero retries**; the call fails fast with the reset time in
  the error message and `resetAt`.
- **Abort / timeout**: never retried; claudecli kills the whole process group.
- **After a tool ran** (claudecli built-ins or bridged MCP tools): never re-spawned.
- The SDK's own retries are off (`maxRetries: 0`), so there is exactly one retry loop.
- A claudecli `rate_limit_event` with `allowed_warning` is surfaced as `ProviderChatResponse.limitWarnings`
  (and logged), not swallowed.
- **Shared limiter, process-local.** A trip (a 429 wait, a quota/window limit) is remembered per credential
  (`trip:<providerType>:<credentialScope>[:<wireModel>]`) so every concurrent task **in the same process**
  pauses or fails fast instead of rediscovering it. It is not visible to other agent-mcp processes; the
  cross-process store is `provider_trips` in the provider-failure SPEC (PF-3), not built yet.

The engine's provider catch (`engine/orchestrator.ts`) still re-derives the task error code from text and
drops `ToolError.data`; see `src/__tests__/flt-engine-surface.test.ts`.

### Compatibility with native `claude -p`

The native column is the CLI's **documented / observed-in-binary** behaviour, marked (doc), and was **not**
re-exercised here (no live traffic was sent to trigger a limit). The agent-mcp column is pinned by
`flt-anthropic-faults.test.ts`, `flt-claudecli-faults.test.ts` and `flt-claudecli-faults.e2e.test.ts`.

| Situation | Native `claude -p` (doc) | agent-mcp `claudecli` | agent-mcp `anthropic` |
|---|---|---|---|
| Binary missing | shell `command not found`, exit 127 | `PROVIDER_ERROR` naming the binary and PATH (b8372f5a) | n/a |
| Not logged in / 401 | error result, non-zero exit | exit 0 with no result: `PROVIDER_AUTH_ERROR` hint; any other evidence is reported as what it is | `PROVIDER_AUTH_ERROR`, never retried |
| Non-zero exit, no result | non-zero exit, stderr text | `PROVIDER_ERROR` with exit code and scrubbed stderr tail | n/a |
| Transient 429 | retries internally with backoff; result carries `api_error_status` | classified `rate_limited` (retryable); <= 2 re-spawns with backoff | `PROVIDER_RATE_LIMITED`; <= 2 retries after `Retry-After` |
| 529 overloaded | retries internally; surfaces the status | `PROVIDER_OVERLOADED`, same bound | `PROVIDER_OVERLOADED`, same bound |
| Usage window / quota | `rate_limit_event` `rejected` + error result naming the reset; no retry | `PROVIDER_RATE_LIMITED`, not retryable, reset time on the error; siblings fail fast | billing 429 / `Retry-After` > 60s: no retry, reset on the error |
| Window warning | `rate_limit_event` `allowed_warning` | `limitWarnings` on the response + log | n/a |
| Timeout | `API_TIMEOUT_MS`; no total cap in `-p` | `PROVIDER_TIMEOUT` (engine signal); group killed | `PROVIDER_TIMEOUT`; backoff bounded by `timeoutMs` |
| Cancel | SIGINT stops the turn | abort kills the process group; no retry | abort rejects mid-backoff; no retry |
| Truncated stream (no `result`) | non-zero exit | exit status + stderr reported; never an auth error unless exit 0 | SDK stream error classified (`unavailable`) |

## `claudecli` provider: isolation defaults

The `claudecli` adapter spawns `claude -p` as a worker, not as an interactive session. It always passes:

- `--strict-mcp-config` with `--mcp-config` set to the agent's own servers (an inline empty config when it declares none), so the child never loads the operator's MCP set (which includes agent-mcp itself).
- `--tools <allowedBuiltinTools>` (an allowlist; no tools -> `--tools ""`), so no newer built-in (Workflow, Skill, SendMessage, Cron*, Task*, ...) is available. Ignored in `systemPromptIsAgentSpec` mode, where the spec's `tools:` header governs.
- `--no-session-persistence`, so tasks do not write transcripts into `~/.claude/projects`. Keep them for diagnosis with `keepSessionTranscript: true` on the provider config or `ADHD_AGENT_CLAUDECLI_KEEP_SESSION_TRANSCRIPT=1`.
- Session continuation is a text replay (the CLI keeps no transcript), but the replay carries earlier turns' tool use: each run's tool calls and results are stored on its assistant message (`toolResults`, never `toolCalls`) and replayed as `Assistant called tool ...` / `Tool result (...)` lines before that turn's answer, so a fact that only appeared in a phase-1 tool result is recallable in phase 2. Stored inputs and outputs are bounded by the tool-result cap (`agent.toolResult.maxChars` / `ADHD_AGENT_TOOL_RESULT_MAX_CHARS`, `0` disables) and at most 100 tool uses per run. (54499db1)
- `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the child env (unless already set explicitly), so the operator's CLAUDE.md files and auto-memory are not injected into every task.
- `--setting-sources project` (non-spec mode), so the operator's user-level plugins, skills, agents and hooks are not listed into every task's first request (measured -953 input tokens per turn for a shell-only agent; 9ed453c1 CTX). Override with `settingSources` on the provider config (a comma list or array of `user|project|local`, or `"inherit"` for the CLI default) or `ADHD_AGENT_CLAUDECLI_SETTING_SOURCES`.

Tool results the CLI receives through the loopback bridge are bounded by the same head+tail cap as the API path (`ADHD_AGENT_TOOL_RESULT_MAX_CHARS`, default 6000), so one oversized `cat` is not re-sent on every later turn of the CLI's own loop.

The CLI executes its own built-in tools inside the one invocation, so the adapter only answers `tool_use` blocks for `mcp__`-prefixed tools the agent declared.

## Same-turn tool calls: bounded concurrency

When a model emits several tool calls in one turn, the engine runs them concurrently through a concurrency-limited pool (`p-queue`). `EngineConfig.toolCallConcurrency` is the in-flight limit; absent, non-integer or `< 1` means `DEFAULT_TOOL_CALL_CONCURRENCY` (8). Results are appended in call order regardless of completion order, `request_human_input` calls never enter the pool, and one failing call does not cancel its siblings (a fatal engine error such as `MAX_DEPTH_EXCEEDED` still aborts the turn and drops calls that have not started). Each call works over its own locals, so the fan-out is safe under concurrent processes. The `task` tool's `background` default is unchanged. (35768ae8)

## `claudecli` provider: governance (permission gate, caps, hooks)

The `claude` CLI runs its own tool loop, so its tool calls bypass the engine's dispatch loop. They are governed anyway (f9dadeaa):

- **Bridged MCP tools** (every tool of the agent's `mcpServers`) pass through the same per-call guard as an API-path call, before the allowlist check and before the server is called: `permissionGate` (`deny` -> `PERMISSION_DENIED` result, never executed), `pre:tool_call`, `policy.check` + `toolCallCount++` (so `maxToolLoops`, recursion depth and delegation allowlists bound them), then `post:tool_call` and `transform:tool_result`. A cap/budget/delegation violation is returned to the CLI as an `isError` result `[MAX_TOOL_LOOPS_EXCEEDED] ...` and the task then fails with that same error, exactly like the native path.
- **`ask` fails closed on the bridge.** A permission `ask` cannot be answered inside the CLI's loop (no HITL suspend or parent escalation over the bridge), so the call is refused with `PERMISSION_ASK_DENIED` ("HITL suspend is not supported over the claudecli tool bridge"). Use `allow` or `deny` for tools a claudecli agent may reach.
- **CLI built-ins** (`Bash`, `Read`, `Edit`, `Write`, ...) are gated as server `claude-builtin` (rule `claude-builtin.Bash`, or `claude-builtin.*`; a bare `*` rule matches too). A built-in whose verdict is `deny` or `ask` is removed from the `--tools` allowlist, so it does not exist for the child. In `systemPromptIsAgentSpec` mode the spec's `tools:` header, not the engine, chooses built-ins, so a gate that denies/asks any built-in makes the provider **refuse to spawn** (`PROVIDER_ERROR ... refuses to spawn in agent-spec mode`) instead of ignoring the gate.
- **`--dangerously-skip-permissions` is kept**, because headless `-p` has nobody to answer a CLI permission prompt. What it leaves reachable is exactly: the `--tools` allowlist above, the single loopback bridge (`--strict-mcp-config`), and nothing else. The CLI's own permission mode is not a control the engine relies on.

## Architecture

- Part of the 6-package agent framework family
- Depends on: `@adhd/agent-base-types`, `@adhd/agent-store-runtime`
- Depended on by: `@adhd/agent-mcp`

See `/entrypoint/agent-mcp/docs/architecture-and-security.md` for the full agent runtime architecture.
