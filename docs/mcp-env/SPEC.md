# SPEC — `config.ts` env module + provider env-keying (agent-mcp)

> Status: **IMPLEMENTED & verified** (working tree, pending release). Delivered as a
> single `typescript-pro` change to `@adhd/agent-mcp` (+ `@adhd/agent-mcp-types`).
> Derived from the design Q&A; supersedes the meandering `docs/mcp-env/PROPOSAL.md`.
> **Out of scope (still):** the `agent-provider-credentialing` plan's registry SEED and
> the provider-registry boundary refactor — see that plan's README for the reconciliation.
>
> **Verification:** `nx build agent-mcp` + `agent-mcp-types` green; `nx test agent-mcp`
> green (324 passed, live E2E gated). Proven live through the loaded MCP tools
> (`agent_create → task → result`): an Anthropic **OAuth-token** agent returned a real
> completion; a DeepSeek (`openai`) agent authenticated successfully (reached billing).
>
> **Two regressions caught during execution & fixed (see CHANGELOG → Fixed):**
> (1) Zod `.transform()`/`z.preprocess()` leaked into the MCP-exposed schema → `tools/list`
> crashed; fixed by splitting transform-free (MCP) vs read-only stored (shim) schemas.
> (2) DEBT-014 — the env-name guard ran on the read path (broke `agent_delete` on legacy
> rows); moved to create/update input only.
>
> **Deltas from this spec as written:** the §5 optional `DATABASE_PATH`→`tmp/` move was
> **not** taken (DB stays under `data/`/home, per review comment); the model-resolution
> and credential plumbing match §1–§4.
>
> **No secrets in this file.** Credential *names* only ever appear here, never values.

> **⚠ Breaking change.** Every server env var is renamed to the `ADHD_AGENT_` prefix
> (§1.1) and the provider credential fields are unified (§3). Existing `.mcp.json`
> env blocks, deployment env, and any agent rows using `apiKeyEnv`/`authTokenEnv`/
> `type:"lmstudio"` must be updated. A normalize-on-load shim for legacy `agents.db`
> rows is flagged in §9 (decide in/out of this single-task scope).

## 0. Goal & rationale

Introduce a single module, `src/config.ts`, that is the **only reader of `process.env`**
in the package — first-party *and*, after §3c, the credential path that previously let a
library read env directly. Every one of the 26 existing scattered `process.env` reads
routes through it. This gives one testable, validated, audit-able config surface; removes
duplicated reads; centralizes the secret-handling policy; and makes "are the required env
vars present?" a programmatically answerable question.

### Verified facts this design rests on

- **Claude Code forwards only a 6-var allowlist** to stdio MCP servers
  (`HOME, LOGNAME, PATH, SHELL, TERM, USER`) + the literal `.mcp.json` `env` block,
  and does **not** expand `${VAR}` (binary analysis in `PROPOSAL.md` §1; confirmed
  empirically — our `"${DEEPSEEK_API_KEY}"` arrived as a literal string).
- **The server already does `import "dotenv/config"`** (`index.ts:2`) and runs with
  **cwd = repo root** (proven: relative `DATABASE_PATH=data/agent-mcp/...` resolved and
  persisted agents). The dual/triple `.env` hierarchy in §5 replaces the implicit
  single-cwd load; a `/mcp` reload re-reads.
- **dotenv loads only the keys literally in the `.env` file(s)**, never the parent shell,
  and does not override already-set vars (proven by isolated test:
  `NOTONLY_IN_FILE present? false`; ambient shell var present only via full `node`
  inheritance, which Claude Code strips). ⇒ the server's `process.env` is fully
  operator-controlled and minimal: 6 POSIX vars + secret-free `.mcp.json` env + exactly
  what's in the gitignored `.env` files. An LLM-authored agent def can never reach an
  ambient system secret (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) — it isn't present, and
  the §6 prefix guard refuses any non-`ADHD_AGENT_` name regardless.
