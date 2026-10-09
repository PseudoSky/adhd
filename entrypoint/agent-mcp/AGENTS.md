# AGENTS.md — LLM-Guiding Documentation

This document is written for LLM/agent consumption. It contains only factual, non-marketing claims about @adhd/agent-mcp. All statements are grounded in code or configuration, not speculation.

## What This Package Is (Fact-Based)

`@adhd/agent-mcp` is an MCP (Model Context Protocol) server. When run, it:

1. Accepts JSON-RPC method calls from MCP clients over stdio
2. Manages a local SQLite database at `~/.adhd/agent-mcp/` (configurable)
3. Accepts calls to create agents, send messages, and retrieve results
4. Calls external model providers (OpenAI, Anthropic, DeepSeek, Gemini) via their APIs
5. Enforces runtime policies (token limits, tool allowlists, delegation depth)
6. Returns results and execution traces to the MCP client

## Shipped Status (as of 2.0.2)

All features listed below are shipped and tested.

### Protocol: MCP Tools

The server exposes these MCP tools:

| Tool | Signature | Purpose |
|---|---|---|
| `agent` | `(agentName: string) -> {session}` | Instantiate a session for a named agent |
| `agent_create` | `(name: string, config: object) -> {agentId}` | Create a named agent with provider, model, policy, tool allowlist. Response is a **summary that omits `systemPrompt`**. |
| `agent_read` | `(name: string, fullDefinition?: bool, fields?: string[]) -> {config}` | Fetch agent config by name. Default response is a **summary that omits `systemPrompt`**; `fullDefinition:true` returns the **FULL definition including `systemPrompt`**, or `fields:["systemPrompt"]` requests the body explicitly. |
| `agent_update` | `(name: string, config: object, fullDefinition?: bool, fields?: string[]) -> {version, openSessionsNotUpdated: string[]}` | Update agent config; existing sessions isolated from change. `openSessionsNotUpdated` lists the ids of the currently-active sessions that keep running on the pre-update snapshot (an empty list means no open session was left behind); it is always present, even in the default summary. Default response is a **summary that omits `systemPrompt`**; `fullDefinition:true` returns the **FULL definition including `systemPrompt`**, or `fields:["systemPrompt"]`. |
| `agent_delete` | `(name: string, force?: bool) -> {}` | Unregister agent and cascade-delete all sessions (as of 2.0.2) |
| `agent_list` | `(fullDefinition?: bool, fields?: string[]) -> {agents: [...]}` | List all registered agents. Default response is a **summary that omits `systemPrompt` from each record**; `fullDefinition:true` returns the **FULL definitions including `systemPrompt`**, or `fields:["systemPrompt"]`. |
| `agent_verify_mcp` | `(name: string) -> {agent, servers: [{name, transport, status, ok, tools?, error?, skipped?}]}` | Handshake-verify an agent's configured `mcpServers` before a real task: connects each server and returns its reachable tool names (or a clear per-server error). `status` is the authoritative tri-state — `'verified'` (tools listed), `'skipped'` (self-referential `agent-mcp`, handled in-process), or `'error'`; `ok` is the shorthand `status !== 'error'`. No model call — spends no provider-timeout budget. |
| `task` | `(agentName: string, prompt: string) -> {taskId, status}` | Run a prompt against a session and execute tool-call loop until completion |
| `result` | `(taskId: string) -> {status, result, usage}` | Retrieve task result and execution usage |
| `task_list` | `(filter?: object) -> {tasks: [...]}` | List tasks (filter by sessionId/session_ids/agentName/status/is_ephemeral; page with limit/offset; project with fields[] or summary:true) |
| `task_cancel` | `(taskId: string) -> {}` | Cancel a running or pending task |
| `task_resume` | `(taskId: string, resumeInput: string) -> {}` | Resume a HITL-suspended task with user input |
| `session_list` | `(filter?: object) -> {sessions: [...]}` | List sessions (filter by agentName, status) |
| `session_close` | `(sessionId: string) -> {}` | Close a session; marks final state |
| `session_update` | `({ session_id, provider?, model?, models? }) -> { session_id, selection }` | Set the session-held provider binding (`provider` = anthropic\|openai\|claudecli, `model`/`models` = canonical refs such as `claude_sonnet_4_6`). The session tier of the selection chain `task > session > agent > host default`; a provider-less agent with no binding fails closed (`NO_PROVIDER_SELECTED`). Persisted: survives a restart. |
| `session_clear` | `(sessionId: string) -> {}` | Delete message history for a session (preserves agent snapshot) |
| `usage_query` | `({ task_id?, root_task_id?, agent_name?, since?, include_incomplete?, limit?, group_by?: agent\|model\|provider\|response_model, grain?: session\|task\|turn }) -> {usage: [...], summary}` | Query task usage across multiple tasks (grouped by agent, model, provider, response_model; `group_by` wins over `grain`; legacy rows without a captured response model group under `(unknown)`; `claudecli` does not report a response model); rows carry `response_model`, `cost_status`, `cost_basis`, `pricing_ref`, summaries `priced_cost_usd`, `unpriced_*`, `price_age_hours` |
| `pricing_refresh` | `({ accept?: string[] }) -> { status, ledger_id, fetched_at, models, new, changed, unchanged, anomalies, duration_ms, error? }` | Pull live model prices from the public OpenRouter feed now (no API key), bypassing the daily schedule. Only changed prices append history rows; a failed/rejected pull changes nothing. A >= 20x move (or input > $1000/M) is HELD and listed in `anomalies`; re-run with `accept:[modelId]` to apply it. |
| `pricing_history` | `({ model: string, from?: string, to?: string }) -> { model, rows: [...], status: { last_ok, last_failed, price_age_hours, next_scheduled, anomaly_thresholds } }` | Observed price series for a model ($/M tokens, `observed_at` order, with `source` and `ledger_id`) plus pull status. Prices are as OBSERVED by this server, so the accuracy bound is the 24h pull cadence. |
| `guide` | `() -> {workflows, providers, errors}` | Built-in help: 6 workflows, provider table, error codes |

