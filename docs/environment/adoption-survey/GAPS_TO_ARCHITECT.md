## Items Requiring Architectural Design

These items were surfaced during the sox-ecosystem adoption survey gap
analysis but need further architectural design before they can be specified
as concrete `@adhd/environment` API changes. They are separated from the
`GAP_SPECS.md` document because their requirements are not yet stable enough
for implementation.

---

### 1. G-3 — Dynamic / Extension Config via Env Var Auto-Scaffolding

**Status:** `NEEDS ARCHITECTURE`

**Problem:**
Several sox-ecosystem packages need open-ended configuration mappings where
keys are determined at runtime (extension manifests, provider-specific options,
service config). The agent's original approach used a `type: 'record'` field
with an `envPrefix` that scanned `process.env` for matching vars and collected
them into a `Record<string, string>`.

**Proposed alternative (preferred direction):**
Instead of a specific field type, `@adhd/environment` should **automatically
scaffold config entries from env var naming conventions**. Structured env var
names delimited by `_` map to config tree locations:

```
SOX_CONFIG_TOKENGUARD_PORT       → config.extension.tokenguard.port
SOX_EMBED_BGE_MODEL_CACHE_DIR    → config.embed.bge-model.cache-dir
ADHD_SOX_HOST_RUNTIME_LOG_LEVEL  → config.host-runtime.log.level
```

**Questions to architect:**

1. **Naming convention:** What delimiter(s) trigger scaffolding? Single `_` is
   ambiguous with existing env var names like `SOX_ECOSYSTEM_HOME`. Options:
   - Double underscore (`__`) as hierarchy separator (e.g., `SOX_CONFIG__TOKENGUARD__PORT`)
   - Single `_` for the prefix boundary, then `__` for hierarchy (e.g.,
     `ADHD_SOX__HOST_RUNTIME__LOG_LEVEL`)
   - A configurable separator character on `EnvironmentSpec`

2. **Prefix scope:** Which prefix triggers scaffolding? Options:
   - Only the project prefix (`ADHD_<PROJECT>_*` → parsed as config tree)
   - Also external env vars explicitly allowed via `externalEnv` or `FieldSpec.env`
   - A dedicated `scaffoldPrefix` on `EnvironmentSpec` separate from the env prefix

3. **Type inference:** Scaffolded entries have no `FieldSpec` — no declared type.
   How does the resolver infer value types? Options:
   - Treat all as `string` (caller casts)
   - Heuristic parsing (parseInt for numeric, parseBool for `true`/`false`, JSON
     parse for `{`/`[`-prefixed)
   - A secondary schema that declares the types of scaffolded subtrees

4. **Cascade precedence:** Where do scaffolded entries sit in the existing
   config cascade (code defaults → file → env)? Options:
   - Same layer as other env-sourced values (lowest precedence among env)
   - A dedicated scaffold layer below explicit `FieldSpec` env vars but above
     file defaults — so explicit `FieldSpec.env` overrides scaffolded entries
     for the same key

5. **Interaction with existing `FieldSpec`s:** If a scaffolded key happens to
   match a declared `FieldSpec` path, the `FieldSpec` wins (typed, documented).
   Is this automatic or must the resolver detect conflicts?

6. **Record-field simplification:** With auto-scaffolding, do we still need the
   `type: 'record'` field type from the original G-3 proposal, or does
   scaffolding fully subsume it?

**Related:** sox-extension-tokenguard's `SOX_CONFIG_*` cascade,
sox-embedding-provider's `config.options` open map.

---

### 2. G-9 — Memory Allowlist Bridge

**Status:** `NEEDS ARCHITECTURE`

**Problem:**
`sox-memory-core` enforces a hardcoded allowlist `~/.memory/**` in `backup.ts`
for backup/dump destination paths. When memory store paths move from
`~/.memory/` to `.adhd/sox-ecosystem/memory-core/...` (or the env-resolved
equivalent), the allowlist will reject the new location.

**This is not an `@adhd/environment` gap** — the env resolves paths, it does
not enforce security policy. The bridge belongs in `@adhd/sox-config`'s design.

**Questions to architect:**

1. **Where does the allowlist live?** Options:
   - In `@adhd/sox-config/memory.ts`, exposed as a utility function that
     returns both old and new roots during migration
   - In the memory-server permission guard, configured at startup
   - In a sox-core security module shared across memory packages

2. **How does the permission guard learn the active roots?** Options:
   - Reads them from the resolved env snapshot
   - Receives them as a constructor argument
   - Imports `@adhd/sox-config` directly

3. **Migration lifecycle:** The bridge must accept both old (`~/.memory/`)
   and new (env-resolved) roots during the transition period, then remove the
   old root once all stores have migrated. How is this coordinated?

   - Who decides when migration is complete?
   - What happens if a backup/dump is attempted during migration that reads
     an old-format path but the bridge has already removed it?
   - Is there a feature flag, or is it purely time-based?

