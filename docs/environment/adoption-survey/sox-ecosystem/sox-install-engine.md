---
package: @adhd/sox-install-engine
path: /Users/nix/dev/ai/sox-ecosystem/libs/install-engine
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: [SOX_ECOSYSTEM_HOME]
writes: [{path: ~/.adhd/sox-ecosystem, kind: config}, {path: ~/.adhd/sox-ecosystem/run, kind: run}, {path: ~/.adhd/sox-ecosystem/ext, kind: data}]
config_files: [extensions.json, extensions.lock, extensions.local.json, extensions.local.lock, org.extensions.json, org.extensions.lock, ledger.json, ownership.json, install-registry.json, supervisors.json]
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: stdout/stderr only
  structured: false
  error_handling: robust
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G2]
value: high
effort: med
recommend: adopt-after-gap
---

## Current State

### Environment Variables
- **SOX_ECOSYSTEM_HOME** · read in `data-paths.ts:userDataRoot()` · default: `~/.adhd/sox-ecosystem/` if unset

The package DOES NOT read any ADHD_-prefixed env vars. It uses a hardcoded lookup for `SOX_ECOSYSTEM_HOME`.

### Write Paths
The package writes ONLY under a single root resolved via `dataRoot(scope, root?)`:

| Scope | Root |
|-------|------|
| `user` | `$SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`) |
| `project` | `<repo>/.adhd/sox-ecosystem/` |
| `org` | `<root>/.adhd/sox-ecosystem/` (explicit root) or `$SOX_ECOSYSTEM_HOME` |
| `local` | `<root>/.adhd/sox-ecosystem/` (explicit root) |

All scoped paths below `<dataRoot>/`:
- `extensions.json` / `extensions.lock` (project/user/org scopes)
- `extensions.local.json` / `extensions.local.lock` (local scope)
- `ledger.json` — per-scope provenance ledger (persisted to disk to track sox-owned changes)
- `ownership.json` — per-scope ownership index
- `ext/<ext>@<version>/` — materialized extension store (built code at versioned paths)
- `ext/<ext>@latest` — symlink to latest version

### Global User-Scope Paths
- `<userDataRoot>/install-registry.json` — global install ledger
- `<userDataRoot>/supervisors.json` — supervisor registry
- `<userDataRoot>/run/` — runtime directory (locks, runtime.json, sockets)
- `<userDataRoot>/run/logs/<supervisorId>/` — per-supervisor log directory
- `<userDataRoot>/run/supervisors/` — exec-socket directory

### Config Files
The `config-merge` capability accepts an absolute `filePath` for shared config files (JSON or TOML, detected by extension `.toml`). It handles:
- `.mcp.json` (MCP server config)
- `settings.json` (Claude settings)
- `~/.claude.json` (global Claude config)
- `codex config.toml` (Codex TOML config)

The caller provides the absolute path; sox-install-engine does NOT discover or enumerate config files. It only merges keys into files it is explicitly asked to touch.

### Current Scope Behavior
**Hardcoded flow:** The data root is hardcoded per scope via `data-paths.ts` — `SOX_ECOSYSTEM_HOME` for user scope, `<repo>/.adhd/sox-ecosystem/` for project/org/local. Scopes are explicit; there is no marker-based auto-detection (`.git`, `.adhd`). Scope selection is caller-specified.

---

## Proposed `EnvironmentSpec`

