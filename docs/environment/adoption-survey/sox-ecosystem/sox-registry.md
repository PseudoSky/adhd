---
package: @adhd/sox-registry
path: /Users/nix/dev/ai/sox-ecosystem/libs/registry
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: hardcoded
env_vars: []
writes: [{path: "registry/index.json", kind: "config", purpose: "Registry index"}, {path: "registry/", kind: "config", purpose: "Directory for index"}]
config_files: ["registry/index.json"]
supported_by_env: no
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None.

**Writes:**
- `<root>/registry/index.json` · config · JSON array of RegistryIndexEntry; written by `writeIndex()`, which creates the directory if missing.
- `<root>/extensions/<typeDir>/<extId>/extension.json` · config · Extension manifests; read-only (drift checking only).

**Config files:** `registry/index.json` (JSON array schema defined inline as `RegistryIndexEntry[]`).

**Scope behavior:** Pure utility library. All paths are relative to a `root` parameter passed to `loadIndex()`, `writeIndex()`, and `detectDrift()`. No environment variables, no hardcoded absolute paths, no global config. Callers provide the root and manage scope.

## Proposed EnvironmentSpec

This library does not manage its own configuration or directories. It is a utility that operates on caller-provided root paths. No adoption needed.

If a **caller** of sox-registry wants to centralize registry and extensions roots, the caller package (not sox-registry) should adopt environment with named `dirs` and pass the resolved paths to sox-registry functions.

## Gap detail

None. All behavior is parameter-driven and scoped by the caller.

## File-location table

| Current path | Kind | Proposed env.paths/env.files key |
|---|---|---|
| `<root>/registry/` | config | Caller-managed (not applicable) |
| `<root>/registry/index.json` | config | Caller-managed (not applicable) |
| `<root>/extensions/` | data | Caller-managed (not applicable) |