- **`agent_read` / `agent_list` return the provider block unredacted**
  (`agent-crud.ts` → `agentStore.read()/list()`). ⇒ secrets must remain **env
  pointers** (a var *name*), never stored *values*, or they leak to the calling host.
- **DeepSeek accepts the endpoint with or without `/v1`** (proven: both
  `/chat/completions` and `/v1/chat/completions` return 401, not 404). The `/v1`
  requirement is only ours — the OpenAI SDK appends `/chat/completions`, so a
  path-less base URL 404s (`validation/agent.ts:26-27`).

---

## 1. `src/config.ts` — the only `process.env` reader

### Init model — eager frozen singleton + pure factory  *(confirmed)*

```ts
// config.ts loads the .env hierarchy (§5) before any value is read, then snapshots.
import { loadEnvHierarchy } from "./utils/load-env.js";   // see §5

export interface Config { /* nested shape, see §1.1 */ }

/** Pure, testable. Reads `env` ONCE, validates with Zod, deep-freezes the result. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config;

/** App singleton — constructed once at module load. */
export const config: Config = loadConfig();
```

- `config.ts` snapshots `env` exactly once at construction and `Object.freeze`s the
  result (and the captured env snapshot used by the dynamic methods in §1.2).
- **No reload** *(confirmed)* — frozen for the process lifetime. Rotation is handled by
  a `/mcp` reload, which re-spawns the server and re-reads the `.env` hierarchy.
- Tests call `loadConfig(fakeEnv)` for isolation; the app imports `config`.
- Because `logger.ts` and `index.ts` read env at **module-load time**, `config` must be
  eagerly available on import. `logger.ts` importing `config` triggers the `.env`
  hierarchy load before its `level` read.

### 1.1 Static config shape — nested namespaces  *(confirmed)*

Grounded in the full 26-read inventory; dedupes the two duplicated vars. **All server
env vars are `ADHD_AGENT_`-prefixed** — the legacy `AGENT_MCP_` prefix and the bare
(`DATABASE_PATH`, `LOG_LEVEL`, …) names are gone.

| Accessor | Env var | Default | Parse / type |
|---|---|---|---|
| `config.db.path` | `ADHD_AGENT_DATABASE_PATH` | `~/.adhd/agent-mcp/agents.db` | path |
| `config.logging.level` | `ADHD_AGENT_LOG_LEVEL` | `"info"` | enum |
| `config.queue.concurrency` | `ADHD_AGENT_QUEUE_CONCURRENCY` | `5` | int |
| `config.server.maxDepth` | `ADHD_AGENT_MAX_DEPTH` | `5` | int |
| `config.server.maxToolLoops` | `ADHD_AGENT_MAX_TOOL_LOOPS` | `50` | int |
| `config.server.defaultMaxTokens` | `ADHD_AGENT_DEFAULT_MAX_TOKENS` | `8192` | int — **dedupes** `index.ts:8` + `anthropic.ts:55` |
| `config.server.contextLimit` | `ADHD_AGENT_CONTEXT_LIMIT` | `0` | int |
| `config.server.allowedAgents` | `ADHD_AGENT_ALLOWED_AGENTS` | unrestricted | csv → `string[]` |
| `config.server.registryDbPath` | `ADHD_AGENT_REGISTRY_DB_PATH` | `~/.adhd/agent-mcp/registry.db` | path |
| `config.transport.kind` | `ADHD_AGENT_TRANSPORT` | `"stdio"` | enum |
| `config.transport.port` | `ADHD_AGENT_PORT` | `3000` | int |
| `config.sse.port` | `ADHD_AGENT_SSE_PORT` | `3001` | int — **dedupes** `sse-server.ts:6` + `task.ts:313` |
| `config.sse.host` | `ADHD_AGENT_SSE_HOST` | `127.0.0.1` | str |
| `config.sse.baseUrl` | `ADHD_AGENT_SSE_BASE_URL` | `http://localhost:${sse.port}` | url |
| `config.plugins.configPath` | `ADHD_AGENT_CONFIG` | — | path |
| `config.plugins.entries` | `ADHD_AGENT_PLUGINS` | `[]` | csv → `string[]` |
| `config.security.envAllowlist` | `ADHD_AGENT_ENV_ALLOWLIST` | none (prefix-only default, §6) | csv/globs → matcher |