### Configuration: Zero-Config via @adhd/environment Cascade

`@adhd/agent-mcp` uses `@adhd/environment` (per `packages/environment/ARCHITECTURE.md`) to implement zero-config startup with optional file/env-var overrides. Every configuration field has a code default; the server starts and runs with zero files on disk and zero env vars set. Configuration layers in precedence order:

1. **Code defaults** — hardcoded in `src/config.ts` (e.g., `server.defaultMaxTokens = 8192`)
2. **Global config file** — `~/.adhd/agent-mcp/config.yaml` (if present)
3. **Project config file** — `./.adhd/agent-mcp/config.yaml` (if present; scoped to git/`.adhd` marker)
4. **Environment variables** — `ADHD_AGENT_*` names only (see below)

`.env` files (`~/.adhd/.env` < `<cwd>/.adhd/.env` < `<cwd>/.env`) are loaded into `process.env` at startup by `loadEnvHierarchy()` (`src/utils/load-env.ts`), and **process env beats `.env` files**: a variable already set in the launching process's environment is never overridden by any `.env` file (files override only other files). An empty-string `ADHD_AGENT_*_SECRET` counts as unset.

The zero-config DB path is resolved under the scope root:
- **Scope** is auto-detected (walks up from `process.cwd()` looking for `.git`/`.adhd` markers) or forced via `ADHD_ENV_SCOPE=global`/`project`
- **Global scope** (`~/.adhd/agent-mcp/production/data/agents.db` by default) — never the repo tree, even when inside one
- **Overridable** via `ADHD_AGENT_DATABASE_PATH` env var (falls back to `env.files.db` location when unset)

Verified end-to-end in `src/__tests__/integration/real-environment.e2e.test.ts` (ENV-ADOPT-PROOF-000).

### Configuration: Environment Variables

These env vars configure the server-wide default agent and provider credentials:

| Variable | Type | Example | Required |
|---|---|---|---|
| `ADHD_AGENT_PROVIDER` | string | `anthropic` | Yes (has a code default of `anthropic`) |
| `ADHD_AGENT_MODEL` | string | `claude-opus-4-1` | Yes (has a code default) |
| `ADHD_AGENT_CONTEXT_LIMIT` | number | `0` (default, disabled) | No |
| `ADHD_AGENT_ANTHROPIC_SECRET` | string | `sk-ant-oat...` or `sk-ant-api...` | If provider type=`anthropic` (`config.ts` `PROVIDER_DEFAULTS`) |
| `ADHD_AGENT_OPENAI_SECRET` | string | (credential) | If provider type=`openai` (also covers OpenAI-compatible endpoints) |
| `ADHD_AGENT_DEEPSEEK_SECRET` | string | (credential) | Only if an `openai`-type agent explicitly overrides `env.secret`/`env.base_url` to point at DeepSeek — there is no separate `"deepseek"` provider type |

**Not real:** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `GOOGLE_API_KEY` (bare SDK-style names) are never read by this codebase — only the `ADHD_AGENT_<PROVIDER>_SECRET` names above are resolved, and only via `process.env` directly (see "Provider credentials are excluded from the config cascade" below). There is no Gemini support (`GOOGLE_API_KEY` implies a provider that does not exist in code).

