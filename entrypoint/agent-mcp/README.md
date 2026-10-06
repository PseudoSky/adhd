# @adhd/agent-mcp

An MCP (Model Context Protocol) server exposing a bounded, supervised agent runtime. This package serves as the public protocol interface to the agent framework, enabling MCP clients to create, monitor, and control child agents running within enforced resource and permission boundaries.

## What is this?

`@adhd/agent-mcp` is an MCP server that:

- **Runs agents as stateful processes** — each agent maintains conversation history, executes tools, and interacts with model providers (Anthropic, OpenAI, and OpenAI-compatible endpoints such as DeepSeek via an explicit `baseURL` override — see [Providers and credentials](#providers-and-credentials) below)
- **Enforces runtime policies** — maximum delegation depth, token/cost budgets, filesystem scope, network allowlist, tool deny/allow filters
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

The database (SQLite, agents/sessions/messages/usage) is stored in the resolved scope root, defaulting to `~/.adhd/agent-mcp/production/data/agents.db` (never the repo tree). Override via `ADHD_AGENT_DATABASE_PATH`.

### Common environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ADHD_AGENT_PROVIDER` | `anthropic` | Provider *type* for the server-wide default agent: `anthropic`, `openai`, or `claudecli` (see [Providers and credentials](#providers-and-credentials)) |
| `ADHD_AGENT_MODEL` | `claude-opus-4-1` | Model identifier for the provider |
| `ADHD_AGENT_CONTEXT_LIMIT` | `0` | Max context size in tokens; 0 = no limit (enforce only at provider ceiling) |
| `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | Max tool-call iterations per task |
| `ADHD_AGENT_MAX_DEPTH` | `3` | Max delegation depth (agent → child → grandchild) |
| `ADHD_AGENT_DATABASE_PATH` | (auto-resolved) | Custom SQLite DB path; falls back to zero-config `~/.adhd/agent-mcp/production/data/agents.db` |

## Providers and credentials

`@adhd/agent-mcp` supports three provider `type`s (`packages/agent/agent-engine-orchestrator/src/validation/agent.ts`):

| `type` | Needs a credential env var? | Notes |
|---|---|---|
| `anthropic` | Yes — `ADHD_AGENT_ANTHROPIC_SECRET` | Accepts either a `claude setup-token` OAuth token (`sk-ant-oat...`) or a console.anthropic.com API key (`sk-ant-api...`) — the provider branches on the prefix automatically. |
| `openai` | Yes — `ADHD_AGENT_OPENAI_SECRET` | Also the type to use for any OpenAI-*compatible* endpoint (e.g. DeepSeek): set `env.base_url` / `ADHD_AGENT_OPENAI_BASE_URL` to the provider's URL. DeepSeek additionally has its own default names, `ADHD_AGENT_DEEPSEEK_SECRET` / `ADHD_AGENT_DEEPSEEK_BASE_URL` / `ADHD_AGENT_DEEPSEEK_MODEL`, but they must be passed explicitly as an agent's `env.secret`/`env.base_url` override — there is no separate `"deepseek"` provider `type`. |
| `claudecli` | No | Shells out to the already-authenticated `claude` CLI on the host instead of calling an API directly — nothing to configure here. Use this to avoid provider-credential wiring entirely. |

**The bare SDK-style names `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are never read anywhere in this codebase.** Only the `ADHD_AGENT_<PROVIDER>_SECRET` names above are honored.

**Gemini is not implemented.** There is no `gemini` provider `type`, no Gemini provider adapter, and no `GOOGLE_API_KEY`/Gemini credential path — despite having appeared in older versions of this document.

### Provider credentials are NOT declared `AgentMcpConfig` fields — but they DO resolve via a `.env` file cascade

Most of agent-mcp's configuration (`db`, `logging`, `queue`, `server`, `transport`, `sse`, `plugins`) resolves through `@adhd/environment`'s file-based cascade (code defaults → global → project → env var), documented in `src/config.ts`. Provider-credential env vars are **not** declared fields of `AgentMcpConfig` and are not part of that specific cascade — they resolve via `env.resolveEnvName()` (`packages/environment/environment-core-node/src/environment.ts:317-320`), a direct `process.env` read gated only by an `ADHD_AGENT` prefix allowlist.

Critically, `process.env` is not just "whatever the spawning process happened to set." `src/config.ts` calls `loadEnvHierarchy()` (`src/utils/load-env.ts`) unconditionally at module load, **before** the `Environment` singleton is constructed or any secret is resolved. `loadEnvHierarchy()` populates `process.env` itself, least-specific first, via `dotenv`:

1. `~/.adhd/.env` (no override)
2. `<cwd>/.adhd/.env` (override: true)
3. `<cwd>/.env` (override: true)

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
| `fs` | `srt npx -y @modelcontextprotocol/server-filesystem <cwd>` | `false` omits it |
| `shell` | `srt uvx mcp-shell-server` | allowlisted argv — never a shell string; `false` omits it |
| `dispatch` | the REAL agent-mcp server | so the agent can dispatch sub-agents; never a wrapper |
| `hitl` | `true` | `false` hides `request_human_input` and prunes `suspend` from the ask chain |

The `fs`/`shell` builtins are wrapped by `@anthropic-ai/sandbox-runtime` (`srt`),
and the host provisions the matching policy automatically (`ADHD_AGENT_SRT_SETTINGS`
overrides the settings path). **One producer:** the fs/shell launch commands live
only in `@adhd/agent-core-native-tooling`'s catalog — no host hand-builds a second
fs/shell server, and the array and keyed-map forms of the resolver are the same
computation. Merge precedence is explicit `mcpServers` > `nativeTooling` > the
`dispatch` self floor, and `allowedTools`/`disallowedTools` remain enforced on
every call.

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
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_DENY_COMMANDS` | csv | declared on the surface but not forwarded — the adopted server exposes an allow-list only (ADR-0008 D5) |
| `ADHD_AGENT_NATIVE_TOOLING_SHELL_TIMEOUT_MS` | int | default command timeout (ms) |
| `ADHD_AGENT_NATIVE_TOOLING_DISPATCH_ALLOWED_TOOLS` | csv | dispatch (agent-mcp self) tool-name allowlist |
| `ADHD_AGENT_NATIVE_TOOLING_DISPATCH_DISALLOWED_TOOLS` | csv | dispatch tool-name denylist (wins) |
| `ADHD_AGENT_NATIVE_TOOLING_HITL` | bool | HITL enablement; default `true` |

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

## Architecture & Security

See [docs/architecture-and-security.md](./docs/architecture-and-security.md) for details on:
- System boundaries and process model
- Provider abstraction and state persistence
- Permission inheritance and trust boundaries
- Filesystem and network access controls
- Failure recovery and cancellation semantics
- Known limitations and security assumptions

## Live tests (env-gated — paid model)

Three end-to-end tests drive a **real** LLM/provider and are therefore gated behind
env flags — the single exception AGENTS.md §7 permits (a paid/external third-party
service, which CI cannot provide):

| Test file | Gate | Real dependency |
|---|---|---|
| `src/__tests__/integration/live-budget.e2e.test.ts` | `AGENT_MCP_BUDGET_LIVE=1` | real provider (LM Studio / Anthropic) |
| `src/__tests__/integration/live-dag.e2e.test.ts` | `AGENT_MCP_LIVE=1` | real provider (LM Studio / Anthropic) |
| `src/__tests__/integration/live-oauth.e2e.test.ts` | `AGENT_MCP_LIVE=1` | real Anthropic OAuth |

**Approved by:** pseudosky (repo owner). Rationale: each calls a real, paid model the CI
cannot provide, so the gate saves money and avoids an outside system — the one qualifying
reason. The default (unflagged) suite still exercises the orchestrator/tool paths with
scripted providers; these live tests add real-model confirmation of model-independent
invariants. The same record appears in this package's `AGENTS.md` and in each test's header.

## Native-tooling adoption gate (env-gated — external third-party server)

The ADR-0008 D7 upstream-server adoption is a **human-gated** decision (NAT-TOOL-8).
The live test that proves the adopted shell server (`tumf/mcp-shell-server`, fetched
from PyPI at run time by `uvx`) starts and executes an allowlisted argv command
through the real `agent_verify_mcp` handshake is gated behind `NAT_TOOL_LIVE=1`:

| Test file | Gate | Real dependency |
|---|---|---|
| `src/__tests__/integration/native-tooling-adoption.e2e.test.ts` | `NAT_TOOL_LIVE=1` | `uvx mcp-shell-server` (external PyPI package) + `srt` |

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