#### Provider config — generic template (§3) + opt-in defaults

Per-provider credential/endpoint config is **not** static server config; it is resolved
per agent via `config.getProviderConfig()` (§3). The default env-var mappings follow one
generic template, and **using them is explicit opt-in** (an agent must select the
provider and point its `env` block at these names; nothing is auto-applied):

| Provider field | Generic env-var template | Example (`deepseek`) |
|---|---|---|
| `secret` (env-pointer) | `ADHD_AGENT_<PROVIDER>_SECRET` | `ADHD_AGENT_DEEPSEEK_SECRET` |
| `base_url` | `ADHD_AGENT_<PROVIDER>_BASE_URL` | `ADHD_AGENT_DEEPSEEK_BASE_URL` |
| `model` | `ADHD_AGENT_<PROVIDER>_MODEL` | `ADHD_AGENT_DEEPSEEK_MODEL` |

Concrete seeded providers: `ANTHROPIC`, `OPENAI`, `DEEPSEEK` (`<PROVIDER>` is the logical
provider id, uppercased). New providers are **rows in this template**, not new code.

Static config is Zod-validated (int bounds, enum membership) and **fails fast** on
invalid input.

### 1.2 Dynamic + provider + subprocess methods — the frozen-snapshot model

Resolves the two design concerns raised in review: (A) programmatic verifiability of
the env surface, and (B) the config/runtime process boundary. `process.env` is read
once; these methods consult the **frozen snapshot**, never live `process.env`.

```ts
/** Provider-level resolver — ONE entry point for every provider type. `provider`
 *  selects the type; the optional {secret,url,model} are env-var NAMES taken from the
 *  agent's `env` block, overriding the provider's default template names (§1.1). The
 *  returned structure matches the agent `env` structure. Secret resolves via
 *  resolveEnvRef (guarded, §6); a missing REQUIRED secret fails loud (§3); baseURL is
 *  /v1-normalized (§3). */
config.getProviderConfig(opts: {
  provider: "openai" | "anthropic" | "claudecli";
  secret?: string;   // = agentConfig.env.secret    (env-var name)
  url?: string;      // = agentConfig.env.base_url   (env-var name)
  model?: string;    // = agentConfig.env.model      (env-var name)
}): { secret?: string; baseURL?: string; model?: string };  // resolved VALUES

/** Primitive — resolve a single env-var NAME against the frozen snapshot. Throws if
 *  `name` is disallowed by the §6 guard. getProviderConfig is built on this. */
config.resolveEnvRef(name: string): string | undefined;

/** Allowlist predicate — used by the Zod refinement at agent_create / agent_update so
 *  a disallowed env-name is rejected early with a clear error. Single source of truth
 *  for the §6 guard. */
config.isEnvNameAllowed(name: string): boolean;

/** Startup verification — given the env names referenced across all loaded agents,
 *  report which are missing from the surface and which are disallowed. See §4. */
config.verifyEnvRefs(names: string[]): { missing: string[]; disallowed: string[] };

/** Subprocess spawn — the frozen snapshot serialized to a string map for child
 *  processes (external MCP servers, the claude CLI), which read their OWN process.env
 *  and cannot share our in-memory config. Raw passthrough — see §2. */
config.subprocessEnv(): Record<string, string>;
```

---

## 2. Route all 26 reads through `config`

Grouped by the three classes found in the inventory.

### Class 1 — static (read once, fixed names)

