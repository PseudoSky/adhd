---
package: @adhd/sox-tokenguard-core
path: /Users/nix/dev/ai/sox-ecosystem/libs/tokenguard-core
root: sox-ecosystem
language: node
self_internal: false
current_scope_behavior: none
env_vars: []
writes: [{path: "${persistPath}/.tmp", kind: data, purpose: "atomic write of token mapping before rename"}, {path: "${persistPath}", kind: data, purpose: "bijective real↔token store (json)"}]
config_files: []
supported_by_env: no
gaps: []
value: low
effort: low
recommend: skip
---

## Current state

**Environment variables:** None. The package reads zero env vars.

**Writes:**
- `Mapper.persistPath` (optional, caller-supplied) + `.tmp`: atomic tmp file created at construction or on each `getOrCreate()` / `registerExplicit()` / `seed()` call (line 219), renamed to final path (line 220).
- Kind: data (token mapping persistence).
- Purpose: bijective real↔token store reload-stable across process restarts.
- Only written if `persistPath` is provided to the Mapper constructor; if undefined, no I/O occurs.

**Config files:** None.

**Scope behavior:** 
- No hardcoded paths. The `persistPath` is entirely caller-controlled (constructor parameter).
- If not provided, the Mapper operates purely in-memory with zero disk I/O.
- Detectors (detectors.ts) are pure functions with zero I/O.

## Proposed EnvironmentSpec

```typescript
// Not proposed — the library does not require @adhd/environment.
// Caller (sox-ecosystem integration) may choose to:
// 1. Drive DetectorConfig via env (optional boolean toggles: detectIpv6, detectPhone)
// 2. Resolve persistPath via env.paths.data or env.paths.state if caller wants standardized location

// If sox-ecosystem wanted to integrate:
interface TokenguardConfig extends EnvironmentSpec<{}> {
  dirs: {
    tokenStore: { kind: 'data' as const },
  },
  files: {
    tokenMapping: { in: 'tokenStore', name: 'token-mapping.json' },
  },
}
```

## Gap detail

None. The package has no environment concerns:
- No env vars read → no G1.
- No hardcoded write paths → no G2.
- Node/TS only → no G3.
- No multi-file config merging → no G4.
- DetectorConfig is two simple booleans (detectIpv6, detectPhone) → no G5.
- No secrets or rotation → no G6.
- All types JSON-Schema primitives → no G7.
- No special directory kinds needed → no G8.
- No remote config sources → no G9.

## File-location table

| current path | kind | proposed env.paths/env.files key |
|---|---|---|
| `${persistPath}` (caller-provided) | data | not applicable; caller owns path selection |
| `${persistPath}.tmp` (intermediate) | data | not applicable; internal atomic rename |

## Recommendation

**Skip adoption.** The library is correctly abstracted: it delegates location decisions to the caller via constructor parameter. No env concerns exist in the library itself. If the caller (sox-ecosystem's tokenguard integration) later wants @adhd/environment for DetectorConfig or standardized persistence location, that is a caller-integration task, not a library change.