4. **Does the `allowlistRoots` pattern generalize?** The agent's original
   proposal added `allowlistRoots` to `EnvironmentOptions` (the env constructor).
   This does not belong in a generic config library. If other packages have
   similar path-allowlist needs, is there a general pattern, or is memory-store
   the only one?

**Related:** `libs/memory-core/src/backup.ts:70-78` (`memoryAllowlistRoot`),
`libs/memory-core/src/backup.ts:78` (`isPathInMemoryAllowlist`).

---

### 3. G-7 — Extended Value Types (closed, no action)

**Status:** `NO GAP — CLOSED`

The agent's original G-7 proposed nullable union types (`string | null`),
function-type annotations, nested objects, and template string interpolation
in `FieldSpec`. All four collapse on inspection:

| Claim | Verdict | Reason |
|-------|---------|--------|
| Nullable unions (`string \| null`) | No gap | `required: false` already handles absent values. There is no sox field where `null` is semantically different from `undefined`. |
| Function types (`onDead`) | No gap | Code-level callback, never env-configurable. Callbacks are passed directly to constructors, not resolved from env vars. |
| Nested objects with arbitrary keys | No gap | Covered by auto-scaffolding approach (item 1 above) |
| Template string interpolation (`${var}`) | No gap | Path templates are constructed by `@adhd/sox-config` resolvers programmatically, not resolved from env var strings at runtime |

No `@adhd/environment` API changes needed. Remove from all planning.

---

### 4. `FileSpec.ensureParent` (from G-2)

**Status:** `NEEDS ARCHITECTURE`

**Problem:**
The original G-2 spec included `FileSpec.ensureParent?: boolean` — a flag on
the file schema that tells the resolver to `mkdirSync({recursive: true})` on
the parent directory before writing, even when the path is outside the scoped
root.

**Objection:**
`mkdirSync` is a runtime implementation concern, not a config schema concern.
The env's job is to resolve paths to strings. Deciding whether to create
directories before writing to them is the caller's responsibility.

**Questions to architect:**

1. Is there any legitimate reason for a config schema to express directory
   creation intent? Examples from other systems:
   - Some init systems (systemd tmpfiles.d) declare directory creation as
     a first-class operation
   - Container runtimes sometimes auto-create host paths
   - A "config surface" for a service that must ensure its data directory
     exists before accepting requests

2. If yes, should this be:
   - A property on `DirSpec` (not `FileSpec`), since creating the directory
     is the operation — the file comes after?
   - A utility function in `@adhd/environment` (like `env.ensureDirectories()`)
     that callers invoke explicitly, rather than implicit behavior during
     path resolution?
   - Left entirely to caller code (status quo)?

**Current recommendation:** Leave directory creation to callers. Do not add
`ensureParent` or similar fields to `FileSpec`/`DirSpec`.

---

### 5. CLI Flag Integration with the Env Cascade (from G-6 `sources.cli`)

**Status:** `NEEDS ARCHITECTURE`

**Problem:**
The original G-6 spec included a `sources.cli` section that would allow
`EnvironmentSpec` to declare CLI flag → config key mappings, integrating
argv-parsed values into the env cascade at a declared precedence level.

**Objection:**
CLI flag parsing is the job of the CLI framework (yargs, commander, etc.),
not the environment config layer. Adding CLI flag awareness to
`@adhd/environment` couples it to a specific flag format and parsing model,
duplicating functionality that every CLI framework already provides. The env
resolves config; the CLI framework parses argv. These are separate concerns.

However, there is a legitimate need: resolved config values affect how CLI
behavior works, and CLI flags sometimes need to override env-sourced values.
The bridge between CLI parsing and the env cascade needs a clean seam.

**Questions to architect:**

1. Does `@adhd/environment` need to know about CLI flags at all, or should
   the CLI framework call `env.set(key, value)` after parsing to inject
   flag values into the cascade at the correct precedence?

   ```typescript
   // Pattern: CLI framework parses, then injects into env
   const argv = yargs(hidden: true).parse();
   for (const [key, value] of Object.entries(argv)) {
     if (key in spec) env.override(key, value, 'cli');
   }
   ```

2. If a `sources.cli` section is added, what does it look like?
   - A mapping of CLI flag → config key with no parsing logic (the CLI
     framework provides the values, env just knows where they go)
   - A prefix-based auto-discover pattern similar to G-3's auto-scaffolding
     (e.g., `--env.FOO=bar` → env cascade at CLI precedence)

3. Should this be deferred entirely to post-Phase-4, given only 2 low-priority
   packages are affected?

**Current recommendation:** Defer. If needed later, use the inject pattern
(`env.override(key, value, 'cli')`) rather than adding CLI awareness to the
env spec itself.