`db/client.ts:21`, `logger.ts:13`, `engine/queue.ts:20`, `engine/orchestrator.ts:131`,
`index.ts:8,166,167,168,221`, `plugins/loader.ts:87,272`, `server.ts:772,773`,
`streaming/sse-server.ts:6,25`, `tools/task.ts:313,314`, `providers/anthropic.ts:55`
→ replace with `config.<ns>.<field>` (new `ADHD_AGENT_*` names).

### Class 2 — dynamic provider refs (name from the agent def)

`providers/openai.ts:96`, `providers/anthropic.ts:298,299,339,340` →
`config.getProviderConfig(...)`. *(`providers/lmstudio.ts` is deleted — §3.)*

### Class 3 — full-env spread into spawned children

`clients/stdio-client.ts:26`, `providers/claudecli.ts:315` →
`{ ...config.subprocessEnv() }`. **Raw passthrough** *(confirmed)* — external servers
and the claude CLI legitimately need the full inherited env (PATH/HOME/their own keys);
filtering risks breaking them. Centralizing the access keeps `config.ts` the sole reader.

---

## 3. Provider model — unified `secret`, `getProviderConfig`, lmstudio removed

### Provider type set

`openai` (the OpenAI-compatible standard), `anthropic`, `claudecli`. **`lmstudio` is
removed entirely** — it is just an OpenAI-compatible server, so it is a plain `openai`
provider with a `base_url`. No `lmstudio` type, no `providers/lmstudio.ts`, no factory
branch, no `?? "lmstudio"` placeholder — **zero `lmstudio` references in code; the only
mention lives in the README** (as a usage example of `openai` + `base_url`).

### `validation/agent.ts`

- Unify the two credential fields into **one** `secret` (env-pointer) on the agent's
  `env` block — replacing `apiKeyEnv` + `authTokenEnv`. The wire form is inferred from
  the resolved value (§3a), not from which field was used. The agent `env` block is:
  `{ secret?: string; base_url?: string; model?: string }` — each a `ADHD_AGENT_*`
  env-var name (env-remapped; secrets are pointers, never values).
- Replace the strict `versionedBaseUrlSchema` **reject** with a **normalize transform**:
  - URL with **no path** (`/` or empty) → append `/v1`.
  - URL with **any explicit path** (`/v1`, `/openai/v1`, custom) → **respected**
    (force-override; "BASE_URL means BASE_URL").
- Add a Zod refinement calling `config.isEnvNameAllowed()` on every name in the `env`
  block (`secret`/`base_url`/`model`) — enforces the §6 prefix policy at
  agent_create / agent_update.

### Providers — resolution order: agent `env` override → provider default → fail/literal

All providers build their client from a single `config.getProviderConfig({provider, …})`
call. The resolver merges the agent's `env`-block name overrides over the provider's
default template names (§1.1), resolves them against the frozen snapshot, and:

- `secret`: resolved via `resolveEnvRef` (guarded). **A missing required secret fails
  loud** — `no credential for <provider> at <baseURL>; set <ADHD_AGENT_*_SECRET>` —
  instead of the old silent `"lmstudio"` placeholder. (A localhost `base_url`, i.e. a
  local OpenAI-compatible server that needs no auth, is the one case allowed to proceed
  without a secret.)
- `baseURL`: resolved, then `/v1`-normalized.
- `model`: resolved; falls back to the agent-def literal `model` when no env mapping.

### 3a. Secret wire-form inference *(unified — replaces the apiKeyEnv/authTokenEnv split)*

There is one secret per provider config; "API key vs auth token" is **not** two fields,
it is an inferred wire form (the difference is provider-selection programmatics, not
caller bookkeeping). The anthropic adapter, given the single resolved `secret`:

| Secret value prefix | Wire form |
|---|---|
| `sk-ant-api…` | `x-api-key` client |
| `sk-ant-oat…` | `Authorization: Bearer` client + `anthropic-beta: oauth-2025-04-20` header |

