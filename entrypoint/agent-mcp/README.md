# @adhd/agent-mcp

An MCP (Model Context Protocol) server exposing a bounded, supervised agent runtime. This package serves as the public protocol interface to the agent framework, enabling MCP clients to create, monitor, and control child agents running within enforced resource and permission boundaries.

## What is this?

`@adhd/agent-mcp` is an MCP server that:

- **Runs agents as stateful processes** — each agent maintains conversation history, executes tools, and interacts with model providers (Anthropic, OpenAI, and OpenAI-compatible endpoints such as DeepSeek via an explicit `baseURL` override — see [Providers and credentials](#providers-and-credentials) below)
- **Enforces runtime policies** — maximum delegation depth, token/cost budgets, filesystem scope, optional shell network allowlist (`agent.shell.sandbox.allowedDomains`; egress is open by default), tool deny/allow filters
- **Persists state locally** — SQLite-backed storage for agents, sessions, messages, and execution traces
- **Exposes a tool-call interface** — MCP clients call tools like `agent_create`, `task`, `result`, `task_cancel` to interact with the runtime
- **Supports multi-turn delegation** — parent agents can spawn child agents with subset-of-parent permissions

## Quick start

### Installation

```bash
npm install -g @adhd/agent-mcp
```

### Run as an MCP server

```bash
agent-mcp
```

This starts a JSON-RPC server over stdio. Configure in your MCP host (e.g., Claude's `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "agent-mcp": {
      "command": "agent-mcp",
      "env": {
        "ADHD_AGENT_PROVIDER": "anthropic",
        "ADHD_AGENT_MODEL": "claude-opus-4-1",
        "ADHD_AGENT_CONTEXT_LIMIT": "0"
      }
    }
  }
}
```

### Configuration: Zero-Config with Optional Overrides

`@adhd/agent-mcp` is designed for **zero-config startup** — every setting has a built-in default and the server runs immediately without files or env vars. Configuration is resolved via the `@adhd/environment` cascade:

| Layer | Source | Overrides |
|---|---|---|
| **Code defaults** | Built into `src/config.ts` | all others below |
| **Global config** | `~/.adhd/agent-mcp/config.yaml` | project/env |
| **Project config** | `./.adhd/agent-mcp/config.yaml` | env only |
| **Environment variables** | `ADHD_AGENT_*` names | none |

The database (SQLite, agents/sessions/messages/usage) is the **production store** unless you point elsewhere: `~/.adhd/agent-mcp/production/data/agents.db` (never the repo tree). The same store is used no matter which directory the server is launched from. A development database is just an explicit **absolute** `ADHD_AGENT_DATABASE_PATH` outside that directory; there is no mode switch. Resolution order: `ADHD_AGENT_DATABASE_PATH` in the process environment (or in `~/.adhd/.env`) > `db.path` in `~/.adhd/agent-mcp/production/config.yaml` > the production default. A relative path in the process environment is rejected at startup; a relative path in a config file is anchored to that file's directory, never to the launch directory. A `.env` found in the launch directory (`<cwd>/.env`, `<cwd>/.adhd/.env`) cannot select the store: such an assignment is ignored and a warning names the file. Every start logs one line, `store=<absolute path> mode=<production|custom> source=<env|cascade|default>` (`mode` is derived from the path, never configured). Any store may be opened by several agent-mcp processes at once (parallel-process enabled, ADR-0012).

### Common environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ADHD_AGENT_PROVIDER` | `anthropic` | Provider *type* for the server-wide default agent: `anthropic`, `openai`, or `claudecli` (see [Providers and credentials](#providers-and-credentials)) |
| `ADHD_AGENT_MODEL` | `claude-opus-4-1` | Model identifier for the provider |
| `ADHD_AGENT_CONTEXT_LIMIT` | `0` | Max context size in tokens; 0 = no limit (enforce only at provider ceiling) |
| `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | Max tool-call iterations per task |
| `ADHD_AGENT_TOOL_CALL_CONCURRENCY` | `8` | Max tool calls of one assistant turn run concurrently (config key `agent.toolCallConcurrency`); calls beyond the limit wait and results keep call order; must be a positive integer, invalid values fail at startup with a `RangeError` |
| `ADHD_AGENT_TOOL_RESULT_MAX_CHARS` | `6000` | Max chars of one tool result the model sees (first 75% + marker + last 25%); `0` disables; invalid values fail at startup. See [logging.md](docs/logging.md#tool-result-size-cap-what-the-model-sees-vs-what-telemetry-measures) |
| `ADHD_AGENT_TOOL_RESULT_SPILL_ENABLED` | `false` | Opt in to spilling an over-cap tool result to a file (the model sees a stub with the path and a 2000-char preview) instead of dropping its middle. Sibling keys: `ADHD_AGENT_TOOL_RESULT_SPILL_DIR` (absolute; default `<temp>/tool-results`), `ADHD_AGENT_TOOL_RESULT_SPILL_TTL_HOURS` (`24`). See [logging.md](docs/logging.md#optional-spill-to-file-for-over-cap-tool-results) |
| `ADHD_AGENT_MAX_DEPTH` | `3` | Max delegation depth (agent → child → grandchild) |
| `ADHD_AGENT_DATABASE_PATH` | (auto-resolved) | Absolute path of a custom SQLite DB (a relative value is rejected at startup); unset = the production store `~/.adhd/agent-mcp/production/data/agents.db` |
| `ADHD_AGENT_TRANSPORT` | `stdio` | `stdio` or `http` (streamable HTTP). The `http` transport serves **many concurrent MCP sessions** from one process: each `initialize` opens its own session (routed by the `mcp-session-id` header); an unknown/expired session id gets HTTP 404 so the client re-initializes |
| `ADHD_AGENT_PORT` | `3000` | Port for the `http` transport |
| `ADHD_AGENT_HOST` | `127.0.0.1` | Interface the `http` transport binds. **Loopback by default** because the MCP surface is unauthenticated; set e.g. `0.0.0.0` explicitly to expose it to the network (the server then logs a `non-loopback` warning at startup; an empty value is treated as unset, never as "all interfaces"). Releases through 2.3.6 had no host default and bound every interface; fixed after 2.3.6 |
| `ADHD_AGENT_SSE_PORT` | per-instance derived (explicit value honored) | Port the SSE / OpenAI-compat gateway tries first. If it is taken (concurrent instances are normal), the server falls back to an OS-assigned port **and logs one structured line** (`event: "sse.listening"` with `requestedPort`, `port`, `fellBack`, `streamBaseUrl`); task responses' `stream_url` always carries the bound port |
| `ADHD_AGENT_SSE_HOST` | `127.0.0.1` | Interface the SSE / gateway server binds (loopback by default; explicit opt-in to bind elsewhere, which logs the same `non-loopback` warning) |

### Tracing (default-on, typed config, no toggle)

`@adhd/agent-plugin-tracing` is loaded by default alongside the budget plugin: every session, task, model call, tool call, permission decision and HITL suspend/resume becomes a durable span in `@adhd/sox-telemetry`'s JSONL sink (default `~/.adhd/agent-mcp/<namespace>/logs/trace`, resolved through `@adhd/environment`; releases before this change wrote to `~/.adhd/sox-ecosystem/agent-mcp/logs`, so a reader of the old path must now set `ADHD_AGENT_TRACING_LOG_DIR`). There is **no enable/disable switch** — an absent `tracing` block still loads the plugin with defaults; an invalid block makes the loader skip it and log why. If the process already initialised a telemetry provider (an embedding host, apigen's tracing layer), the plugin reuses it instead of provisioning a second one.

| Config key | Env var | Default | Purpose |
|---|---|---|---|
| `tracing.service` | `ADHD_AGENT_TRACING_SERVICE` | `agent-mcp` | Telemetry `service` resource attribute |
| `tracing.logSink` | `ADHD_AGENT_TRACING_LOG_SINK` | `file` | `file` / `stderr` / `none` |
| `tracing.logDir` | `ADHD_AGENT_TRACING_LOG_DIR` | `<logs>/trace` = `~/.adhd/agent-mcp/<namespace>/logs/trace` | File-sink directory |
| `tracing.captureArgs` | `ADHD_AGENT_TRACING_CAPTURE_ARGS` | `false` | Record truncated tool arguments (else only a sha256 digest) |

### Log tree and `logging.*` config (backlog c536ce29)

All agent-mcp logs live under ONE environment-resolved root, `<logs>` = `~/.adhd/agent-mcp/<namespace>/logs` (the `logs` dir of `agentMcpEnvironmentSpec`, pinned `scope: global` so `ADHD_ENV_SCOPE=project` never moves it into a repo, and `share: shared` so a restart does not create a new tree; the process instance is part of every FILE NAME instead: `<date>.<instanceLabel>.<pid>.jsonl`). Layout: `<logs>/api/` (raw wire records), `<logs>/ops/` (structured core-ops events), `<logs>/trace/` (spans, the `tracing.logDir` default). Claudecli scratch files use `~/.adhd/agent-mcp/<namespace>/temp/`. Resolve them in code with `resolveLogRoots()` (`src/config.ts`), never by hand-building a path.

| Config key | Env var | Default | Purpose |
|---|---|---|---|
| `logging.dir` | `ADHD_AGENT_LOGGING_DIR` | unset (`<logs>`) | Explicit override of the log root |
| `logging.instanceLabel` | `ADHD_AGENT_LOGGING_INSTANCE_LABEL` | `default` | Stable label in log file names (`[A-Za-z0-9._-]{1,64}`); the generated instanceId changes on every start |
| `logging.api` | `ADHD_AGENT_LOGGING_API` | `on` | `on` / `off`. `off` stops ONLY raw API body capture under `api/`; ops and trace logs stay on |
| `logging.apiBodyMaxBytes` | `ADHD_AGENT_LOGGING_API_BODY_MAX_BYTES` | `4194304` | Per-body capture cap (sha256 of the full body is kept) |
| `logging.apiRotateBytes` | `ADHD_AGENT_LOGGING_API_ROTATE_BYTES` | `67108864` | api/ rotation size (rotated files gzipped) |
| `logging.apiRetentionDays` | `ADHD_AGENT_LOGGING_API_RETENTION_DAYS` | `14` | api/ age retention |
| `logging.apiMaxDirBytes` | `ADHD_AGENT_LOGGING_API_MAX_DIR_BYTES` | `2147483648` | api/ total size cap |
| `logging.opsRotateBytes` | `ADHD_AGENT_LOGGING_OPS_ROTATE_BYTES` | `16777216` | ops/ rotation size |
| `logging.opsRetentionDays` | `ADHD_AGENT_LOGGING_OPS_RETENTION_DAYS` | `60` | ops/ age retention |
| `logging.opsMaxDirBytes` | `ADHD_AGENT_LOGGING_OPS_MAX_DIR_BYTES` | `268435456` | ops/ total size cap |
| `logging.traceRetentionDays` | `ADHD_AGENT_LOGGING_TRACE_RETENTION_DAYS` | `30` | trace/ age retention |
| `logging.traceMaxDirBytes` | `ADHD_AGENT_LOGGING_TRACE_MAX_DIR_BYTES` | `536870912` | trace/ total size cap |
| `logging.floodMaxBytes` | `ADHD_AGENT_LOGGING_FLOOD_MAX_BYTES` | `268435456` | Per-process api/ bytes per window before the flood breaker drops bodies (digest-only) |
| `logging.floodWindowSeconds` | `ADHD_AGENT_LOGGING_FLOOD_WINDOW_SECONDS` | `600` | Flood breaker window |

`ADHD_AGENT_LOG_LEVEL` (`logging.level`, default `info`) is unchanged. These keys are values with defaults; this section covers the configuration surface (path resolution and defaults). Record emission into `api/` and `ops/` is delivered by the wirelog package and the provider/server seams of the same backlog item.

Audit a sink with `python3 scripts/audit_tracing.py <sink-dir>`: it recomputes per-operation sample counts and durations and exits non-zero when an always-expected span path (session, task, model_call) has zero samples; `--require-all` also demands the conditional tool-call, provider-failure, budget, HITL and permission paths.

How to read, tail, query and cost-audit these logs (record shapes, correlation ids, `usage_query`, SQL, redaction, three worked traces taken from a live run): [docs/logging.md](./docs/logging.md).

## Providers and credentials

`@adhd/agent-mcp` supports three provider `type`s (`packages/agent/agent-engine-orchestrator/src/validation/agent.ts`):

| `type` | Needs a credential env var? | Notes |
|---|---|---|
| `anthropic` | Yes — `ADHD_AGENT_ANTHROPIC_SECRET` | Accepts either a `claude setup-token` OAuth token (`sk-ant-oat...`) or a console.anthropic.com API key (`sk-ant-api...`) — the provider branches on the prefix automatically. |
| `openai` | Yes — `ADHD_AGENT_OPENAI_SECRET` | Also the type to use for any OpenAI-*compatible* endpoint (e.g. DeepSeek): set `env.base_url` / `ADHD_AGENT_OPENAI_BASE_URL` to the provider's URL. DeepSeek additionally has its own default names, `ADHD_AGENT_DEEPSEEK_SECRET` / `ADHD_AGENT_DEEPSEEK_BASE_URL` / `ADHD_AGENT_DEEPSEEK_MODEL`, but they must be passed explicitly as an agent's `env.secret`/`env.base_url` override — there is no separate `"deepseek"` provider `type`. |
| `claudecli` | No | Shells out to the already-authenticated `claude` CLI on the host instead of calling an API directly — nothing to configure here. Use this to avoid provider-credential wiring entirely. |

Which engine behaviors (tool-call concurrency and its per-task limiter, token estimator, tool-result caps, EOL hook, session resume, budget pricing, `reasoningTokens`) apply to each provider, with code evidence: [docs/agent/provider-parity.md](../../docs/agent/provider-parity.md). Cost caps (`ADHD_AGENT_BUDGET_COST_USD`) price every provider from the shared model rate card; a model with no price emits a `budget:unpriced_model` task event, and a `claudecli` agent that enables CLI built-ins emits `provider:builtin_bypass` (both visible in `task_events`).

**The bare SDK-style names `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are never read anywhere in this codebase.** Only the `ADHD_AGENT_<PROVIDER>_SECRET` names above are honored.

**Gemini is not implemented.** There is no `gemini` provider `type`, no Gemini provider adapter, and no `GOOGLE_API_KEY`/Gemini credential path — despite having appeared in older versions of this document.

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

### Provider credentials are NOT declared `AgentMcpConfig` fields — but they DO resolve via a `.env` file cascade

Most of agent-mcp's configuration (`db`, `logging`, `queue`, `server`, `transport`, `sse`, `plugins`) resolves through `@adhd/environment`'s file-based cascade (code defaults → global → project → env var), documented in `src/config.ts`. Provider-credential env vars are **not** declared fields of `AgentMcpConfig` and are not part of that specific cascade — they resolve via `env.resolveEnvName()` (`packages/environment/environment-core-node/src/environment.ts:317-320`), a direct `process.env` read gated only by an `ADHD_AGENT` prefix allowlist.

Critically, `process.env` is not just "whatever the spawning process happened to set." `src/config.ts` calls `loadEnvHierarchy()` (`src/utils/load-env.ts`) unconditionally at module load, **before** the `Environment` singleton is constructed or any secret is resolved. `loadEnvHierarchy()` populates `process.env` itself, least-specific first, via `dotenv`:

1. `~/.adhd/.env` (lowest precedence)
2. `<cwd>/.adhd/.env` (beats `~/.adhd/.env`)
3. `<cwd>/.env` (beats both files above)

   The two launch-directory files (2, 3) can **never** set `ADHD_AGENT_DATABASE_PATH`: that assignment is ignored with a warning, so the store does not change with the directory the server is started from. `~/.adhd/.env` may set it; a relative value there is anchored to `~/.adhd/`.
4. **Variables already in `process.env` at launch** (highest precedence) — an explicit `ADHD_AGENT_*` value set by the spawning shell/host (e.g. `ADHD_AGENT_DATABASE_PATH`) is never overridden by any `.env` file. Files override files; no file overrides the process environment. An empty-string `ADHD_AGENT_*_SECRET` counts as unset, so a file can still supply it.

   **A dev database path must be absolute whenever it reaches the process environment, including through the repo `.env`.** `nx` loads the repo-root `.env` and exports it into every task's environment, so a relative `ADHD_AGENT_DATABASE_PATH` there (the historical value is `data/agent-mcp/agents-dev.db`) is ignored with a warning when agent-mcp's own loader reads it, but is rejected as `must be an absolute path` once `nx` has exported it. Use an absolute path (for example `/Users/you/dev/node/adhd/data/agent-mcp/agents-dev.db`) in `.env`. The repo's own gates are immune to a local `.env`: the unit lane (`vitest.setup.mjs`) drops every inherited `ADHD_AGENT_*` variable before tests load, and `verify-dist-load` loads the built entry with `ADHD_*` variables scrubbed, as a real consumer would.

So a provider secret defined in `~/.adhd/.env` resolves for **every** agent-mcp launch — regardless of what env block the spawning `.mcp.json` entry (or shell, or MCP host) forwards — because the server reads the file itself on startup. This mechanism was restored under `BUG-MCP-CREDENTIALS-001` after a prior refactor (commit `b38369f3`) deleted it; the restoration is landed in code today (`src/config.ts:27-37`, `src/utils/load-env.ts:19-37`).

Practically: as long as `~/.adhd/.env` (or a more-specific `.adhd/.env`/`.env`) defines `ADHD_AGENT_ANTHROPIC_SECRET` (or the sibling `_OPENAI_`/`_DEEPSEEK_` names) for a given provider, an `anthropic`- or `openai`-type agent resolves real credentials at task time — with **no** explicit passthrough required in `.mcp.json`'s `env` block. A `.mcp.json` entry that only forwards `ADHD_ENV_SCOPE`/`ADHD_AGENT_CONFIG`/`ADHD_AGENT_REGISTRY_DB_PATH` (as both the repo-root and global entries in this repo do) still resolves credentials fine via this fallback.

The one real remaining gap is a **data-completeness** one, not a wiring one: if none of the three `.env` files in the hierarchy defines the secret a given provider needs, `getProviderConfig` still fails with `No credential for <provider>; set ADHD_AGENT_<PROVIDER>_SECRET` — e.g. a CI runner, a different user's machine, or any environment without a populated `~/.adhd/.env`. Because the `.mcp.json` `env` block doesn't *explicitly* forward the secret, that failure mode is silent until you're on a machine without the fallback file. If you want defense-in-depth against that (rather than relying on `~/.adhd/.env` always being present), export the relevant `ADHD_AGENT_<PROVIDER>_SECRET` explicitly in the spawning shell/session, or use a `claudecli`-type agent (see the table above), which needs no credential env var at all.

Tracked as `DEBT-MCP-CREDENTIALS-001` in the backlog graph (repo `PseudoSky/adhd`; a legacy duplicate, `agent-mcp-001` under repo key `adhd`, describes the pre-fix failure mode and should be resolved/merged into this item). README staleness in the wider registry-package family is separately tracked as `DEBT-AGENTMCP-README-STALE-001`.

### Example: Create and run an agent task (via MCP client)

When connected to `agent-mcp` via MCP, call tools in sequence:

```json
// 1. Register an agent
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "agent_create",
  "params": {
    "name": "my-agent",
    "config": {
      "provider": "anthropic",
      "model": "claude-opus-4-1",
      "tools": { "allow": ["file_read", "code_execute"] },
      "filesystem": { "read": ["/Users/me/project"] }
    }
  }
}
// Returns: {"agentId": "my-agent"}

// 2. Run a task against the agent
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "task",
  "params": {
    "agentName": "my-agent",
    "prompt": "Analyze the TypeScript code in /Users/me/project and list the 3 most critical issues"
  }
}
// Returns: {"taskId": "task-abc123", "status": "running"}

// 3. Poll for result
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "result",
  "params": { "taskId": "task-abc123" }
}
// Returns: {
//   "taskId": "task-abc123",
//   "status": "completed",
//   "result": "Found 3 issues:\n1. Unhandled promise rejection...",
//   "usage": {
//     "inputTokens": 15234,
//     "peakContextTokens": 8500,
//     "cacheReadTokens": 12000,
//     "uncachedInputTokens": 3234,
//     "outputTokens": 412
//   }
// }
```

See the source repository's `examples/` directory for end-to-end client libraries (Node.js, Python).

### Native tools for dispatched agents

Every dispatched agent inherits a standardized, portable native toolset from
`AgentDefinition.nativeTooling` (`{ fs?, shell?, dispatch?, hitl? }`), resolved
at **task time** against the dispatching cwd by `resolveNativeTooling`
(`@adhd/agent-core-native-tooling`) — the stored definition is never mutated and
carries no resolved root, so it is usable from any directory:

| member | resolved default | notes |
|---|---|---|
| `fs` | `srt node <pinned server-filesystem bin> <root…>` (pinned dependency, no `npx`) | multi-root; `false` omits it |
| `shell` | `srt uvx --from mcp-shell-server==1.1.12 mcp-shell-server` | allowlisted argv — never a shell string; `false` omits it |
| `dispatch` | the REAL agent-mcp server | so the agent can dispatch sub-agents; never a wrapper |
| `hitl` | `true` | `false` hides `request_human_input` and prunes `suspend` from the ask chain |

**Portable, multi-root fs roots.** `fs.root`/`fs.roots` are **hints**, never host
paths: a named alias into the global allowed-root map, or a cwd-relative subpath
(`..` may not escape the caller cwd). An absolute hint is rejected with a typed
error. `{ "fs": { "roots": ["a", "b"] } }` at caller cwd `/P` exposes both `/P/a`
and `/P/b`. The **global map** (`nativeTooling.fs.allowedRoots`, env
`ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_ROOTS` as `alias=absolute-path`, or the global
`config.yaml`) is where the operator owns machine-specific absolute directories; an
agent references `project`/`tmp` portably. The **caller cwd** comes from a `cwd` on
the `task`/`agent` call (inherited by a sub-dispatch), with the host `process.cwd()`
as a flagged last-resort fallback.

The `fs`/`shell` builtins are wrapped by `@anthropic-ai/sandbox-runtime` (`srt`).
The host provisions a per-run policy carrying the dispatching cwd and passes it via
`srt -s`, so the shared `~/.srt-settings.json` is never accumulated with a per-spawn
path (`ADHD_AGENT_SRT_SETTINGS` overrides the per-run settings path). The static policy
denies reads of credential paths by default (`~/.npmrc`, `~/.ssh`, `~/.aws`,
`~/.config/gh`, `~/.netrc`), unioned into — never replacing — any `denyRead` entries you
already have in `~/.srt-settings.json`. The server-wide
`ADHD_AGENT_NATIVE_TOOLING_*` config is merged **beneath** each agent's own
`nativeTooling` (the agent wins). **One producer:** the fs/shell launch commands live
only in `@adhd/agent-core-native-tooling`'s catalog, and the agent-mcp self launch
config is single-sourced (`buildDispatchSelf`) — no host hand-builds a second server,
and the array and keyed-map forms of the resolver are the same computation. Merge
precedence is explicit `mcpServers` > `nativeTooling` > the `dispatch` self floor, and
`allowedTools`/`disallowedTools` remain enforced on every call.

**The permission / HITL gate is enforced.** Before every native tool call the
resolved `nativeTooling.*.permissions` rule map is evaluated host-side against the
server-qualified **tool name** (`<server>.<tool>`, e.g. `shell.shell_execute`,
`agent-mcp.task`) — never against command text. `deny` returns a typed refusal and
the tool does not execute; `ask` resolves through the fixed chain — **suspend**
(HITL enabled) → **escalate** (routed to the parent agent) → **deny** (the
fail-closed floor). `nativeTooling.hitl:false` removes the suspend step, leaving
`escalate` (if parented) or `deny`. Rule resolution is last-match-wins with `deny`
terminal. The retired `askPolicy`/`ephemeralAskPolicy` knobs are gone — the chain
is fixed.

A worked definition — filesystem on, shell tool calls require approval, dispatch allowed:

```jsonc
{
  "name": "reviewer",
  "provider": { "type": "anthropic", "model": "claude-opus-4-1" },
  "nativeTooling": {
    "fs": true,
    "shell": { "permissions": { "shell.shell_execute": "ask" } },
    "dispatch": true,
    "hitl": true
  }
}
```

#### Line endings are preserved on edit and write

The adopted filesystem server normalizes every file it writes to LF. agent-mcp
restores the original line endings host-side: before an `fs` `edit_file` /
`write_file` call it records whether the target is CRLF-only, and after a
successful call it rewrites the file to CRLF if the server turned it into LF. Files
that are LF-only, mixed, or new are left exactly as the server wrote them, and a
failed call never touches the file. This is always on (no flag), fail-open (a hook
error never changes a tool result), and idempotent across concurrent processes
(8dd148cf). The rewrite is a temp-file + rename that keeps the file's mode, and it is
skipped with a warning on stderr if the file changed between the hook's read and its
commit (a competing write is never overwritten). Files over 8 MiB are never read or
rewritten, and in-flight bookkeeping is bounded (1024 calls, 10 minute TTL) so a call
that never completes cannot leak (19354419).

#### Native tooling environment variables

Every `nativeTooling` leaf is a typed config field with an `ADHD_AGENT_*` env
override, resolved through the normal code → global → project → env cascade
(ADR-0008 D10). These are **values, never feature switches** — disable a member
with `false` on the agent definition, not with an env toggle:

| Variable | Type | Purpose |
|---|---|---|
| `ADHD_AGENT_NATIVE_TOOLING_FS_ROOT` | path | fs root; unset ⇒ the dispatching cwd at task time |
| `ADHD_AGENT_NATIVE_TOOLING_FS_READ_ONLY` | bool | reserved — read-only roots are enforced via `srt`/Docker, not a stdio flag |
| `ADHD_AGENT_NATIVE_TOOLING_FS_ALLOWED_TOOLS` | csv | fs tool-name allowlist |
| `ADHD_AGENT_NATIVE_TOOLING_FS_DISALLOWED_TOOLS` | csv | fs tool-name denylist (wins) |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ROOT` | path | shell working directory; unset ⇒ the dispatching cwd |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ALLOW_COMMANDS` | csv | command NAMES accepted by the adopted argv-allowlist server |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_ALLOW_PATTERNS` | csv | regex patterns (`re.fullmatch` over the command NAME) accepted by the adopted server, OR'd with `…_ALLOW_COMMANDS` |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_TIMEOUT_MS` | int | default command timeout (ms) |
| `ADHD_AGENT_NATIVE_TOOLING_DISPATCH_ALLOWED_TOOLS` | csv | dispatch (agent-mcp self) tool-name allowlist |
| `ADHD_AGENT_NATIVE_TOOLING_DISPATCH_DISALLOWED_TOOLS` | csv | dispatch tool-name denylist (wins) |
| `ADHD_AGENT_NATIVE_TOOLING_HITL` | bool | HITL enablement; default `true` |
| `ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE` | string[] | extra WRITABLE roots for the srt-sandboxed shell (config key `agent.shell.sandbox.extraAllowWrite`; `~/` expanded; default `~/.adhd/backlog/production/data` so `adhd-backlog` can take its store lease; the backlog `config.yaml` and `backups/` are always denied). Allowlist-validated, read from the global scope only; an invalid value aborts startup |
| `ADHD_AGENT_SHELL_SANDBOX_EXTRA_ALLOW_WRITE_ROOTS` | string[] | operator-declared trust roots (config key `agent.shell.sandbox.extraAllowWriteRoots`, default none) under which `extraAllowWrite` entries may live, e.g. a relocated backlog store; never `~/.adhd` or a protected path |
| `ADHD_AGENT_SHELL_SANDBOX_ALLOWED_DOMAINS` | string[] | restrict the srt-sandboxed shell's outbound network to these domains (config key `agent.shell.sandbox.allowedDomains`; `example.com`, `*.example.com`, optional `:port`). Default empty = OPEN egress: the default shell can `curl` any public site. Non-empty = ONLY these domains plus PyPI (the pinned shell server's own cold start). Read from the global scope only |

The retired authored-shell-server path override (the `server.mjs` fallback removed
by NAT-TOOL-4) no longer resolves; shell configuration is `nativeTooling.shell.*`.
See `AGENTS.md` §“Native tooling for dispatched agents” and
[adhd ADR-0008](../../docs/decisions/0008-agent-mcp-native-tooling.md).

## 2.0.2 Release Notes

This release fixes six critical regressions from 2.0.0/2.0.1 related to context management, token accounting, security guards, and configuration discovery:

### Cache-preserving context management

**Issue:** The context limiter dropped oldest messages on every call, mutating the prefix that providers use for caching. This destroyed prefix cache hits (from ~93-100% to ~5-6%) and inflated token spend by ~3.3x on affected tasks.

**Fix:** Replaced with append-only history that only summarizes the middle when the real context (from the provider's own `prompt_tokens`) approaches the model's actual window. `ADHD_AGENT_CONTEXT_LIMIT` now defaults to `0` (disabled), and the hardcoded 30,000-token default is gone.

**Impact:** Users with active context limits should re-evaluate whether they still need them, or switch to input-capping strategies (limiting individual tool-result sizes) instead.

### Provider-neutral token accounting

**Issue:** `inputTokens` meant different things on different providers (Anthropic excludes cached tokens; others include them), making cross-provider cost aggregation impossible. Peak-context-size tracking didn't exist anywhere.

**Fix:** New normalized usage fields:
- `uncachedInputTokens` — full-price tokens this call
- `cacheReadTokens` — discounted cache-hit tokens
- `cacheCreationTokens` — Anthropic cache-write surcharge (Anthropic only)
- `reasoningTokens` — inference tokens (when provider reports them)
- `peakContextTokens` — max prompt size across all calls in the task (distinct from cumulative `inputTokens`)

**Impact:** Callers must update code that reads `inputTokens` to distinguish between `cumulativeBilledInputTokens` (what was `inputTokens` before) and `peakContextTokens` (new, for "am I close to the window?" checks). Database migration 0008 adds the new columns.

### Create-time environment-variable guard restored

**Issue:** The env-name allowlist guard (`ADHD_AGENT_` prefix requirement) was refactored but never wired up, allowing arbitrary host environment variables (like `AWS_SECRET_ACCESS_KEY`) to be injected into agent credentials at creation time.

**Fix:** Restored validation so `agent_create` and `agent_update` reject any provider environment variable not prefixed `ADHD_AGENT_`.

**Impact:** Existing agents with non-compliant env names will need to be recreated with correct names.

### Sessions→agents foreign-key cascade restored

**Issue:** Database migration 0007 (schema restructuring) silently dropped the `sessions.agent_name → agents.name ON DELETE CASCADE` foreign key, causing `agent_delete` to orphan session and message history forever.

**Fix:** Database migration 0009 restores the cascade constraint.

**Impact:** Requires migration 0009. Old orphaned sessions remain in the database (manual cleanup may be needed); all future deletes will cascade correctly.

### Default tool advertisement restored to full JSON schemas

**Issue:** Tool advertisement mode silently switched from full JSON-Schema function-calling (2.0.1 default) to name-only (with prose doc in system message), affecting every non-claudecli agent post-upgrade with no migration or changelog note.

**Fix:** Restored full JSON-Schema as default. Name-only mode remains available via `toolAdvertisement: 'names'` on agent creation.

**Impact:** Wire format changes for any agent created under 2.0.0/2.0.1 without an explicit `toolAdvertisement` setting. Existing agents should see restored tool-definition accuracy.

### Plugin global-config back-compat

**Issue:** Plugin loader stopped checking `~/.agent-mcp/config.json` (the legacy path), breaking users with existing global plugin configurations.

**Fix:** Restored fallback to legacy path. Loader now checks (in order):
1. `~/.adhd/agent-mcp/config.json` (new preferred path)
2. `./.adhd/agent-mcp/config.json` (project-local override)
3. `~/.agent-mcp/config.json` (legacy fallback)

**Impact:** Existing configs at the legacy path will load again. No action required.

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
- The http transport serves many concurrent MCP sessions; a client must re-initialize after a reload (the old `mcp-session-id` gets HTTP 404).
- Nx serializes a task across processes: while `serve` runs, a second `nx run agent-mcp:serve` waits ("Waiting for agent-mcp:serve in another nx process"). Use `serve-status`, or call `node entrypoint/agent-mcp/scripts/serve.mjs run` for the report-and-exit behaviour.
- The MCP HTTP listener binds `ADHD_AGENT_HOST` (default `127.0.0.1`); the SSE/gateway listener binds `ADHD_AGENT_SSE_HOST` (default `127.0.0.1`).
- Full local-testing guide (isolated second instance, driving the server through the MCP client, reading usage, shell policy): [docs/dev-server-local-testing.md](./docs/dev-server-local-testing.md).

## Architecture & Security

See [docs/architecture-and-security.md](./docs/architecture-and-security.md) for details on:
- System boundaries and process model
- Provider abstraction and state persistence
- Permission inheritance and trust boundaries
- Filesystem and network access controls
- Failure recovery and cancellation semantics
- Known limitations and security assumptions

## Live tests (env-gated — paid model)

Five end-to-end tests drive a **real** LLM/provider and are therefore gated behind
env flags — the single exception AGENTS.md §7 permits (a paid/external third-party
service, which CI cannot provide):

| Test file | Gate | Real dependency |
|---|---|---|
| `src/__tests__/integration/live-budget.e2e.test.ts` | `AGENT_MCP_BUDGET_LIVE=1` | real provider (LM Studio / Anthropic) |
| `src/__tests__/integration/live-dag.e2e.test.ts` | `AGENT_MCP_LIVE=1` | real provider (LM Studio / Anthropic) |
| `src/__tests__/integration/live-oauth.e2e.test.ts` | `AGENT_MCP_LIVE=1` | real Anthropic OAuth |
| `src/__tests__/live/tracing-live.e2e.test.ts` | `AGENT_MCP_LIVE=1` | real `claude` CLI + real Anthropic OAuth, real dev server, **production store** (c536ce29 LIVE-AC1..AC5) |
| `src/__tests__/integration/live-cache-smoke.e2e.test.ts` | `ADHD_AGENT_LIVE_CACHE=1` | paid Anthropic `claude-haiku-4-5` via the product's own credential path (`ADHD_AGENT_ANTHROPIC_SECRET`); one task, ~3 model calls, isolated store under `tmp/agent-mcp/`; **owner pseudosky**, approved 2026-10-10 ("i don't care about the budget but do not burn the 5h window"); fail-closed 5h-window guard (refuses at utilization >= 0.60, status not `allowed`, or unreadable). Proves 8ecaa160 AC1 / ebfe7421 AC1 (closes ee3381d8). Its offline controls (negative control + guard teeth) run ungated. |

**Approved by:** pseudosky (repo owner); `live-cache-smoke.e2e.test.ts` (`ADHD_AGENT_LIVE_CACHE=1`) by direct owner instruction on 2026-10-10 under a hard rule never to burn the Anthropic 5-hour window (run from the repo root: `ADHD_AGENT_LIVE_CACHE=1 npx vitest run --config entrypoint/agent-mcp/vitest.e2e.config.ts live-cache-smoke` (not via `nx run`, whose cache is blind to the env var); unset it reports SKIPPED naming the gate and owner); `tracing-live.e2e.test.ts` additionally by direct owner instruction on 2026-10-09 (run guide: [docs/logging.md](./docs/logging.md#proving-it-live-the-env-gated-test)). Rationale: each calls a real, paid model the CI
cannot provide, so the gate saves money and avoids an outside system — the one qualifying
reason. The default (unflagged) suite still exercises the orchestrator/tool paths with
scripted providers; these live tests add real-model confirmation of model-independent
invariants. The same record appears in this package's `AGENTS.md` and in each test's header.

## Native-tooling adoption gate (env-gated — external third-party server)

The ADR-0008 D7 upstream-server adoption is a **human-gated** decision (NAT-TOOL-8).
The live tests that prove the adopted servers start and execute through the real
`agent_verify_mcp` handshake are gated behind `NAT_TOOL_LIVE=1`:

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
"Finish the project". Rationale: the test drives a real external third-party MCP
server (`uvx` fetches `tumf/mcp-shell-server` from PyPI), which CI cannot provide
hermetically — the qualifying gate reason. **Adopted set:** `@modelcontextprotocol/server-filesystem`,
`tumf/mcp-shell-server`, `@anthropic-ai/sandbox-runtime` (`srt`, wraps both);
`unbash` dropped, `rust-mcp-filesystem` deferred. The resolver emits the adopted,
`srt`-wrapped builtins (`@adhd/agent-core-native-tooling`); the default (unflagged)
suite proves the resolved shape and the `agent_verify_mcp` path with no external
fetch. The same record appears in this package's `AGENTS.md`, in
`@adhd/agent-core-native-tooling`'s `README.md`/`AGENTS.md`, and in the test's header.

## Live model prices (OpenRouter pull)

Cost estimates are priced from an append-only price history, not a fixed table. On start the
server seeds the bundled OpenRouter snapshot, then pulls the public
`https://openrouter.ai/api/v1/models` feed once every 24 hours (immediately after start when the last
successful pull is older than 24 hours). The request carries **no API key and no credentials**, makes one
GET with a 30 s timeout, and retries once after `Retry-After` (capped at 120 s) on a network error, 5xx or 429.
Several servers sharing one database coordinate through a ledger claim, so exactly one of them pulls.

- A failed, invalid, empty or shrunk (< 50% of the previous model count) pull changes nothing and logs an
  ERROR; the last good prices keep serving and `price_age_hours` keeps growing.
- Only models whose price changed append a row, stamped with the observation time. The feed carries no
  effective date, so the accuracy bound is the pull cadence (24 h).
- A model moving >= 20x (or an input price above $1000/M) is held, logged as an ERROR and reported in
  `anomalies`; call `pricing_refresh` with `accept:["<modelId>"]` to apply it. A 10x to 20x move is applied with a warning.
- `pricing_refresh` pulls now; `pricing_history` returns a model's observed series and the pull status.
- OpenRouter list prices are an estimate for agents billed elsewhere (for example DeepSeek direct):
  `usage_query` reports `cost_basis` (`vendor-direct`, `openrouter-estimate`, `owner-assumption`).
- Time-of-day / context-tier `pricing.overrides` are stored verbatim and applied to nothing.
- `deepseek-flash` (DeepSeek reached through the `openai` provider type) is priced as OpenRouter's
  `deepseek/deepseek-v4.1-flash`. That mapping is an owner assumption (`cost_basis: "owner-assumption"`,
  ticket 37f6c511), not evidence: confirm it with `usage_query` `group_by:"response_model"`, which groups by the
  model the provider reported serving each call. The `claudecli` provider does not report a response model, and
  turns recorded before this feature group under `(unknown)`.
- There is no setting to disable the daily pull; every server on a database that has not pulled in 24 hours attempts one.

## Limitations

- **No OS-level sandboxing** — filesystem/network access is enforced by policy, not by OS isolation. A malicious or compromised agent can still access the host if the policy permits.
- **No external audit** — this is research-grade software. Security evaluation by an external auditor is incomplete.
- **Prompt-level controls only** — tool-use filtering can be bypassed by prompt injection; it is not a security boundary.
- **Single-user only** — no multi-user isolation; all agents share the same SQLite database.
- **Experimental recovery** — agent state recovery after host crash is partially implemented; assume data loss on unexpected termination.

## Support

- **Issues:** Report bugs at the monorepo issue tracker
- **Security:** See SECURITY.md for responsible disclosure
- **Documentation:** Full architecture docs in `docs/`

## License

See LICENSE file in this directory.

## Provider selection (agent is not welded to a provider)

`agent_create` may omit `provider`. Bind one per session with `session_update { session_id, provider, model }` (canonical
model refs such as `claude_sonnet_4_6`; the wire string `claude-sonnet-4-6` is resolved through the provider registry at
task time and the binding persists across restarts), or set a host-wide default with `ADHD_AGENT_DEFAULT_PROVIDER` /
`ADHD_AGENT_DEFAULT_MODEL`. Chain: `task > session > agent > host default`. With none of them a task fails closed with
`NO_PROVIDER_SELECTED` rather than silently falling back to `claudecli`.