**Provider credentials are excluded from the `@adhd/environment` config cascade.** `AgentMcpConfig` (`src/config.ts`) declares `db`, `logging`, `queue`, `server`, `transport`, `sse`, `plugins`, and `nativeTooling` as cascade-managed fields — no `providers`/secret field exists. Provider credentials resolve exclusively from `process.env` on the running server process, at agent-construction time, never from a config file layer (global/project/namespace). This repo's own `.mcp.json` entry for `agent-mcp` does not forward any `ADHD_AGENT_<PROVIDER>_SECRET` today — tracked as backlog `agent-mcp-001`.

### Configuration: Tracing (default-on, typed config)

**Log tree (c536ce29):** `agentMcpEnvironmentSpec.dirs` declares `logs` and `temp`, both `scope:'global'` + `share:'shared'` (the `logs`/`temp` kind default is per-instance, and `instanceId` is regenerated every start, so the default would mint an unbounded new tree per restart; the instance lives in file names instead). `resolveLogRoots()` returns `{root, api, ops, trace, temp}` from `operationalEnv` — never hard-code a log or scratch path, never use `os.tmpdir()`/`homedir()` for state. `logging.*` keys (`ADHD_AGENT_LOGGING_*`, see README "Log tree") are values with defaults; the only off-switch is `logging.api=off` (raw API bodies only; ops and trace stay on). Proven by `src/__tests__/wirelog-paths.test.ts`. Parallel-process safe by design (ADR-0012): each process writes only its own pid-named files.

`@adhd/agent-plugin-tracing` is a default plugin (`defaultPluginEntries()` in `src/config.ts`), loaded through the single default-plugin seam `src/plugins/load-defaults.ts`. Typed `tracing` config block (values only; **no enable/disable field or env var exists**): `tracing.service` (`ADHD_AGENT_TRACING_SERVICE`, default `agent-mcp`), `tracing.logSink` (`ADHD_AGENT_TRACING_LOG_SINK`, `file|stderr|none`, default `file`), `tracing.logDir` (`ADHD_AGENT_TRACING_LOG_DIR`, unset in the FieldSpec; `defaultPluginEntries()` passes `<logs>/trace` = `~/.adhd/agent-mcp/<ns>/logs/trace` unless set — c536ce29), `tracing.captureArgs` (`ADHD_AGENT_TRACING_CAPTURE_ARGS`, default `false`). Absent block ⇒ loaded with these defaults; invalid block ⇒ the loader skips the plugin and logs `Plugin config failed schema validation`. `ADHD_AGENT_DISABLE_BUDGET_PLUGIN` affects only the budget plugin. The plugin reuses an already-initialised `@adhd/sox-telemetry` provider rather than initialising a second one. Verify a sink with `scripts/audit_tracing.py`. Proven by `src/__tests__/tracing-default-load.test.ts` (unit) and `src/__tests__/integration/tracing-e2e.e2e.test.ts` (built server + real sink).

### Configuration: Native tooling environment variables

The typed `nativeTooling` surface (ADR-0008 D10) is part of the `@adhd/environment` cascade. Each leaf has an explicit `ADHD_AGENT_NATIVE_TOOLING_*` env name (values, never feature switches — a member is disabled by setting it to `false` on the definition):

| Variable | Type | Purpose |
|---|---|---|
| `ADHD_AGENT_NATIVE_TOOLING_FS_ROOT` | path | fs root; unset ⇒ dispatching cwd at task time |
| `ADHD_AGENT_NATIVE_TOOLING_FS_READ_ONLY` | bool | reserved — enforced via `srt`/Docker, not a stdio flag |
| `ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_TOOLS` | csv | fs tool-name allowlist |
| `ADHD_AGENT_NATIVE_TOOLING_FS_DISALLOWED_TOOLS` | csv | fs tool-name denylist (wins) |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ROOT` | path | shell working directory; unset ⇒ dispatching cwd |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ALLOW_COMMANDS` | csv | command NAMES accepted by the adopted argv-allowlist server |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ALLOW_PATTERNS` | csv | regex patterns (`re.fullmatch` over the command NAME) accepted by the adopted server, OR'd with `…_ALLOW_COMMANDS` |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_TIMEOUT_MS` | int | default command timeout (ms) |
| `ADHD_AGENT_NATIVE_TOOLING_DISPATCH_ALLOWED_TOOLS` | csv | dispatch (agent-mcp self) tool-name allowlist |
| `ADHD_AGENT_NATIVE_TOOLING_DISPATCH_DISALLOWED_TOOLS` | csv | dispatch tool-name denylist (wins) |
| `ADHD_AGENT_NATIVE_TOOLING_HITL` | bool | HITL enablement; default `true` |