```typescript
export const SOX_INSTALL_ENGINE_ENV_SPEC: EnvironmentSpec<{
  socksEcosystemHome: string;
  currentScope: 'org' | 'user' | 'project' | 'local';
  workspaceRoot?: string;
}> = {
  name: 'sox-install-engine',
  platform: 'node',
  envPrefixOverride: 'SOX_ECOSYSTEM',
  config: {
    socksEcosystemHome: {
      type: 'string',
      env: 'SOX_ECOSYSTEM_HOME',
      at: 'runtime',
      default: () => path.join(os.homedir(), '.adhd', 'sox-ecosystem'),
      description: 'User/global data root for sox installs; defaults to ~/.adhd/sox-ecosystem/',
    },
    currentScope: {
      type: 'string',
      env: 'SOX_ECOSYSTEM_SCOPE',
      at: 'runtime',
      default: 'user',
      enum: ['org', 'user', 'project', 'local'],
      description: 'Install scope: user (global), project (repo-local), org, or local',
    },
    workspaceRoot: {
      type: 'string',
      env: 'SOX_WORKSPACE_ROOT',
      at: 'runtime',
      description: '[Optional] Workspace root for project-ledger portability (defaults to REPO_ROOT)',
    },
  },
  dirs: {
    configRoot: { kind: 'config', share: 'per-instance' },
    lockRoot: { kind: 'state', share: 'per-instance' },
    storeRoot: { kind: 'data', share: 'per-instance' },
    runDir: { kind: 'run', share: 'per-instance' },
    logDir: { kind: 'logs', share: 'per-instance' },
  },
  files: [
    { name: 'ledger', in: 'configRoot', kind: 'state' },
    { name: 'ownership', in: 'configRoot', kind: 'state' },
    { name: 'installRegistry', in: 'configRoot', kind: 'state' },
    { name: 'supervisors', in: 'configRoot', kind: 'state' },
  ],
};
```

This spec captures:
- `SOX_ECOSYSTEM_HOME` as a string config field (runtime re-read)
- Per-scope data dirs under `env.paths.configRoot`, `env.paths.storeRoot`, `env.paths.runDir`, `env.paths.logDir`
- Ledger/ownership/registry files under `env.files.ledger` etc.
- Scope selection via `SOX_ECOSYSTEM_SCOPE` (or caller-supplied, if the API remains dual-mode)

---

## Gap Detail

**G1: Non-ADHD env vars**
The package reads arbitrary `process.env[varName]` in `install.ts:resolveEnvRef()` to resolve values like `${OPENAI_API_KEY}` from config fields. These are not ADHD_ECOSYSTEM_* -prefixed and would need a separate mechanism (e.g., `env.resolveEnvName()` guard or an explicit `secretEnvVars` list in the cascade config). Currently unconstrained; could be any env var the caller embeds in config.

**G2: Caller-supplied absolute paths**
The `config-merge` capability accepts an absolute file path `ctx.target.filePath` for any shared config file (`.mcp.json`, `settings.json`, etc.). The caller determines what path to merge into; sox-install-engine does not constrain it. Paths OUTSIDE the `.adhd/sox-ecosystem/` tree (e.g., `~/.claude.json`, `~/.mcp.json`) are written directly. These are not managed by `@adhd/environment` today. If a second package also merges into `~/.claude.json`, the ledger ensures **only** sox-owned keys are deleted on uninstall, but the file itself lives outside any scope root.

---

## Logging Audit

**Has logging:** Yes. The package uses `console.error()` and `console.warn()` throughout.

**Logger mechanism:** `console` (stdout/stderr) only. No logger library (pino, winston, log4js, custom).

**Persists log files:** No. All output is transient (stdout/stderr).

**Log destination:** stdout/stderr only. There is no persistent `.log` file. Examples:
- `console.error(\`install: ERROR parsing config at ${configPath}: ${String(e)}\`)`
- `console.warn(\`install: WARNING env var \${${varName}} is not set\`)`
- `console.log(\`install: skipping disabled extension "${entry.id}"\`)`

**Structured:** No. All logs are plaintext.

**Error handling:** Robust. The package uses try/catch blocks (e.g., when parsing config/lockfile JSON), logs errors with context, and exits with `process.exit(1)` when config is malformed. Example:
```typescript
try {
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw) as ScopeConfig;
} catch (e) {
  console.error(\`install: ERROR parsing config at ${configPath}: ${String(e)}\`);
  process.exit(1);
}
```

