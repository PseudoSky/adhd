---
package: "@adhd/apigen-core-client"
path: "/Users/nix/dev/node/adhd/packages/apigen/apigen-core-client"
root: "adhd"
language: "node"
self_internal: false
current_scope_behavior: "none"
env_vars: []
writes: []
config_files: []
supported_by_env: "no"
gaps: []
value: "low"
effort: "low"
recommend: "skip"
---

## Current state

**Environment variables**: None read. The package is a pure TypeScript library for schema extraction and generation, with no runtime configuration via env vars.

**File writes**: None. The package performs TypeScript analysis (via ts-morph and ts-json-schema-generator) but does not write files, logs, or persistent state to disk.

**Config files**: None. All configuration is passed as function arguments to the public API (`generateSchemas()`, `extract()`, `extractClasses()`, etc.).

**Directories**: None created or managed. The extraction-session module maintains process-lifetime in-memory caches (`_persistentProjects`, `_persistentSchemas`) for performance, but these are ephemeral and require no filesystem.

**Logging**: Optional `pino` Logger is passed in via `PluginInput` (by the consuming CLI or orchestrator), not created or configured by this package. Logs go to stderr/file managed by the caller.

## Proposed `EnvironmentSpec`

Not applicable. This package has zero runtime-configuration surface. There are no env vars, config files, or directory paths to adopt under `@adhd/environment`.

```typescript
// No EnvironmentSpec needed for this package.
// All configuration is API-driven (function arguments).
```

## Gap detail

None. There are no gaps because there is no configuration surface to support.

## File-location table

| Current path | Kind | Proposed env.paths/env.files key | Notes |
|---|---|---|---|
| N/A | N/A | N/A | No files or directories written. |