The rule map (`nativeTooling.*.permissions`) and `shell.env` are JSON objects with no flat `FieldSpec`, so they are authored on the agent definition, not set via env. The removed authored-shell-server path override is dead: `tools/mcp-shell/server.mjs` was deleted by NAT-TOOL-4 and shell configuration is `nativeTooling.shell.*`.

### Database

- **Location:** zero-config default under the resolved scope root (never the repo tree), configurable via `ADHD_AGENT_DATABASE_PATH` (`src/config.ts` `"db.path"` field — falls back to `env.files.db` when unset)
- **Tables:** `agents`, `sessions`, `messages`, `task_usage`, `migrations`
- **Persistence:** All agents, conversations, and usage records persist across server restarts
- **Migration:** `npm run db:migrate` (drizzle-kit auto-applied on server start as of 2.0.2). On boot the server also runs a one-time flat→namespaced legacy migration that copies rows from `~/.adhd/agent-mcp/agents.db` into the resolved store. Set `ADHD_AGENT_SKIP_LEGACY_MIGRATION=true` (config field `db.skipLegacyMigration`) to skip it entirely — the flat legacy store is then never read. Intended for hermetic test harnesses so a fresh scratch DB is not seeded from a developer's real store; normal servers should leave it unset.

### Providers (Supported Models)

There are exactly three provider `type`s in code (`packages/agent/agent-engine-orchestrator/src/validation/agent.ts`: `anthropicProviderSchema`, `openaiProviderSchema`, `claudecliProviderSchema`). "DeepSeek" and "Gemini" are **not** separate provider types:

