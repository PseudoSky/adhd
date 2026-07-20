---
package: @adhd/sox-extension-tokenguard
path: /Users/nix/dev/ai/sox-ecosystem/extensions/services/tokenguard
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: [SOX_CONFIG_PORT, SOX_CONFIG_UPSTREAM, SOX_CONFIG_CAPTURE, SOX_CONFIG_CAPTURE_MAX_BYTES, SOX_CONFIG_PROVIDER, SOX_CONFIG_MAP_PATH, SOX_CONFIG_CAPTURE_DIR, SOX_CONFIG_SEEDS, SOX_CONFIG_NEVER, SOX_CONFIG_DETECT_PHONE, SOX_CONFIG_DETECT_IPV6, SOX_PERM_ENFORCE, SOX_PERM_FS_READ, SOX_PERM_FS_WRITE, HOME]
writes: [{path: ~/.tokenguard/token-mapping.json, kind: data, purpose: persistent live token-identifier map}, {path: ~/.tokenguard/audit.jsonl, kind: logs, purpose: tokenization audit trail with leak detection}, {path: ~/.tokenguard/port.txt, kind: run, purpose: bound port number written after listen}]
config_files: []
logging:
  has_logging: true
  logger: custom
  persists_log_files: true
  log_destination: ~/.tokenguard/audit.jsonl (structured JSON-per-line) + stderr (plaintext)
  structured: partial
  error_handling: robust
  maps_to_env_logs: true
supported_by_env: partial
gaps: [G1, G2]
value: high
effort: med
recommend: adopt
---

## Current State

**Environment variables** (all SOX_CONFIG_* scope):
- `SOX_CONFIG_PORT` · read in config.ts:52 · default 9099 · integer port for proxy server, walks +1 to +9 if occupied
- `SOX_CONFIG_UPSTREAM` · read in config.ts:53 · default 'https://api.anthropic.com' · upstream API base URL
- `SOX_CONFIG_CAPTURE` · read in config.ts:54 · default 'truncated' · body capture mode: 'full'|'truncated'|'none'
- `SOX_CONFIG_CAPTURE_MAX_BYTES` · read in config.ts:55 · default 4096 · max bytes per body in truncated mode
- `SOX_CONFIG_PROVIDER` · read in config.ts:56 · default 'anthropic' · adapter selector: 'anthropic'|'generic'
- `SOX_CONFIG_MAP_PATH` · read in config.ts:57 · default `~/.tokenguard/token-mapping.json` · file path (tilde-expanded)
- `SOX_CONFIG_CAPTURE_DIR` · read in config.ts:58 · default `~/.tokenguard` · directory for audit.jsonl (tilde-expanded)
- `SOX_CONFIG_SEEDS` · read in config.ts:59 · default [] · JSON array of pre-seeded {real, type, token}
- `SOX_CONFIG_NEVER` · read in config.ts:60 · default [] · JSON array of identifiers never to tokenize
- `SOX_CONFIG_DETECT_PHONE` · read in config.ts:61 · default false · boolean detector toggle
- `SOX_CONFIG_DETECT_IPV6` · read in config.ts:62 · default true · boolean detector toggle
- `SOX_PERM_ENFORCE` · read in index.ts:82 · boolean gate · if set, enforces policy checks via SOX_PERM_FS_* patterns
- `SOX_PERM_FS_READ` · read in index.ts:99 · JSON array of glob patterns · permitted fs read paths
- `SOX_PERM_FS_WRITE` · read in index.ts:100 · JSON array of glob patterns · permitted fs write paths
- `HOME` · read in config.ts:81, cli.ts:30, index.ts:35 · fallback '/tmp' · used for tilde expansion in all paths

**Writes**:
- `~/.tokenguard/token-mapping.json` · kind: data · persistent live token map (serialized Mapper state) · written atomically via tmp-rename in mapstore.ts:34-37, continuously flushed every 30s in index.ts:269-278
- `~/.tokenguard/audit.jsonl` · kind: logs · audit trail (one JSON object per line, event type + leak count + optional body) · appended in proxy.ts:48-53
- `~/.tokenguard/port.txt` · kind: run · bound port number · written once after listen in proxy.ts:189-195, cleaned up on shutdown in index.ts:287

**Scope/path decision**: Hardcoded home-relative (`~/.tokenguard` base). Tilde expansion via `path.replace(/^~/, home)` where `home = process.env['HOME'] ?? '/tmp'`. No project-scoped or instance-scoped paths; all instances share the same `~/.tokenguard`.

**Config flow**: Three entry points bifurcate in index.ts:314-330:
1. Direct CLI: `node dist/index.js seed <real> <type>` reads from process.argv + resolveMapPath() [cli.ts:28-40]
2. MCP exec mode: stdin piped, no SOX_CONFIG_PORT → runMcpCli() with JSON-RPC 2.0 stdio protocol
3. Service mode: HTTP proxy, resolveConfig() called once in main() [index.ts:218]

## Proposed EnvironmentSpec

