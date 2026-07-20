---
package: @adhd/dispatch-serializer-json
path: /Users/nix/dev/node/adhd/packages/dispatch/dispatch-serializer-json
root: adhd
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: [{path: "caller-provided dagPath (defaults to <filePath>.dag.json)", kind: data, purpose: "Stores dispatch DAG as JSON"}, {path: "caller-provided snapshotPath (defaults to <filePath>.snapshot.json)", kind: data, purpose: "Stores DAG snapshot as JSON"}]
config_files: []
supported_by_env: no
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None read.

**File writes:**
- `dagPath` (argument-derived, default: `{filePath}.dag.json`) · data · Serialized DAG state
- `snapshotPath` (argument-derived, default: `{filePath}.snapshot.json`) · data · Serialized DAG snapshot
- `.{filename}.tmp` · data · Temporary file (cleaned up by atomic rename)

**Scope decision:** Caller supplies `filePath` argument to `createJsonFileSerializer(filePath)`. No path scope decided by this package.

**Config files:** None.

## Proposed `EnvironmentSpec`

N/A — this package is a pure serializer library, not a runtime. File paths are caller-supplied arguments (`filePath`). Scope and persistence are caller concerns, not this package's.

## Gap detail

No gaps; the package makes no directory or configuration decisions.

## File-location table

| current path | kind | proposed env.paths/env.files key |
|---|---|---|
| caller-provided dagPath | data | N/A (caller scope) |
| caller-provided snapshotPath | data | N/A (caller scope) |
| .{filename}.tmp | data | (ephemeral, not persisted) |