| Provider `type` | Models | Notes |
|---|---|---|
| `anthropic` | claude-opus-4-1, claude-sonnet-4 | Full JSON-schema tool support; cache-aware usage reporting; credential via `ADHD_AGENT_ANTHROPIC_SECRET` |
| `openai` | gpt-4-turbo, gpt-4o, gpt-4o-mini, and any OpenAI-compatible model (e.g. DeepSeek's `deepseek-v4-flash`/`deepseek-v4-pro` via an explicit `env.base_url` override) | Full JSON-schema tool support; cache-aware usage reporting (2.0.2+); credential via `ADHD_AGENT_OPENAI_SECRET` (or `ADHD_AGENT_DEEPSEEK_SECRET` when overridden for DeepSeek) |
| `claudecli` | Whatever the host's authenticated `claude` CLI supports | Subprocess-based; needs no provider-credential env var at all |

**Not shipped:** a dedicated `"deepseek"` provider type, and Gemini support in any form (no provider adapter, no `GOOGLE_API_KEY`/credential path, no model recognized). Prior versions of this document listed both as supported; they were not verified against code and are corrected here.

### Provider fields accepted by `agent_create` / `agent_update`

`provider` is a discriminated union on `type` (`anthropic` | `openai` | `claudecli`). Besides `model`, `env`, `temperature`, `maxTokens`, `timeoutMs` (and `baseURL` for `openai`, `claudePath`/`allowedBuiltinTools`/`systemPromptIsAgentSpec` for `claudecli`), every variant accepts the provider-failure fields:

| Field | Type | Meaning |
|---|---|---|
| `models` | `string[]` | Ordered fallback list of canonical model ids (e.g. `claude_sonnet_4_6`); tried in order when the primary model's attempt fails. |
| `billingScope` | `string` | Operator-set id shared by every key under one spend limit (e.g. an org/project id). Becomes the credential scope; absent means the key itself is the scope. |
| `tripwire` | `{ baseMs?, maxMs?, probeLeaseMs? }` (positive integers, ms) | Tripwire tuning: `baseMs` overrides the per-class cooldown base, `maxMs` caps the cooldown (default 15 minutes), `probeLeaseMs` is the half-open probe lease (default 120000). Typed config, never env. |
| `retryConfig.retryWindowMs` | positive integer, ms | Added to `retryConfig` (`retries`, `minTimeout`, `maxTimeout`, `factor`, `retryWindowMs`). Bounds only *starting* a new attempt and backoff sleeps, never an in-flight healthy attempt. Default 120000. |

`models`, `billingScope`, `tripwire`, and `retryConfig` are valid on `anthropic` and `openai`; `claudecli` accepts `models`, `billingScope`, and `tripwire`.

**Strict input.** `agent_create` and `agent_update` reject unknown keys, in `provider` and in the `agent_update` `patch`, with a validation error rather than silently dropping them, so a typo can never be lost. Stored rows are read leniently so older definitions always load.

**Legacy credential keys are accepted on input.** `apiKeyEnv` and `authTokenEnv` on a `provider` are mapped to `env.secret` (an explicit `env.secret` wins) and then validated like any other input, exactly as stored rows have always been normalized on read. An `agent_read` -> `agent_update` round trip of an existing definition therefore needs no rewriting. The legacy keys are not part of the advertised schema; prefer `env.secret` in new definitions. Any other unknown key is still rejected.

### Token Accounting (2.0.2 Changes)

**New fields in `task_usage` response:**

```json
{
  "inputTokens": 715316,              // cumulative across all model calls
  "peakContextTokens": 43187,         // max prompt size in any single call (NEW 2.0.2)
  "cacheReadTokens": 525056,          // cache-hit tokens (provider-dependent; 2.0.2+)
  "uncachedInputTokens": 190260,      // full-price tokens (provider-dependent; 2.0.2+)
  "cacheCreationTokens": 0,           // Anthropic cache-write surcharge, if any (2.0.2+)
  "reasoningTokens": 2101,            // inference tokens from reasoning-capable models (2.0.2+)
  "outputTokens": 7370                // generation tokens
}
```

**Breaking change:** Code that interpreted `inputTokens` as "max context size" must now use `peakContextTokens` for that purpose.

### Context Management (2.0.2 Changes)

**Default behavior:** `ADHD_AGENT_CONTEXT_LIMIT=0` (disabled). No automatic message eviction.

**If limit is enabled** (limit > 0):
- Messages are kept append-only until the provider's actual `prompt_tokens` approaches the limit
- When triggered, the **middle** of the conversation is collapsed into a synthetic summary message, exactly once
- The leading prefix (system + early context) is never mutated; this preserves provider-side prefix caching

**Prior behavior (2.0.0-2.0.1):** Evicted from the front on every threshold crossing, destroying cache hits (measured: 3.3x cost inflation).

### Tool Advertisement (2.0.2 Changes)

**Default:** Full JSON-Schema function-calling for all non-claudecli providers.

**Alternative:** Set `toolAdvertisement: 'names'` on agent creation to use name-only tools (with prose descriptions in system message).

**Prior behavior (2.0.0-2.0.1):** Silently defaulted to name-only for all non-claudecli agents, breaking provider-side tool-call validation.

### Native web tools (default toolset, 1abd2d84)

For a provider that supports server-executed tools (currently Anthropic),
every dispatched agent advertises `web_search` and `web_fetch` by default, so
it can run a real web search/fetch without any client-side executor. The tools
are emitted as type-tagged entries (`{ type: 'web_search_20250305', name:
'web_search' }`, `{ type: 'web_fetch_20250910', name: 'web_fetch' }`) and
executed by the provider. Set `nativeWebTools: false` on the agent definition
to opt out. Providers without native web tools (openai/claudecli) are
unaffected.

### Native tooling for dispatched agents (ADR-0008 / NAT-TOOL-4/6)

Every dispatched agent inherits a standardized, **portable** native toolset described by
`AgentDefinition.nativeTooling` (`{ fs?, shell?, dispatch?, hitl? }`) and resolved by
`resolveNativeTooling`/`resolveNativeToolingMap` (`@adhd/agent-core-native-tooling`) at
**task time** against the dispatching cwd — never baked into the stored definition
(ADR-0008 D4). Merge precedence, highest first: explicit `mcpServers` > `nativeTooling` >
the `dispatch` self floor.

| member | default | resolved server (adopted) |
|---|---|---|
| `fs` | on | `srt node <pinned server-filesystem bin> <cwd>` (pinned dependency, no `npx`) |
| `shell` | on | `srt uvx --from mcp-shell-server==1.1.12 mcp-shell-server` (allowlisted argv — never a shell string) |
| `dispatch` | on | the REAL agent-mcp server (`agent-mcp`), handled in-process — never a wrapper |
| `hitl` | `true` | HITL enablement; `false` hides `request_human_input` (ADR-0008 D6) |

- **ONE producer.** The fs/shell launch commands live only in the
  `@adhd/agent-core-native-tooling` catalog; `resolveNativeTooling` (array) and
  `resolveNativeToolingMap` (keyed `mcpServers` map) are two projections of the same
  computation, and no host hand-builds a second fs/shell server (NAT-TOOL-4 AC6).
- **Multi-root, portable fs roots + caller-supplied cwd (ADR-0008 D4/D7/D8).**
  `nativeTooling.fs.root`/`roots` are **portable hints** — a cwd-relative subpath
  or a named alias into the GLOBAL allowed-root map — never an absolute host path
  (which is rejected with a typed `NativeToolingRootError`; the fs analogue of the
  welded-`provider` bug). The global map (`ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_ROOTS`
  / global `config.yaml`, `alias=absolute-path`) is the machine-specific,
  operator-owned surface; an agent references `project`/`tmp` portably. The
  **caller cwd** enters via a `cwd` on the `task`/`agent` MCP input, is inherited by
  a sub-dispatch (`ExecutionContext.cwd`), and falls back to the host `process.cwd()`
  only when absent (flagged). Every RESOLVED root is unioned into the per-run `srt`
  policy's `allowWrite` (else a 2nd root is sandbox-denied).
- **The permission / HITL gate is ENFORCED (NAT-TOOL-6).** The host injects
  `defaultPermissionGate` (`src/defaults.ts`, wired in `src/config.ts` `toEngineConfig()`);
  the engine evaluates it **before** `pre:tool_call` for every native tool call.
  `deny` → typed `PERMISSION_DENIED`, tool not executed; `ask` → the fixed chain
  `suspend → escalate → deny` (`hitl:false` prunes suspend; no parent ⇒ deny). Rules match
  the server-qualified **tool name** (`<server>.<tool>`), last-match-wins with `deny`
  terminal. `agent-mcp` owns no command parser and no dangerous-command catalog (D5).
- The `fs`/`shell` builtins are wrapped by `@anthropic-ai/sandbox-runtime` (`srt`) by default
  (ADR-0008 D7). The host provisions a STATIC global policy plus a PER-RUN policy that carries
  the dispatching cwd and is passed via `srt -s` (`src/srt-policy.ts`; deferral `a5a2f1d4`),
  so the shared `~/.srt-settings.json` never accumulates a per-spawn path and the RMW is
  concurrency-safe (`ADHD_AGENT_SRT_SETTINGS` overrides the per-run settings path).
  The static policy also carries a DEFAULT `filesystem.denyRead` of the credential paths
  `~/.npmrc ~/.ssh ~/.aws ~/.config/gh ~/.netrc` (home-expanded `DEFAULT_SRT_DENY_READ` /
  `defaultSrtDenyRead()`), UNIONED into any user `denyRead` — user entries are preserved
  and de-duplicated, never clobbered (shell-policy S4 / AC7).
- The server-wide `nativeTooling` config surface (`env.config.nativeTooling`, the
  `ADHD_AGENT_NATIVE_TOOLING_*` env vars) is merged **beneath** each agent's own
  `def.nativeTooling` at task time — the agent wins, and the merged value is carried on the
  task-time definition — so the typed config surface is not inert.
- `nativeTooling` is PORTABLE: the same stored definition fired from `/P` then `/Q` yields
  fs root `/P` then `/Q` while the stored JSON stays byte-identical (D4). Resolution never
  mutates the stored definition.
- A definition with no `nativeTooling` behaves as the standardized defaults (D1/D8); any
  member set to `false` is omitted.
- An explicit `mcpServers` entry is preserved and WINS over `nativeTooling` for a shared
  name. `allowedTools`/`disallowedTools` remain enforced by `McpClientRegistry` at every
  `callTool`, exactly as for operator-authored servers.

The authored `tools/mcp-shell/server.mjs` thick layer was **removed** by NAT-TOOL-4 (ADR-0008
D5/D7); the adopted `tumf/mcp-shell-server` (`uvx mcp-shell-server`) replaces it.

### Delegation (Agent → Child Agent)

An agent can delegate to child agents by calling the `task` tool targeting another agent (when allowed by parent policy). Child agents:
- Have reduced token/cost budgets
- Have restricted tool and filesystem access (subset of parent)
- Cannot delegate further if `maxDelegationDepth` is reached
- Are supervised by the same SQLite database and policy engine

## Local dev server (`serve`, live reload)

A long-running local server over the streamable-HTTP transport that restarts itself whenever the
built `dist/` changes. It never builds and never touches any MCP client config.

```bash
npx nx run agent-mcp:serve                       # foreground supervisor (default port 47821); Ctrl-C stops it
AGENT_MCP_SERVE_PORT=47822 npx nx run agent-mcp:serve   # other port (or: node entrypoint/agent-mcp/scripts/serve.mjs run --port=47822)
npx nx run agent-mcp:serve-status                # exit 0 = running, 3 = not running
npx nx run agent-mcp:serve-stop                  # SIGTERM the supervisor and its server
```

- Waits for `entrypoint/agent-mcp/dist/src/index.js` + `dist/package.json` (build with `npx nx affected -t build` / `agent-mcp:dist-manifest`); restarts (SIGTERM, then start) once `dist/` has been unchanged for 3s after any change (polled every 2s; `AGENT_MCP_SERVE_STABLE_MS`, `AGENT_MCP_SERVE_POLL_MS`).
- URL `http://127.0.0.1:<port>/` (any path). Real `ADHD_AGENT_*` env/DB/registry paths pass through unchanged; `ADHD_AGENT_SSE_HOST` defaults to `127.0.0.1`.
- pid and log: `tmp/agent-mcp/serve/serve-<port>.{pid,log}` (gitignored). A second `scripts/serve.mjs run` for the same port reports the running one instead of starting another.
- The http transport serves many concurrent MCP sessions; after a reload the old `mcp-session-id` gets HTTP 404 and the client must re-initialize.
- Nx serializes a task across processes: while `serve` runs, a second `nx run agent-mcp:serve` waits ("Waiting for agent-mcp:serve in another nx process"). Use `serve-status`, or call `node entrypoint/agent-mcp/scripts/serve.mjs run` for the report-and-exit behaviour.
- The MCP HTTP listener binds `ADHD_AGENT_HOST` (default `127.0.0.1`); the SSE/gateway listener binds `ADHD_AGENT_SSE_HOST` (default `127.0.0.1`).
- `serve-status` / `serve-stop` read `AGENT_MCP_SERVE_PORT`; unset, they target 47821.
- `dist/package.json` comes from `agent-mcp:dist-manifest`, not `build` (backlog 91601303).
- Isolation for a throwaway: set `ADHD_AGENT_DATABASE_PATH`, `ADHD_AGENT_REGISTRY_DB_PATH` (the DB path variable does not redirect the registry DB, backlog 243002e0) and `ADHD_AGENT_SKIP_LEGACY_MIGRATION=true` (otherwise a new DB is seeded from the legacy `~/.adhd/agent-mcp/agents.db`). Process env beats `.env` files; the supervisor starts the server with `cwd` = checkout root.
- A reload SIGTERMs the server without draining the queue; in-flight tasks can be cut (backlog 2353c2cc).
- Local-testing procedure (MCP client calls, usage fields, tool advertisement, shell-policy PATH requirements): [docs/dev-server-local-testing.md](./docs/dev-server-local-testing.md). e2e is CI-only locally (backlog 8963c3cb).

## Live tests (env-gated — paid model)

Three integration tests call a **real paid model** and are gated behind env flags
(`AGENT_MCP_LIVE=1`, `AGENT_MCP_BUDGET_LIVE=1`) — the sole gate reason AGENTS.md §7
permits. **Approved by:** pseudosky (repo owner). Gated files:
`live-budget.e2e.test.ts`, `live-dag.e2e.test.ts`, `live-oauth.e2e.test.ts`. The gate
reason is that a real model is a paid third-party service; skipping it in CI saves money
and avoids an outside system. The same record is in this package's `README.md` and each
test's header.

## Native-tooling adoption gate (env-gated — external third-party server)

The ADR-0008 D7 upstream-server adoption is a **human-gated** decision
(NAT-TOOL-8). The tests that prove the adopted servers start and execute
through the real `agent_verify_mcp` handshake are gated behind `NAT_TOOL_LIVE=1`
(the qualifying reason: real external third-party services CI cannot provide
hermetically):

| Test file | Gate | Real dependency |
|---|---|---|
| `src/__tests__/integration/native-tooling-adoption.e2e.test.ts` | `NAT_TOOL_LIVE=1` | `uvx mcp-shell-server` (external PyPI package) + `srt` |
| `src/__tests__/integration/native-tooling-real-ops.e2e.test.ts` | `NAT_TOOL_LIVE=1` | `uvx mcp-shell-server` (external PyPI package) + `srt` |
| `src/__tests__/integration/agent-portability-live.e2e.test.ts` | `NAT_TOOL_LIVE=1` | paid DeepSeek model (`ADHD_AGENT_DEEPSEEK_SECRET`); owner pseudosky, $0.05 cap (dispatch-2026-10-06-48dc). The non-model portability matrix (`agent-portability.e2e.test.ts`) is NOT gated. |

These live tests are **off by default** (they skip unless `NAT_TOOL_LIVE=1`) and are not
run by the pre-push hook; CI's `e2e` lane runs them skipped. The table above is
machine-checked against the files that actually gate on `NAT_TOOL_LIVE`
(`tools/nx-plugins/test/executors/wiring/nat-tool-live-docs.spec.mjs`): add a gated file
without a row here and that spec goes red.

**Approved by:** pseudosky (repo owner), 2026-10-05, under the owner directive
"Finish the project". **Adopted set:** `@modelcontextprotocol/server-filesystem`,
`tumf/mcp-shell-server`, `@anthropic-ai/sandbox-runtime` (`srt`, wraps both);
`unbash` dropped, `rust-mcp-filesystem` deferred. The resolver emits the adopted,
`srt`-wrapped builtins (`@adhd/agent-core-native-tooling`); the default
(unflagged) suite proves the resolved shape and the `agent_verify_mcp` path with
no external fetch. The same record is in this package's `README.md`, in
`@adhd/agent-core-native-tooling`'s `README.md`/`AGENTS.md`, and in the test's header.

## Known Limitations (as of 2.0.2)

| Limitation | Status | Impact |
|---|---|---|
| No OS-level sandboxing | By design | Filesystem/network enforcement is policy-based, not OS-based |
| No external security audit | Incomplete | Treat as experimental/research-grade |
| Single-user isolation | By design | All MCP clients share the same agent database and access all agents |
| Prompt injection not mitigated | By design | Tool filtering is guidance; creative prompts may bypass it |
| Experimental state recovery | Partial | Assume data loss on ungraceful shutdown |
| No multi-provider per-agent | By design | One provider per agent; agent-mcp server-wide provider is the default |
| No agent-specific timeouts | Not implemented | Uses server-wide `maxToolLoops` only |

## Roadmap Items (Not Shipped)

These are not yet implemented:

- Per-agent provider selection (currently server-wide)
- per-agent-specific request timeouts (independent of maxToolLoops)
- Runtime budget monitoring API (only stored after task completion)
- Agent state snapshots / recovery on host crash
- Multi-user isolation (per-API-key access control)
- OS-level sandboxing (container, seccomp, pledge/unveil)
- External security audit and compliance matrix

Do not document these as shipped features.

## Dependencies

### Runtime (Required)

- `@adhd/agent-engine-orchestrator` — orchestration engine
- `@adhd/agent-store-runtime` — state persistence
- `@adhd/agent-plugin-tracing` — default-loaded tracing plugin (spans + metrics into `@adhd/sox-telemetry`)
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `drizzle-orm`, `better-sqlite3` — database access
- `pino` — logging
- `zod` — validation

### Build/Test

- TypeScript, Vite, ESLint (standard monorepo tooling)

## Database Migrations

As of 2.0.2, two migrations are required:

- **0008:** Adds `peak_context_tokens`, `peak_context_at`, and cache/reasoning fields to `task_usage` table
- **0009:** Restores `sessions.agent_name → agents.name ON DELETE CASCADE` foreign-key constraint

Migration is auto-applied on server start.

## Example Usage (Fact-Based)

When an MCP client sends:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent_create",
  "params": {
    "name": "research-agent",
    "config": {
      "provider": "anthropic",
      "model": "claude-opus-4-1",
      "tools": {
        "allow": ["filesystem__read_text_file", "filesystem__read_dir"]
      },
      "filesystem": {
        "read": ["/Users/me/code"]
      }
    }
  }
}
```

The server:
1. Validates `config` against the schema
2. Checks the env-name guard (any `provider.env` keys must be `ADHD_AGENT_` prefixed; NEW in 2.0.2)
3. Creates a row in the `agents` table
4. Returns `{agentId: "research-agent"}`

When the client sends:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "task",
  "params": {
    "agentName": "research-agent",
    "prompt": "Find all TypeScript files in /Users/me/code"
  }
}
```