```typescript
export const tokenguardSpec: EnvironmentSpec<TokenGuardConfig> = {
  config: {
    port: {
      type: 'integer',
      env: 'PORT',  // or keep SOX_CONFIG_PORT via envPrefixOverride
      default: 9099,
      minimum: 1024,
      maximum: 65535,
      at: 'runtime',
    },
    upstream: {
      type: 'string',
      env: 'UPSTREAM',
      default: 'https://api.anthropic.com',
      at: 'runtime',
    },
    capture: {
      type: 'string',
      enum: ['full', 'truncated', 'none'],
      env: 'CAPTURE',
      default: 'truncated',
      at: 'runtime',
    },
    captureMaxBytes: {
      type: 'integer',
      env: 'CAPTURE_MAX_BYTES',
      default: 4096,
      minimum: 0,
      at: 'runtime',
    },
    provider: {
      type: 'string',
      enum: ['anthropic', 'generic'],
      env: 'PROVIDER',
      default: 'anthropic',
      at: 'runtime',
    },
    detectPhone: {
      type: 'boolean',
      env: 'DETECT_PHONE',
      default: false,
      at: 'runtime',
    },
    detectIpv6: {
      type: 'boolean',
      env: 'DETECT_IPV6',
      default: true,
      at: 'runtime',
    },
    seeds: {
      type: 'array',
      items: { type: 'object' },
      env: 'SEEDS',
      default: [],
      at: 'build',  // seeding happens on init
    },
    never: {
      type: 'array',
      items: { type: 'string' },
      env: 'NEVER',
      default: [],
      at: 'build',
    },
  },
  dirs: {
    data: { kind: 'data', namespace: 'default', share: 'per-instance' },
    logs: { kind: 'logs', namespace: 'default', share: 'per-instance' },
    run: { kind: 'run', namespace: 'default', share: 'per-instance' },
  },
  files: {
    mapFile: { in: 'data', name: 'token-mapping.json' },
    portFile: { in: 'run', name: 'port.txt' },
    auditLog: { in: 'logs', name: 'audit.jsonl' },
  },
  envPrefixOverride: 'SOX_CONFIG',
  secret: {
    upstream: true,  // API base URL may embed credentials
  },
};
```

## Gap Detail

**G1** — `HOME` is a standard POSIX env var, not `SOX_CONFIG_*` scoped. The package reads it for tilde expansion fallback (line 81 in config.ts, lines 30 in cli.ts, line 35 in index.ts). The prefix model (`isEnvNameAllowed(name)`) cannot guard `HOME` without special-casing it, so it must either be:
  - left as a direct env read (accepted standard), or
  - mapped to a SOX-scoped alias like `SOX_HOME` at the installer level

**G2** — Hardcoded home-relative path `~/.tokenguard` (config.ts:82-83, cli.ts:32). No per-instance, per-scope, or per-project isolation. Multiple tokenguard instances or test runs collide. The `@adhd/environment` scheme (`~/.adhd/<project>/<namespace>/…`) would isolate them and enable concurrent runs.

## Logging Audit

The package **does emit logs** and **does persist them to disk**. Logging implementation:

- **Stderr messages** (plaintext, unstructured): "tokenguard: listening on …", "tokenguard: WARN leak detected: …", "tokenguard: map reloaded …" via `process.stderr.write()` [index.ts:248, proxy.ts:196, 254, 317; cli.ts:256]. Error handling is present (e.g., try/catch around file ops in index.ts:270-278, mapstore.ts:120-126, proxy.ts:190-195).
- **Audit log** (`~/.tokenguard/audit.jsonl`, structured JSON-per-line): One object per event type (outbound/inbound/error). Fields: ts, event, path, leak_count, outbound_size, inbound_size, outbound_body (optional, truncated per capture mode), inbound_body (optional). Written via `appendFileSync` [proxy.ts:48-53], with best-effort error handling (no crash on audit failure).

**Structured vs. plaintext**: Audit log is fully structured (JSON); stderr is plaintext. Error handling is **robust**: try/catch blocks around all file ops with fallback behavior (e.g., line 52 in proxy.ts: "best-effort — never crash on audit failure"; line 275 in index.ts: "catch { // best-effort }").

**Would benefit from env.paths.logs**: Yes. Today audit.jsonl is hardcoded to `~/.tokenguard/audit.jsonl`, which collides across instances and is not isolable per environment. Adoption of `env.paths.logs` (kind:`logs`, `share:'per-instance'`) would place it at `~/.adhd/sox-extension-tokenguard/default/logs/audit.jsonl` (global scope) or `<project>/.adhd/sox-extension-tokenguard/default/logs/audit.jsonl` (project scope), enabling multi-instance isolation and per-environment containment.

## File-Location Table — Corrected to New Standard

| Current Path | Kind | New-Standard Path (Global Scope) | Env Accessor |
|---|---|---|---|
| `~/.tokenguard/token-mapping.json` | data | `~/.adhd/sox-extension-tokenguard/default/data/token-mapping.json` | `env.files.mapFile` |
| `~/.tokenguard/audit.jsonl` | logs | `~/.adhd/sox-extension-tokenguard/default/logs/audit.jsonl` | `env.paths.logs + '/audit.jsonl'` |
| `~/.tokenguard/port.txt` | run | `~/.adhd/sox-extension-tokenguard/default/run/port.txt` | `env.files.portFile` |
| `~/.tokenguard/` (dir) | data/logs/run | `~/.adhd/sox-extension-tokenguard/default/` | `env.paths.data`, `env.paths.logs`, `env.paths.run` |

**Project-scope variant**: When the active scope is `project` (auto-detected by `.git`/`.adhd` marker or `ADHD_ENV_SCOPE=project`), the same subtree roots at `<projectRoot>/.adhd/sox-extension-tokenguard/default/…` — e.g. `./.adhd/sox-extension-tokenguard/default/data/token-mapping.json` (instead of `~/.adhd/…`).