**Would benefit from env.paths.logs:** Yes. The package emits diagnostic output only to stdout/stderr. A persisted `env.paths.logs` directory (`kind: logs`, `share: per-instance`) would allow:
- Capturing install/uninstall operation logs to `~/.adhd/sox-install-engine/logs/install-<timestamp>.log`
- Per-supervisor logs in `~/.adhd/sox-ecosystem/run/logs/<supervisorId>/`
- Structured JSON logs if rotation or aggregation is needed

Current behavior is console-only; adopting persistent logs would improve auditability of sox ecosystem operations.

---

## File-Location Table — New Standard

| Current Path | Kind | New-Standard Path (global scope) | Env Accessor |
|---|---|---|---|
| `$SOX_ECOSYSTEM_HOME/extensions.json` | config | `~/.adhd/sox-install-engine/default/config/extensions.json` | `env.files.extensionsConfig` |
| `$SOX_ECOSYSTEM_HOME/extensions.lock` | state | `~/.adhd/sox-install-engine/default/state/extensions.lock` | `env.files.extensionsLock` |
| `$SOX_ECOSYSTEM_HOME/extensions.local.json` | config | `~/.adhd/sox-install-engine/default/config/extensions.local.json` | `env.files.extensionsLocalConfig` |
| `$SOX_ECOSYSTEM_HOME/extensions.local.lock` | state | `~/.adhd/sox-install-engine/default/state/extensions.local.lock` | `env.files.extensionsLocalLock` |
| `$SOX_ECOSYSTEM_HOME/org.extensions.json` | config | `~/.adhd/sox-install-engine/default/config/org.extensions.json` | `env.files.orgExtensionsConfig` |
| `$SOX_ECOSYSTEM_HOME/org.extensions.lock` | state | `~/.adhd/sox-install-engine/default/state/org.extensions.lock` | `env.files.orgExtensionsLock` |
| `$SOX_ECOSYSTEM_HOME/ledger.json` | state | `~/.adhd/sox-install-engine/default/state/ledger.json` | `env.files.ledger` |
| `$SOX_ECOSYSTEM_HOME/ownership.json` | state | `~/.adhd/sox-install-engine/default/state/ownership.json` | `env.files.ownership` |
| `$SOX_ECOSYSTEM_HOME/install-registry.json` | state | `~/.adhd/sox-install-engine/default/state/install-registry.json` | `env.files.installRegistry` |
| `$SOX_ECOSYSTEM_HOME/supervisors.json` | state | `~/.adhd/sox-install-engine/default/state/supervisors.json` | `env.files.supervisors` |
| `$SOX_ECOSYSTEM_HOME/ext/` | data | `~/.adhd/sox-install-engine/default/data/ext/` | `env.paths.storeRoot` |
| `$SOX_ECOSYSTEM_HOME/run/` | run | `~/.adhd/sox-install-engine/default/run/` | `env.paths.runDir` |
| `$SOX_ECOSYSTEM_HOME/run/logs/` | logs | `~/.adhd/sox-install-engine/default/logs/` | `env.paths.logDir` |

**Project-scope variant:** When active scope is `project` (auto-detected by `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`), substitute the global scope with `<projectRoot>/.adhd/sox-install-engine/<namespace>/…` (e.g. `<repo>/.adhd/sox-install-engine/default/state/ledger.json`). The `namespace` is `default` unless explicitly declared.

**Note:** This package currently lives in `sox-ecosystem` root and handles its own paths via `data-paths.ts` (hardcoded `.adhd/sox-ecosystem/` subdir). Adoption of `@adhd/environment` would:
1. Rename the user-scope root from `~/.adhd/sox-ecosystem/` to `~/.adhd/sox-install-engine/default/` (or keep `sox-ecosystem` as the namespace, i.e. `~/.adhd/sox-install-engine/sox-ecosystem/`)
2. Unify scope resolution so that project-scope ledgers live in `<repo>/.adhd/sox-install-engine/default/state/ledger.json`
3. Enable the caller to override scope and root via `SOX_ECOSYSTEM_SCOPE` env var or explicit `EnvironmentSpec` config