The server:
1. Fetches the agent config and prior session history
2. Constructs a message list: `[system_prompt, prior_messages..., new_user_message]`
3. Calls `provider.chat({model: "claude-opus-4-1", messages, tools})`
4. If the model returns tool calls, executes them (respecting the `allow` filter)
5. Appends tool results and repeats (up to 50 loops)
6. When the model stops tool-calling, records the task in `task_usage` with token counts
7. Returns `{taskId, status, result, usage}`

All data persists in SQLite; the client can later call `result(taskId)` to retrieve the task's result or `usage_query()` to retrieve token usage.

## Verifiable Claims

Every claim in this document is tied to:

- **Code:** Method exists in `src/` and is called by the MCP transport layer
- **Tests:** Behavior is tested in `src/__tests__/`
- **Database:** Schema fields exist and are persisted
- **BACKLOG:** Bugs and fixes are logged with receipts (BUG-ORCH-003 through BUG-ORCH-014)
- **Research docs:** `docs/ideas/` contain wire-trace evidence for 2.0.2 changes

Do not present this document as aspirational. All features are currently shipped.

## Provider selection (D-G(2))

An agent's `provider` is optional. Each task resolves ONE provider from the chain `task > session > agent > host default`
(per field, first tier wins; a tier naming a different provider type is skipped). The host default is
`ADHD_AGENT_DEFAULT_PROVIDER` (`anthropic|openai|claudecli`) + `ADHD_AGENT_DEFAULT_MODEL`, both unset by default. If no tier
supplies a provider and a model the task fails closed with `NO_PROVIDER_SELECTED` — there is no implicit `claudecli`.
A canonical model ref resolves to the provider-native wire string through the provider registry (seeded at startup).
