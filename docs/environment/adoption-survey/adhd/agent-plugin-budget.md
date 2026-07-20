---
package: "@adhd/agent-plugin-budget"
path: /Users/nix/dev/node/adhd/packages/agent/agent-plugin-budget
root: adhd
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: []
config_files: []
supported_by_env: no
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

No environment variables read. No files or directories written. No config files referenced.

The package is a **plugin library** consumed by `@adhd/agent-mcp`. It receives all configuration via a `PluginContext` parameter passed by the host at instantiation (see `createPlugin` factory, line 836). Config schema is Zod-validated (pluginConfigSchema, line 75) but entirely caller-supplied; the plugin does not read or manage any runtime state, paths, or environment.

A `db` parameter (SQLite-like instance) is passed in for scope-aware budget tracking, but the plugin does not manage or create this database — it only queries it.

## Proposed `EnvironmentSpec`

N/A. This plugin has zero runtime configuration surface. Adoption would serve no purpose.

## Gap detail

None. The plugin does not attempt any of the use cases `@adhd/environment` covers.

## File-location table

| current path | kind | proposed env.paths/env.files key |
|---|---|---|
| (none) | (none) | (none) |