The four legacy anthropic reads (`:298/:299/:339/:340`) collapse into the single
`config.getProviderConfig({provider:"anthropic"})` secret resolution. `verifyEnvRefs`
harvests the unified `env` names (§4); the §6 prefix guard permits them because they are
`ADHD_AGENT_*`.

### 3b. Keychain OAuth (`useClaudeOauth`) — **removed**

Delete the keychain extraction path (`getAccessToken()` at `anthropic.ts:327`, the
`useClaudeOauth` flag, and the `:339/:340` env fallbacks). It is superseded by the
standard one-year token (`claude setup-token`), which is supplied like any other
secret — as `ADHD_AGENT_ANTHROPIC_SECRET` — and resolves to the `sk-ant-oat…` Bearer
wire form via §3a. No macOS-keychain dependency remains.

### 3c. Anthropic SDK implicit env read — **closed**

Because §3b is removed and the adapter now **always** resolves the secret via `config`
and passes it explicitly into `new Anthropic({ apiKey | authToken })`, the SDK never
falls through to its own `process.env` auto-detect (the old `anthropic.ts:318` path).
`config` is therefore the **sole** env reader — no library back-door. *(This closes the
former OPEN DECISION B in favor of the config-sole-reader option.)* Requires
`ADHD_AGENT_ANTHROPIC_SECRET` to be set (or an agent `env.secret` override).

### 3d. Token-budget vars (distinct from auth tokens)

`ADHD_AGENT_DEFAULT_MAX_TOKENS` → `config.server.defaultMaxTokens` (Class 1, dedupes
`index.ts:8` + `anthropic.ts:55`). A **per-agent `maxTokens`** (agent-def provider
config) **overrides the global default, applied consistently across every provider** —
the resolution is `agent.maxTokens ?? config.server.defaultMaxTokens` in one shared
helper, not per-provider ad hoc.

### 3e. Worked example — two agents: `codex` (remote) + `lmstudio` (local)

Both are `type: "openai"` — `lmstudio` is no longer a type, just a local
OpenAI-compatible box. They differ only in which `ADHD_AGENT_*` names they reference and
whether a secret is required. This is the canonical demonstration that the model handles
a remote, authenticated provider and a local, no-auth provider with **one** code path.

**Step 1 — `.env` (e.g. `~/.adhd/.env`, gitignored; never in `.mcp.json` or agent rows):**

```sh
# codex — remote, OpenAI-compatible → needs a real secret
ADHD_AGENT_CODEX_SECRET=sk-...                 # the ONLY secret; lives only here
ADHD_AGENT_CODEX_BASE_URL=https://api.openai.com/v1
ADHD_AGENT_CODEX_MODEL=gpt-5-codex

# lmstudio — local, no auth → NO secret var on purpose
# (base_url/model can live here too, or be inlined on the agent as below)
```

**Step 2 — create the agents.** Codex centralizes everything in `.env` via its `env`
block (env-var *names*); LM Studio inlines literals and supplies no secret:

```jsonc
// Agent A — codex (remote): all three resolved from ADHD_AGENT_CODEX_* in .env
agent_create({
  name: "codex",
  systemPrompt: "You are a coding agent.",
  provider: {
    type: "openai",
    env: {                                   // env-var NAMES (snake_case keys)
      secret:   "ADHD_AGENT_CODEX_SECRET",   // required → fail-loud if missing
      base_url: "ADHD_AGENT_CODEX_BASE_URL",
      model:    "ADHD_AGENT_CODEX_MODEL"
    }
  },
  mcpServers: {}, permissions: {}
})

// Agent B — lmstudio (local): inline literals, NO secret (localhost is exempt)
agent_create({
  name: "local-lmstudio",
  systemPrompt: "You are a local coding assistant.",
  provider: {
    type: "openai",                          // lmstudio is NOT a type anymore
    baseURL: "http://localhost:1234/v1",     // inline literal (bare host also works → normalized to …/v1)
    model:   "qwen2.5-coder-7b"
    // no secret, no env block — localhost needs none
  },
  mcpServers: {}, permissions: {}
})
```

