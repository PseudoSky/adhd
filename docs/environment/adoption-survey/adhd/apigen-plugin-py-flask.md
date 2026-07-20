---
package: @adhd/apigen-plugin-py-flask
path: /Users/nix/dev/node/adhd/packages/apigen/apigen-plugin-py-flask
root: adhd
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: []
config_files: []
logging:
  has_logging: true
  logger: console
  persists_log_files: false
  log_destination: stderr only
  structured: true
  error_handling: robust
  maps_to_env_logs: false
supported_by_env: partial
gaps: [G3]
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None explicitly read at plugin level. The entire `process.env` is passed through to the spawned Python subprocess (line 132) as a passthrough mechanism, with `PYTHONPATH` injected. The plugin does not read or validate specific env vars itself.

**Writes:** No file or directory writes from this plugin. The spawned Python subprocess may write files/logs, but that is its domain, not the Node plugin's.

**Config files:** None. Options are passed via `input.options` from CLI (e.g., `--opt port=8000`).

**Configuration surface:**
- `port`: number, default 8000 (line 92)
- `host`: string, default '127.0.0.1' (line 93)
- `namespace`: string, optional, derived from `input.packages[0].id` if not provided (line 103)

All are hardcoded defaults or CLI-supplied; no file-based or cascading config.

**Scope behavior:** Hardcoded. Port/host have inline defaults; Python environment is resolved via `@adhd/apigen-python-env` (ensurePythonEnv), a managed dependency.

## Proposed `EnvironmentSpec`

```typescript
const pyFlaskPluginSpec: EnvironmentSpec<{
  port: number;
  host: string;
  namespace?: string;
}> = {
  config: [
    {
      key: 'port',
      type: 'integer',
      default: 8000,
      minimum: 1,
      maximum: 65535,
      env: 'ADHD_APIGEN_PLUGIN_PY_FLASK_PORT',
      at: 'runtime',
    },
    {
      key: 'host',
      type: 'string',
      default: '127.0.0.1',
      env: 'ADHD_APIGEN_PLUGIN_PY_FLASK_HOST',
      at: 'runtime',
    },
    {
      key: 'namespace',
      type: 'string',
      env: 'ADHD_APIGEN_PLUGIN_PY_FLASK_NAMESPACE',
      at: 'runtime',
    },
  ],
  envPrefixOverride: 'ADHD_APIGEN_PLUGIN_PY_FLASK',
};
```

## Gap detail

**G3:** This is a Node plugin that spawns a Python subprocess. The Python process (`apigen_python.flask_server`, invoked line 120) runs independently; `@adhd/environment` has no Python implementation. Any config that lives in the Python subprocess cannot be managed by the Node-side environment spec. Adoption here would cover only the Node plugin's own options (port/host/namespace), not the Python subprocess's runtime configuration or logging.

## Logging audit

This plugin emits logs via the spawned Python process's stderr, forwarded raw to `process.stderr` (lines 139–141). It also reads stdout for a JSON `{"ready":true}` readiness signal (structured, but read-only for detection, not logged). All logs are plaintext character-by-character, with no file persistence at the Node level. The Python server may write its own logs to disk, but that is outside this plugin's scope. No try/catch or explicit error logging; errors are thrown and propagated to the caller.

**Would it benefit from `env.paths.logs`?** Only if this plugin were responsible for capturing and persisting the Python server's stderr/stdout. Currently it just forwards stderr to parent stderr, so no persistent log destination would improve this setup. The Python server should have its own log management.

## File-location table — corrected to the new standard

| current path | kind | new-standard path (global scope) | env accessor |
|---|---|---|---|
| (none — options from CLI) | config | N/A (runtime option passthrough, not files) | — |

*Project scope:* Same structure rooted at `<projectRoot>/.adhd/apigen-plugin-py-flask/default/…` when active scope is `project`.
