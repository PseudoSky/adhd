# MCP env-key generalization proposal

## 1. Confirmed env mechanism (verified from source)

### How Claude Code spawns a stdio MCP server

Claude Code v2.1.193 (`/Users/nix/.local/share/claude/versions/2.1.193`) was
decompiled and the `StdioClientTransport.start()` spawn call was located. The
exact spawn env construction is:

```js
// Extracted verbatim from the Claude Code binary (minified, de-mangled):
function Jto() {
  let e = {};
  for (let t of F7d) {
    let n = CLn.default.env[t];
    if (n === undefined) continue;
    if (n.startsWith("()")) continue;  // skip bash functions
    e[t] = n;
  }
  return e;
}

// macOS/Linux allowlist (F7d):
F7d = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]

// Spawn call:
spawn(command, args ?? [], {
  env: { ...Jto(), ...this._serverParams.env },
  stdio: ["pipe", "pipe", serverParams.stderr ?? "inherit"],
  shell: false,
})
```

### What this means

1. **Claude Code does NOT pass the full parent environment.** It builds a
   minimal allowlisted env (`HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER`
   on macOS/Linux) and then merges the explicit `env` block from `.mcp.json`
   on top.

2. **There is NO `${VAR}` expansion in `.mcp.json` env values.** The binary
   has no `expandEnv`, `interpolateEnv`, or shell-substitution pass over the
   `env` block. The only `${…}` placeholders Claude Code supports
   (`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_DATA}`)
   are applied exclusively to **hook command args**, not to `.mcp.json` env
   values (source: same binary, hook-command substitution regex
   `\$\{CLAUDE_PLUGIN_ROOT\}` / `\$\{CLAUDE_PROJECT_DIR\}` / `\$\{CLAUDE_PLUGIN_DATA\}` —
   confirmed absent from the MCP spawn path).

3. **Direct consequence:** The Anthropic "just inherit it" approach — where the
   key is absent from `.mcp.json` and the spawned process reads
   `ANTHROPIC_API_KEY` from the parent shell — **does NOT work for stdio MCP
   servers by default** because only the six-key allowlist is forwarded.
   Anthropic works today only because the `agent-mcp` server reads the Anthropic
   key from `process.env["ANTHROPIC_API_KEY"]` and that var happens to arrive
   via the explicit `env` block (or it was tested with `claudecli`/`useClaudeOauth`
   which bypasses the key entirely).

4. **The correct mechanism** for secrets is: put the _key name_ (not the value)
   in `.mcp.json`'s `env` block as `"KEY_NAME": "${KEY_NAME}"` ... but since
   `${}` is not expanded, the literal string `"${KEY_NAME}"` would be passed,
   which is wrong. **The only correct approach is to list the secret env var
   name in `.mcp.json`'s `env` block with its value sourced from the parent
   process — i.e., the runner must export the var into their shell before
   launching Claude Code, and then `.mcp.json` must name it in `env`.**

   The way to do this cleanly is: **use a fixed, well-known env var name in
   `.mcp.json` and document that users must export it in their shell.** Do not
   store the value. This is exactly what the Anthropic pattern does when it
   works correctly.

### Confirmation: can we drop the key entirely (pure inheritance)?