**Step 3 — resolution (`config.getProviderConfig`):**

| | **codex** | **local-lmstudio** |
|---|---|---|
| `secret` | `resolveEnvRef("ADHD_AGENT_CODEX_SECRET")`; **fails loud** if absent (`no credential for openai at https://api.openai.com/v1; set ADHD_AGENT_CODEX_SECRET`) | none — localhost `baseURL` ⇒ secret exemption |
| `baseURL` | `ADHD_AGENT_CODEX_BASE_URL` (already `/v1`) | inline `http://localhost:1234/v1` (bare host → normalized) |
| `model` | `ADHD_AGENT_CODEX_MODEL` | inline `qwen2.5-coder-7b` |
| §6 guard | `ADHD_AGENT_CODEX_*` → allowed | n/a (no env refs) |

At startup, `config.verifyEnvRefs([...codex names])` warns immediately if the key is
missing — never a silent mid-task 401. LM Studio contributes no refs to verify.

> This example illustrates §9 item 2 (the env-block keys are snake_case `base_url`/`model`
> while inline literal fields keep camelCase `baseURL`/`model` — align or leave, TBD).

---

## 4. Startup verification  *(confirmed: index.ts drives, warn-then-continue)*

`index.ts`, after loading agents:

1. Harvest every referenced env name from all agent `env` blocks —
   `{ secret, base_url, model }` wherever present.
2. Call `config.verifyEnvRefs(names)`.
3. Log a clear **WARNING** listing missing/disallowed vars per agent; **never crash**
   (one misconfigured agent must not block the rest of a mixed deployment).

`config` stays store-agnostic — `index.ts` does the harvesting; `config` only checks
names against the frozen surface + the §6 prefix guard.

---

## 5. Wiring & secret hygiene  *(confirmed: dotenv `.env` hierarchy)*

### `.env` load hierarchy *(new — `src/utils/load-env.ts`)*

Load deterministically with **most-specific wins**:

```
1. <project>/.env              (highest precedence)
2. <project>/.adhd/.env
3. ~/.adhd/.env                (lowest precedence)
```

Implemented as least-specific-first with override (or most-specific-first with
no-override — equivalent), so a key set in `<project>/.env` beats the same key in
`~/.adhd/.env`. `config.ts` (via `loadEnvHierarchy()`) runs this before its snapshot.

- **All three paths are gitignored** (`.env`, `.adhd/.env`, plus `~/.adhd/.env` lives
  outside the repo). Add the in-repo patterns to `.gitignore`.
- Revert the broken `"${DEEPSEEK_*}"` literals previously added to `.mcp.json`; the
  committed `.mcp.json` stays **secret-free**.

### Database path

`config.db.path` resolves `ADHD_AGENT_DATABASE_PATH`, default `~/.adhd/agent-mcp/agents.db`.
The repo-root `data/` default used by `.mcp.json` today stays under `data/` (gitignored)
where present — **no move to `tmp/`** (`tmp/` is for ephemeral test artifacts, not the
persistent agent store).

### `.env.example` template *(opt-in provider defaults)*

Ship `packages/ai/agent-mcp/.env.example` listing the server `ADHD_AGENT_*` vars and the
generic provider template (`ADHD_AGENT_<PROVIDER>_SECRET|BASE_URL|MODEL`) with the
seeded providers as commented examples. It documents names only — never values — and
nothing is active until a real `.env` opts in.

---

## 6. Env-name guard  *(default: `ADHD_AGENT_`-prefixed only)*

An agent-def `env` reference may name **only `ADHD_AGENT_`-prefixed variables** by
default. This is the security model: because every legitimate provider/server var carries
the prefix (§1.1), the guard both (a) blocks an LLM-authored agent def from naming an
ambient secret (`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`) and (b) is trivial to reason
about.