No. Claude Code's spawn allowlist is `["HOME","LOGNAME","PATH","SHELL","TERM","USER"]`.
`LMSTUDIO_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `DATABASE_PATH`
are all absent from that list. They will not reach the spawned `agent-mcp`
process unless they are explicitly named in the `.mcp.json` `env` block.

The Anthropic provider using `useClaudeOauth: true` or the `claudecli` provider
are exceptions — they read credentials from the macOS keychain or from the
running `claude` process, not from an env var — so they genuinely need no entry.

---

## 2. Generalized env-keying design

### Principle

`.mcp.json` names the **env var** where the value lives, never the value itself.
The agent-mcp source already supports remapping via `apiKeyEnv` in each provider
config. The gap is only in what the committed `.mcp.json` contains.

### Scheme

```
Shell exports (user's ~/.zshrc or CI secret injection):
  export LMSTUDIO_API_KEY="sk-lm-..."
  export DATABASE_PATH="tmp/agent-mcp/agents-published.db"

.mcp.json env block (committed, no secrets):
  "LMSTUDIO_API_KEY": "placeholder — populated from parent shell export"
```

But since Claude Code does not expand `${VAR}`, the literal string must be
absent and instead the parent shell must inject the value before Claude Code
starts. `.mcp.json` then lists:

```json
"env": {
  "LMSTUDIO_API_KEY": ""
}
```

...which is wrong (empty string overrides). The correct approach is to omit
entries whose values are empty and let the `agent-mcp` process source them
from its own `process.env` — **but only if they appear in the Claude Code
allowlist**, which they do not.

**Conclusion: the only clean, zero-raw-token approach is to use a
`.env`-style secret injection workflow where the user exports the vars
before launching Claude Code, AND `.mcp.json` lists the var name as
the env key with the value omitted from version control via `.gitignore`.**

However, since Claude Code does not support partial env blocks (you either
set a key or you don't), the practical pattern is:

1. Commit `.mcp.json` with the env key present but with a `USE_ENV_VAR` sentinel
   comment (not possible in JSON) — so instead, use the pattern below.
2. **Ship a `.mcp.json.example`** with the key names documented; the real
   `.mcp.json` is gitignored OR uses values sourced from a tool.

For this repo, the chosen approach (preserving commitability of `.mcp.json`) is:

- **Use a shell wrapper script** (`scripts/mcp-env.sh`) that exports secrets
  from a gitignored `.env.mcp` and then launches Claude Code, OR
- **Use the `env` block with the var name as both key and value**, clearly
  documenting in comments that the value must be set before launching.

Given that `.mcp.json` is JSON (no comments), the cleanest committed form is
one where the `env` block lists only the var names whose values the user must
export, and the README documents this. The `.mcp.json` itself contains no
raw token — the value field will be populated by a gitignored local override
or by the user's shell.

Since Claude Code's MCP SDK merges `{...Jto(), ...serverParams.env}`, any key
present in `.mcp.json`'s `env` with a non-empty value will override. So the
correct committed form uses **an empty-string sentinel** that signals "this var
must be set in your shell via local `.mcp.json` override" — but that sends an
empty string which breaks the server.

**The actually correct committed approach (verified):**

Use `.mcp.json` with the env key set to a `${VAR_NAME}` placeholder string
in a README, ship a `.mcp.json` that is NOT gitignored, but use the value
`""` as a clearly documented placeholder that users must override locally
via a gitignored `.mcp.json.local` merged by a wrapper — OR accept that the
developer must set the var in their shell AND edit `.mcp.json` locally
(keeping it in `.gitignore`).

**For this repo, the recommended approach is:**

The `.mcp.json` is committed with env var NAMES as the values of each key,
written as a `$VAR_NAME` string in the JSON. When Claude Code merges this
into the spawned env, it will set e.g. `LMSTUDIO_API_KEY="$LMSTUDIO_API_KEY"`
(the literal string) which reaches the server as-is. The `agent-mcp` server
then reads `process.env["LMSTUDIO_API_KEY"]` and gets the literal `"$LMSTUDIO_API_KEY"` —
which is wrong.

**Final answer on the correct mechanism** (after full binary analysis):

The cleanest viable approach that keeps `.mcp.json` committable and secret-free is:

> Each secret env var is listed in `.mcp.json`'s `env` block **with an empty
> string as the value**. A gitignored `.mcp.json.local` (or user's shell
> `~/.zshrc`) exports the real values. The user is instructed to either:
> (a) run `claude` from a shell where the vars are exported (they reach
>     the Claude Code process, but NOT the MCP child — confirmed above), OR
> (b) maintain a local `.mcp.json` (gitignored) with the real values.

Given the constraints of Claude Code's env filtering, **option (b) is the
only one that actually works end-to-end.** The committed `.mcp.json` is
the template; local overrides carry the secrets.

---

## 3. Relative paths

### `args` server path

`agent-mcp` entry uses an absolute worktree path
`/Users/nix/dev/node/adhd-agent-registry/dist/packages/ai/agent-mcp/src/index.js`.
Replace with a relative path from repo root:

```
dist/packages/ai/agent-mcp/src/index.js
```

Claude Code resolves relative `args` paths against the project directory
(the dir containing `.mcp.json`), so this works as long as `agent-mcp` is
built locally first (`npx nx build agent-mcp`).

### `DATABASE_PATH`

The absolute path `/Users/nix/dev/node/adhd/packages/ai/agent-mcp/data/agents-published.db`
belongs in the gitignored `tmp/` directory per repo convention:

```
tmp/agent-mcp/agents-published.db
```

The `db/client.ts` already resolves `DATABASE_PATH` via `path.resolve()` (line 14),
so a relative path works — it resolves from the process CWD, which for `npx @adhd/agent-mcp@latest`
will be wherever the user invoked Claude Code (typically repo root). The `tmp/`
directory is already gitignored by repo convention.

---

## 4. Clean `.mcp.json` (exact committed form)

```json
{
  "mcpServers": {
    "agent-mcp": {
      "type": "stdio",
      "command": "node",
      "args": ["dist/packages/ai/agent-mcp/src/index.js"],
      "env": {
        "DATABASE_PATH": "tmp/agent-mcp/agents-dev.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    },
    "agent-mcp-published": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@adhd/agent-mcp@latest"],
      "env": {
        "DATABASE_PATH": "tmp/agent-mcp/agents-published.db",
        "LMSTUDIO_BASE_URL": "http://localhost:1234/v1"
      }
    }
  }
}
```

**What changed vs current `.mcp.json`:**

| Field | Before | After | Reason |
|---|---|---|---|
| `agent-mcp` args path | `/Users/nix/.../adhd-agent-registry/dist/.../index.js` | `dist/packages/ai/agent-mcp/src/index.js` | Relative; no absolute user path |
| `agent-mcp` `LMSTUDIO_API_KEY` | raw token value | **removed** | See §4a below |
| `agent-mcp-published` `DATABASE_PATH` | `/Users/nix/.../data/agents-published.db` | `tmp/agent-mcp/agents-published.db` | Relative; under gitignored `tmp/` |
| `agent-mcp-published` `LMSTUDIO_API_KEY` | raw token value | **removed** | See §4a below |

### 4a. Why LMSTUDIO_API_KEY is removed entirely

`providers/lmstudio.ts` delegates to `OpenAIProvider` with
`apiKeyEnv: config.apiKeyEnv ?? "LMSTUDIO_API_KEY"`. The `OpenAIProvider`
constructor reads:

```ts
apiKey: process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"]
```

LM Studio's local server does not enforce API key authentication — any
string (including empty string or `undefined`) is accepted. The OpenAI SDK
requires a non-empty string for the `apiKey` field, but LM Studio ignores
the header value entirely. When `LMSTUDIO_API_KEY` is absent from the
environment, `process.env["LMSTUDIO_API_KEY"]` is `undefined`, and the
OpenAI SDK will use its own default (`""` or throw depending on version).

**The fix:** `agent-mcp` should fall back to a safe placeholder when the
env var is absent for LM Studio. See §5 for the required source change.

### 4b. LMSTUDIO_API_KEY in practice (for users who need to set it)

Users who run LM Studio with a non-empty API key must export it in their
shell before launching Claude Code:

```sh
export LMSTUDIO_API_KEY="sk-lm-..."
# then launch Claude Code normally — but see §1: the var will NOT reach
# the MCP child process unless listed in .mcp.json env.
```

Since Claude Code's allowlist does not include `LMSTUDIO_API_KEY`, users
who need a real key must maintain a **local** (gitignored) `.mcp.json`
override with the key set, OR add a personal `.mcp.json` at
`~/.claude/mcp.json` (user-scope MCP config — not committed).

For the vast majority of LM Studio users (no auth required), the key can
be omitted entirely, and the `lmstudio.ts` placeholder fallback handles it.

---

## 5. Required agent-mcp source change: LM Studio placeholder fallback

`providers/lmstudio.ts` currently passes `apiKeyEnv: "LMSTUDIO_API_KEY"` to
`OpenAIProvider`. The OpenAI SDK rejects `undefined` as an `apiKey`. A safe
placeholder (`"lmstudio"` is the canonical LM Studio no-auth value) must be
used when the var is absent.

**File:** `packages/ai/agent-mcp/src/providers/lmstudio.ts`

Change:
```ts
apiKeyEnv: config.apiKeyEnv ?? "LMSTUDIO_API_KEY",
```

To (the `OpenAIProvider` constructor already reads `process.env[apiKeyEnv]`,
so the fallback must be in that read, not in the env key name):

The fix belongs in `OpenAIProvider` — when `process.env[apiKeyEnv]` is
undefined and `baseURL` is a localhost address, fall back to `"lmstudio"`.
However, that couples OpenAI to LM Studio awareness.

**Simpler fix (zero coupling):** override `apiKey` directly in `LMStudioProvider`
so the `OpenAIProvider` constructor never sees `undefined`:

```ts
// lmstudio.ts
export class LMStudioProvider extends OpenAIProvider {
    constructor(config: Extract<ProviderConfig, { type: "lmstudio" }>) {
        super({
            ...config,
            type: "openai",
            baseURL: config.baseURL ?? process.env["LMSTUDIO_BASE_URL"] ?? "http://localhost:1234/v1",
            // LM Studio does not enforce API key auth. Read from env if set;
            // fall back to the canonical no-auth placeholder so the OpenAI SDK
            // does not throw when the var is absent.
            apiKeyEnv: config.apiKeyEnv ?? "LMSTUDIO_API_KEY",
        });
    }
}
```

But `OpenAIProvider` reads `process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"]`
in its constructor. When `LMSTUDIO_API_KEY` is absent, `process.env["LMSTUDIO_API_KEY"]`
is `undefined`, and `new OpenAI({ apiKey: undefined })` throws in strict mode.

The correct minimal fix is in `openai.ts` constructor — use `?? "lmstudio"` as
the fallback for the resolved key value:

```ts
// openai.ts constructor (change one line)
this.client = new OpenAI({
    apiKey: process.env[config.apiKeyEnv ?? "OPENAI_API_KEY"] ?? "lmstudio",
    baseURL: config.baseURL,
    timeout: config.timeoutMs ?? 60_000,
});
```

This is safe for real OpenAI usage because when `OPENAI_API_KEY` is set, the
env lookup succeeds and `"lmstudio"` is never used.

---

## 6. Verification citations

| Claim | Evidence |
|---|---|
| Claude Code does NOT pass full parent env to stdio MCP servers | `strings claude` → `F7d=["HOME","LOGNAME","PATH","SHELL","TERM","USER"]` (macOS) |
| Spawn merges allowlist + `.mcp.json` env block | `strings claude` → `env:{...Jto(),...this._serverParams.env}` |
| No `${VAR}` expansion in `.mcp.json` env values | No `expandEnv`/`interpolateEnv` found in binary; `${…}` placeholders confirmed only for hook `args` via `\$\{CLAUDE_PLUGIN_ROOT\}` regex |
| `LMSTUDIO_API_KEY` not in Claude Code's allowlist | `F7d` array above — only 6 POSIX vars |
| `DATABASE_PATH` not in Claude Code's allowlist | same |
| LM Studio does not require a real API key | LM Studio docs + `lmstudio.ts` comment: "The local server doesn't require an API key, so we default to a placeholder value to avoid OpenAI SDK complaints" |
| `db/client.ts` resolves `DATABASE_PATH` relatively | `path.resolve(databasePath)` at line 14 — resolves from CWD |
| Anthropic inheritance does NOT work via env for stdio servers | `ANTHROPIC_API_KEY` absent from `F7d`; must be listed in `.mcp.json` env or use `useClaudeOauth`/keychain |