- `config.isEnvNameAllowed(name)` returns `name.startsWith("ADHD_AGENT_")` by default.
- `ADHD_AGENT_ENV_ALLOWLIST` (comma-separated names/globs) **extends** the set for
  operators who must reference a differently-named var; it never relaxes the prefix rule
  silently — names added here are explicit operator opt-ins.
- Enforced in both `isEnvNameAllowed()` (Zod, at agent_create/update) and
  `resolveEnvRef()` (runtime).

---

## 7. Tests  *(real seam, per agent-mcp CLAUDE.md §6)*

### `src/__tests__/config.test.ts` — via `loadConfig(fakeEnv)`

- Nested values resolve from `ADHD_AGENT_*`; defaults apply when absent.
- Zod validation **fails** on a bad int / unknown enum (fail-fast proven).
- Returned object is frozen (mutation throws / no-ops).
- `getProviderConfig` merges agent `env` overrides over provider defaults; resolves
  secret/url/model; **fails loud on a missing required secret** for a non-localhost
  `base_url`; localhost without a secret constructs.
- Secret **wire-form inference**: `sk-ant-api…` → x-api-key; `sk-ant-oat…` → Bearer +
  `oauth-2025-04-20` header.
- `resolveEnvRef` / `isEnvNameAllowed`: non-`ADHD_AGENT_` name is **rejected**; an
  `ADHD_AGENT_ENV_ALLOWLIST` entry permits an explicitly-added name.
- `verifyEnvRefs` reports `missing` and `disallowed` over the unified `{secret,base_url,model}`.
- `subprocessEnv()` returns the full snapshot map.
- **Normalization cases:** bare host → `/v1`; explicit `/v1` kept; custom path kept;
  env-sourced URL overrides the literal.
- **`.env` hierarchy:** same key in `<project>/.env` and `~/.adhd/.env` → project wins.
- **No `lmstudio`:** a grep/AST assertion that `lmstudio` appears nowhere in `src/`.
- Each behavioral case carries a **negative control** that goes red if the logic is
  reverted.

### Live MCP proof (end-to-end, real provider)

Build → `/mcp` reload → `agent_create`(deepseek `openai`+`base_url`, env-keyed) → `task`
→ `result` asserts `status:"completed"` against the real DeepSeek API. Driven through the
loaded `mcp__agent-mcp__*` tools (never a bypass).

> Flag-gated **only** because DeepSeek is a paid/external third-party service — the one
> qualifying exception. The gate + named owner must be documented in **all three**:
> `README.md`, `CLAUDE.md`, and the test file header.

---

## 8. Docs

agent-mcp `CLAUDE.md` env-var table + `README.md`:

- the `config` module + the `.env` hierarchy (§5),
- the `ADHD_AGENT_*` rename (full mapping table) + the generic provider template,
- unified `secret` + wire-form inference; **lmstudio is `openai` + `base_url`** (the only
  surviving `lmstudio` reference, README-only),
- keychain removal + the one-year-token path,
- `/v1` normalization, `ADHD_AGENT_ENV_ALLOWLIST` prefix guard,
- the env-pointer-for-secrets rationale (the `agent_read` leak).

---

## 9. Open decisions / items (resolve before dispatch)

**Locked by review comments:** the `ADHD_AGENT_` prefix (§1.1/§6), unified `secret` +
`getProviderConfig` (§3), lmstudio removal (§3), keychain removal + config-sole-reader
(§3b/§3c — former OPEN DECISION B), per-agent `maxTokens` override (§3d), DB under `data/`
not `tmp/` (§5), and the `.env` hierarchy (§5).

**Resolved for dispatch:**

1. **Legacy back-compat — shim IN SCOPE.** Ship a normalize-on-load shim in the zod
   schema's preprocess: a stored row with `type:"lmstudio"` → `type:"openai"`;
   `apiKeyEnv`/`authTokenEnv` → unified `env.secret`; bare/`AGENT_MCP_*` names tolerated
   on read. Required because the real `~/.adhd/agent-mcp/agents.db` already holds rows
   (e.g. the `deepseek` agent) that must keep parsing. Proven by a test that parses the
   real DB rows + a synthetic legacy row through the schema.
2. **`env`-block values = NAMES; inline fields = literals; both supported.**
   `agent.provider.env.{secret,base_url,model}` hold `ADHD_AGENT_*` env-var **names**
   (env-remapped; secrets are pointers only). The non-secret literals may still be set
   inline via the existing `baseURL`/`model` fields. `getProviderConfig` precedence:
   `env`-name override → inline literal → provider default → (secret) fail-loud /
   (baseURL) normalize.
3. **`claudecli` exempt from the secret resolver.** `getProviderConfig({provider:
   "claudecli"})` returns its own shape (drives the local `claude` CLI via
   `subprocessEnv()`); it is not forced through secret/baseURL resolution.
4. **Casing — env block snake_case, inline literals camelCase.** `env.{secret,base_url,
   model}` (snake, matches `.env` var intuition + TODO) and the existing inline
   `baseURL`/`model` (camel) co-exist by design; not aligned, to avoid churning the
   established inline field names.

## Appendix — full `process.env` inventory (26 reads, pre-change)

Names below are the **current** (pre-rename) vars; §1.1 maps each to its `ADHD_AGENT_*`
replacement.

```
clients/stdio-client.ts:26      ...process.env                 (Class 3 spread)
db/client.ts:21                 DATABASE_PATH                  (Class 1)
engine/orchestrator.ts:131      AGENT_MCP_CONTEXT_LIMIT        (Class 1)
engine/queue.ts:20              QUEUE_CONCURRENCY              (Class 1)
index.ts:8                      AGENT_MCP_DEFAULT_MAX_TOKENS   (Class 1, dup)
index.ts:166                    AGENT_MCP_MAX_DEPTH            (Class 1)
index.ts:167                    AGENT_MCP_MAX_TOOL_LOOPS       (Class 1)
index.ts:168                    ALLOWED_AGENTS                 (Class 1)
index.ts:221                    AGENT_MCP_REGISTRY_DB_PATH     (Class 1)
logger.ts:13                    LOG_LEVEL                      (Class 1, module-load)
plugins/loader.ts:87            AGENT_MCP_CONFIG               (Class 1)
plugins/loader.ts:272           AGENT_MCP_PLUGINS              (Class 1)
providers/anthropic.ts:55       AGENT_MCP_DEFAULT_MAX_TOKENS   (Class 1, dup)
providers/anthropic.ts:298      apiKeyEnv ?? ANTHROPIC_API_KEY (Class 2 → unified secret)
providers/anthropic.ts:299      authTokenEnv ?? ANTHROPIC_AUTH_TOKEN (Class 2 → unified secret)
providers/anthropic.ts:339      ANTHROPIC_API_KEY              (Class 2, keychain fallback → removed §3b)
providers/anthropic.ts:340      ANTHROPIC_AUTH_TOKEN           (Class 2, keychain fallback → removed §3b)
providers/claudecli.ts:315      {...process.env}              (Class 3 spread)
providers/lmstudio.ts:12        LMSTUDIO_BASE_URL             (Class 2 → file deleted §3)
providers/openai.ts:96          apiKeyEnv ?? OPENAI_API_KEY   (Class 2 → unified secret)
server.ts:772                   TRANSPORT                      (Class 1)
server.ts:773                   PORT                           (Class 1)
streaming/sse-server.ts:6       SSE_PORT                       (Class 1, dup)
streaming/sse-server.ts:25      SSE_HOST                       (Class 1)
tools/task.ts:313               SSE_PORT                       (Class 1, dup)
tools/task.ts:314               SSE_BASE_URL                   (Class 1)
```
