## Required `@adhd/environment` Gap Tasks

The adoption survey (SYNTHESIS.md §3) identifies feature gaps in
`@adhd/environment` that block or complicate sox-ecosystem adoption.
This document specifies the concrete API, config surface, path templates,
and env var patterns that `@adhd/environment` must ship to close each gap.

Items requiring further architectural design are tracked separately in
`GAPS_TO_ARCHITECT.md` in this directory.

Per-package surveys are at `docs/environment/adoption-survey/sox-ecosystem/*.md`
in the adhd repo. SYNTHESIS.md is at the parent directory of the same path.

| Gap | Title | Priority | §18d dependency | Status |
|-----|-------|----------|-----------------|--------|
| G-1 | Non-`ADHD_*` Env Var Allowlist (F1) | HIGH | Phase 4 | SPECIFIED |
| G-2 | Write Paths Outside Scope Root (F2) | HIGH | Phase 4 | SPECIFIED |
| G-3 | Dynamic / Extension Config (F3) | MED | Phase 4 | SEE GAPS_TO_ARCHITECT |
| G-4 | Extended Directory Kinds (F4) | MED | Phase 1 | SPECIFIED |
| G-5 | Language-Neutral Spec Artifact (F5) | MED | Phase 4 | SPECIFIED |
| G-6 | Multi-File Merged Config Sources (F7) | LOW | Post-Phase-4 | SPECIFIED |
| G-7 | Env→Config Auto-Routing (Declared Fields) + Runtime-Override Default + Provenance `explain()` | HIGH | None (post-redesign) | SPECIFIED |
| G-8 | Cluster-Aware Env Wiring in `@adhd/workspace-codegen-nx` | MED | G-7 (recommended order) | SPECIFIED |
| G-9 | Browser-Safe Resolved-Config Reader (`environment-core-browser`) | MED | G-5 (snapshot producer) | SPECIFIED |

> **G-7/G-8/G-9 provenance:** authored 2026-07-22 as a follow-on pass, not part
> of the original sox-ecosystem survey batch (G-1..G-6). G-7 overlaps **F3**
> (`SYNTHESIS.md §3` row F3 / `GAPS_TO_ARCHITECT.md` item 1, G-3 dynamic
> config) and **§6** (auto-wiring) — each section below states the exact
> scope boundary rather than duplicating that work. See also
> `packages/environment/BACKLOG.md` for short pointer entries cross-linked
> to these.

---

### Gap Task G-1 — Non-`ADHD_*` Env Var Allowlist (F1)

**Source:**
- `SYNTHESIS.md §3` row F1 ("21 packages" — the highest-priority gap)
- `SYNTHESIS.md §2` table: G1 across 9+ packages
- Per-package survey files for sox-host-runtime, sox-cli, sox-install-engine,
  sox-mcp-runtime, sox-extension-tokenguard, sox-embedding-provider,
  sox-host-registry (§Gap detail G1)

**Description:**
`@adhd/environment` uses a prefix-guard model (`isEnvNameAllowed` →
`ADHD_<PROJECT>_*`) that rejects env var names outside the ADHD_* namespace.
The sox-ecosystem reads 25+ env vars that are not and cannot be renamed to
ADHD_*: `SOX_ECOSYSTEM_HOME`, `SOX_SANDBOX_ROOT`, `XDG_CACHE_HOME`,
`CODEX_HOME`, `HOME`, `PATH`, `TZ`, `NODE_*`, `LC_*`, `SOX_CONFIG_*`,
`SOX_PERM_*`, `SOX_EMBED_CACHE_DIR`, `SOX_OS_UNIT_DIR`, `SOX_RUNTIME_FILE`,
`SOX_STOP_GRACE_MS`, `SOX_PROXY_BACKEND_*`, and others.

Without this gap closed, every sox-ecosystem package remains `adopt-after-gap`.

**Specification:**

`@adhd/environment` must add an **env-alias / external-env allowlist** mechanism
at two levels:

**Level 1 — Per-field `env` alias on `FieldSpec`:**
Extend `FieldSpec` to accept an `env` override that bypasses the prefix guard:

```typescript
interface FieldSpec<T> {
  type: string;
  default?: T;
  at: 'build' | 'runtime';

  // NEW: Override env var name — bypasses the prefix guard and reads
  // this name verbatim from process.env. Use for config entries backed
  // by a non-ADHD_* env var (e.g., SOX_ECOSYSTEM_HOME, CODEX_HOME).
  env?: string;

  // NEW: Secondary fallback env var, read verbatim.
  // Useful for XDG-standard vars (XDG_CACHE_HOME) or host-specific
  // conventions (CODEX_HOME).
  envFallback?: string;
}
```

Example for sox-embedding-provider's model cache:
```typescript
cacheDir: {
  type: 'string',
  env: 'SOX_EMBED_CACHE_DIR',     // primary — verbatim, no prefix
  envFallback: 'XDG_CACHE_HOME',  // secondary — XDG standard, verbatim
  default: '~/.cache/sox/models',
  at: 'runtime',
}
```

Example for sox-host-runtime's data root:
```typescript
ecosystemHome: {
  type: 'string',
  env: 'SOX_ECOSYSTEM_HOME',    // verbatim, no prefix
  default: '~/.adhd/sox-ecosystem',
  at: 'runtime',
}
```

**Level 2 — Spec-level `externalEnv` passthrough allowlist:**
`@adhd/environment` must ship a built-in default set of system env vars that
bypass the prefix guard, so individual projects don't redeclare the same
standard vars. Per-spec additions are merged with the defaults:

```typescript
// Built into @adhd/environment core — always active
const DEFAULT_EXTERNAL_ENV = [
  'HOME', 'PATH', 'TZ',
  'LC_ALL', 'LC_MESSAGES', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME', 'LANG',
  'NODE_PATH', 'NODE_ENV', 'NODE_OPTIONS',
  'USER', 'USERNAME',
];

interface EnvironmentSpec<T> {
  // NEW: Additional system env vars beyond the built-in defaults.
  // Merged with (not replacing) DEFAULT_EXTERNAL_ENV.
  // These are read verbatim from process.env without prefix-guarding.
  // Use for vars that must pass through to child processes but are not
  // config entries (do not have a FieldSpec).
  externalEnv?: string[];
}
```

The resolver resolution order:
1. Check `FieldSpec.env` — if the field declares a verbatim name, read it.
2. Check `DEFAULT_EXTERNAL_ENV` + `spec.externalEnv` — if the name appears, read it
   verbatim.
3. Fall through to the prefix guard (`ADHD_<PROJECT>_<FIELD>`) if neither match.
4. For `secret: true` fields declared with `env` alias, resolve the verbatim name
   but redact from log output (same as existing secret handling).

**Config entries vs system pass-through:**
- Config entries that happen to use non-`ADHD_*` env vars (like `SOX_SANDBOX_ROOT`,
  `CODEX_HOME`) should be declared as `FieldSpec` with `env` alias — they are
  named configuration values with defaults and types.
- System env vars that must pass through the resolver to child processes but
  are not config entries (`HOME`, `PATH`, `TZ`, etc.) go in `externalEnv` or are
  covered by the built-in defaults.

**Dependency:** Phase 4 (§18d) — `@adhd/environment` backend swap. Blocks all
packages currently tagged `G1` in the adoption survey.

**Status:** `SPECIFIED`

---

### Gap Task G-2 — Write Paths Outside Scope Root / Scoped Root Resolution Model (F2)

**Source:**
- `SYNTHESIS.md §3` row F2 ("21 packages")
- `SYNTHESIS.md §2` table: G2 across 9 packages
- Per-package survey files for sox-host-runtime (§Gap detail G2 — OS-mandated
  directories), sox-memory-core (§Gap detail G2 — hardcoded allowlist),
  sox-extension-tokenguard (§Gap detail G2 — per-instance isolation)

**Description:**
`@adhd/environment` positions all files under a `.adhd/<project>/` scoped root.
The sox-ecosystem writes to four categories of paths that cannot or should not
live under this hierarchy:

1. **OS-mandated directories** (`~/Library/LaunchAgents/`,
   `~/.config/systemd/user/`) — supervisor-enforced, not relocatable.
2. **Host placement directories** (`~/.claude/`, `~/.config/opencode/`,
   `~/.codex/`) — governed by host conventions and `SOX_SANDBOX_ROOT`.
3. **Legacy roots** (`~/.memory/`, `~/.tokenguard/`, `~/.sox/`) — predate
   ADR-0004, must be bridgeable during migration.
4. **Bundle-namespaced paths** — monorepo packages write under
   `.adhd/<bundle>/<package>/<kind>/<file>`, not `.adhd/<project>/`.

**Specification:**

`@adhd/environment` must support a three-layer path resolution model:

**Layer 1 — Scoped root (existing, enhanced):**
`.adhd/<project-id>/<namespace>/<kind>/<file>`. The `<project-id>` must be
independently configurable per `EnvironmentSpec`, not derived from the spec
name alone. The namespace defaults to `default`.

**Layer 2 — Legacy / OS-mandated bridge path:**
Add a `location` escape hatch on `DirSpec` and `FileSpec`:

```typescript
interface DirSpec {
  kind: DirKind;
  share: 'singleton' | 'per-instance' | 'per-scope';

  // NEW: When set, this directory resolves to the given static path
  // instead of under the scoped root. Tilde-expanded and HOME-resolved.
  // Use for OS-mandated directories and legacy bridge paths.
  location?: string;

}

interface FileSpec {
  in: string;
  name: string;
  share?: 'singleton' | 'per-instance';

  // NEW: Same as DirSpec.location — override the full path for this file.
  // When set, `in` is ignored.
  location?: string;
}
```

Example for OS unit files:
```typescript
dirs: {
  launchAgents: {
    kind: 'config',
    location: '~/Library/LaunchAgents',
  },
}
```

Example for memory store legacy bridge:
```typescript
files: {
  db: {
    in: 'data',
    name: 'memory.db',
    location: '~/.memory/memory.db',  // legacy path during migration
  },
}
```

**Layer 3 — Bundle-namespaced paths and per-scope root overrides:**

```typescript
interface EnvironmentSpec<T> {
  // NEW: Override the scoped root per installation scope.
  // Keys: 'user', 'project', 'org', 'local'.
  // When absent, defaults to ~/.adhd/<project-id>/ for user scope
  // and <repoRoot>/.adhd/<project-id>/ for project scope.
  scopeRoots?: Partial<Record<Scope, string>>;

  // NEW: Bundle identifier for multi-package monorepos.
  // When set, the path template becomes:
  //   .adhd/<bundleId>/<projectId>/<namespace>/<kind>/<file>
  // When absent:
  //   .adhd/<projectId>/<namespace>/<kind>/<file>
  bundleId?: string;
}
```

**Dependency:** Phase 4 (§18d) — `@adhd/environment` backend swap. Blocks
Phase 3 path schema finalization. Blocks all packages tagged G2.

**Status:** `SPECIFIED`

---

### Gap Task G-3 — Dynamic / Extension Config (F3)

**Source:**
- `SYNTHESIS.md §3` row F3 ("7 packages")
- Per-package surveys for sox-embedding-provider (§G5 — `config.options` open
  map), sox-extension-tokenguard (§Proposed EnvironmentSpec — `SOX_CONFIG_*`
  dynamic keys)

**Description:**
Several sox-ecosystem packages need to express open-ended configuration
mappings where keys are determined at runtime (user-defined, extension-provided,
or provider-specific). Examples:

- `sox-extension-tokenguard`'s `SOX_CONFIG_*` cascade — extension config keys
  generated at runtime from extension manifests.
- `sox-embedding-provider`'s provider-specific options (`apiKey`, `endpoint`,
  `dimensions`, etc.).
- `sox-host-runtime`'s pass-through env vars for child processes.

The architectural approach for this gap is under design. See
`GAPS_TO_ARCHITECT.md` in this directory.

**Dependency:** Phase 4 (§18d) — the `@adhd/environment` backend swap.

**Status:** `SEE GAPS_TO_ARCHITECT`

---

### Gap Task G-4 — Extended Directory Kinds Beyond the Standard Seven (F4 / G8)

**Source:**
- `SYNTHESIS.md §3` row F4 ("7 packages")
- `SYNTHESIS.md §2` table: G8 across 5 packages
- Per-package surveys for sox-host-runtime (§G8 — Unix sockets, lock files),
  sox-extension-memory-flush (§G8 — SQLite sidecar files)

**Description:**
`@adhd/environment` defines seven directory kinds:
`data | logs | cache | state | run | temp | config`. The sox-ecosystem uses
at least three additional categories:

| Kind | Example paths | Usage count |
|------|--------------|-------------|
| **sockets** | `proxy-<safeKey>.sock`, `<name>.sock` | 3 distinct templates |
| **locks** | `<supervisorId>.lock`, `proxy-backend-<hash>.lock`, `writer.lock` | 4 distinct templates |
| **stores** | `ext/<extId>@<version>/` (materialized extensions) | 1 template |
| **backups** | `<dbPath>.bak-reembed-<ts>` | 1 template |

SQLite WAL/SHM sidecars co-locate with the `.db` file — no separate kind needed.

**Specification:**

`@adhd/environment` must either:

**Option A — Add first-class kinds (preferred):**

```typescript
type DirKind =
  | 'data' | 'logs' | 'cache' | 'state' | 'run' | 'temp' | 'config'
  | 'sockets'   // Unix Domain Socket directories
  | 'locks'     // Process/file lock files (flock, O_EXCL, pid files)
  | 'stores'    // Materialized/packaged store directories
  | 'backups'   // Backup snapshots (database dumps, timestamped copies);
```

**Option B — Allow custom kind strings (fallback):**
If Option A is rejected as scope creep, add a `kindLabel` override:

```typescript
interface DirSpec {
  kind: DirKind;
  kindLabel?: string;  // Override the directory name for this kind.
                      // Example: kind:'run', kindLabel:'supervisors'
                      // generates .../run/supervisors/
}
```

**Dependency:** Phase 1 (§18d) — `@adhd/sox-config` needs these kinds for its
resolver table. Without them, socket and lock paths must be shoehorned into
`kind: 'run'`, creating ambiguity. Blocks packages tagged G8.

**Status:** `SPECIFIED`

---

### Gap Task G-5 — Language-Neutral Spec Artifact + Snapshot Consumer Contract (F5 / G3)

**Source:**
- `SYNTHESIS.md §3` row F5 ("5 packages — but do not rebuild py/rust")
- `SYNTHESIS.md §2d` ("Cross-language sharing — the unsolved half")
- Per-package survey for sox-cli (§G3 — non-Node)

**Description:**
`@adhd/environment` specs are TypeScript code literals (`EnvironmentSpec<T>`
in each `config.ts`). Resolution logic exists only in `environment-core-node`.
A non-Node package (Python, shell script, or future Rust tool) cannot read
the spec or resolve values without a Node dependency.

The survey confirms 5 affected packages, all Python and low-to-medium value,
and recommends against building full per-language clients. The interop seam
must be designed now so specs don't ossify as TS-only.

**Specification:**

**1. `generateSpecArtifact(spec): SpecArtifact` —**
Serializes a resolved spec to a language-neutral JSON schema:

```typescript
interface SpecArtifact {
  version: 1;
  generatedAt: string;
  source: string;
  config: Record<string, FieldSchema>;
  envPrefix: string;
  envVarMap: Record<string, string>;    // field → env var name (prefixed)
  dirs: Record<string, DirArtifact>;
  files: Record<string, FileArtifact>;
  scopeRoots?: Record<string, string>;
}

interface DirArtifact {
  kind: string;
  defaultPath: string;           // resolved, tilde-expanded
  share: 'singleton' | 'per-instance' | 'per-scope';
  location?: string;
}

interface FileArtifact {
  dir: string;
  name: string;
  share?: string;
  resolvedPath: string;
  location?: string;
}
```

**2. `env.writeSnapshot(filePath)` —**
Existing method. Must be documented as the cross-language consumption channel.
The snapshot JSON contains all resolved config values, resolved paths
(tilde-expanded), and the spec artifact metadata.

**3. Consumer contract document —**
Defines the snapshot JSON format (versioned), how consumers read resolved
paths and config values, that `at: 'runtime'` fields are point-in-time,
that secrets are redacted as `"[REDACTED]"`, and that the snapshot producer
must re-resolve after any config-changing event.

**4. CLI export commands:**
```bash
npx @adhd/environment export-spec --out spec.json
npx @adhd/environment export-snapshot --out snapshot.json
```

**Dependency:** Phase 4 (§18d). The snapshot is already part of the design,
but the spec artifact must be finalized before Phase 4's adapter seam locks.
Blocks sox-cli's G3 gap and any future Python-tool adoption.

**Status:** `SPECIFIED`

---

### Gap Task G-6 — Multi-File Merged Config Sources (F7 / G4)

**Source:**
- `SYNTHESIS.md §3` row F7 ("2 packages — low priority")
- Per-package survey for sox-install-engine (§config-merge capability)

**Description:**
`@adhd/environment` supports a single-layer file model: one config file per
scope, loaded and merged with the cascade. The sox-ecosystem's `config-merge`
capability accepts arbitrary file paths, detects format by extension (`.json`,
`.toml`), and merges keys additively into a target file — used for writing
`.mcp.json` entries, `settings.json` keys, and `~/.claude.json` MCP blocks.

**Specification:**

Add a `sources.files` declaration on `EnvironmentSpec`:

```typescript
interface EnvironmentSpec<T> {
  sources?: {
    files?: Array<{
      pattern: string;           // glob or path, tilde-expanded
      format: 'json' | 'toml' | 'yaml';
      precedence: 'low' | 'medium' | 'high';
      optional?: boolean;
    }>;
  };
}
```

Example for sox-install-engine:
```typescript
sources: {
  files: [
    { pattern: '~/.claude.json', format: 'json', precedence: 'high', optional: true },
    { pattern: '.mcp.json',      format: 'json', precedence: 'medium', optional: true },
  ],
}
```

**CLI flag integration** is out of scope for this gap — see `GAPS_TO_ARCHITECT.md`
for the broader question of CLI-parsed config entering the env cascade.

**Dependency:** Post-Phase-4. Only 2 packages, low priority.

**Status:** `SPECIFIED`

---

### Gap Task G-7 — Env→Config Auto-Routing for Declared Fields + Runtime-Override-by-Default + First-Class Provenance `explain()`

**Source:**
- Follow-on to the sox-ecosystem adoption survey, authored 2026-07-22, grounded in `packages/environment/ARCHITECTURE.md` §2.2/§3.1, `environment-base-spec/src/index.ts` (`FieldSpec.at` L127-133, `ProvenanceEntry` L257-262, `inferEnvVar` L464-466), `environment-builder/src/config-resolver.ts` (`resolveConfig` L143-193, `ResolvedFieldSpec` L27-38), `environment-builder/src/provenance.ts` (`buildProvenanceEntry`), `environment-core-node/src/environment.ts` (`provenance`/`get()`/`resolveEnvName` L187-320, `populateEnvironment` L398-436), and the real agent-mcp consumer (`entrypoint/agent-mcp/src/config.ts`).
- **Overlaps F3** (`SYNTHESIS.md §3` row F3 / `GAPS_TO_ARCHITECT.md` item 1, G-3 "Dynamic / Extension Config via Env Var Auto-Scaffolding") and **§6** ("Prevention — auto-wiring the sox-ecosystem builders"). See "Scope boundary vs F1/F3/§6" below — this item does not duplicate either.

**Description:**

Today, a **declared** `FieldSpec` (a dot-path key in `EnvironmentSpec.config`) already auto-routes to an env var via `inferEnvVar(prefix, path)` (`config-resolver.ts` L156) — that mechanism exists. What is missing, all four confirmed by reading the current source:

1. **The forward transform is lossy for camelCase**, so real specs are forced to hand-declare `env:` on every field to get a readable name. `entrypoint/agent-mcp/src/config.ts` L98-103 gives `"server.maxToolLoops"` an explicit `env: "ADHD_AGENT_MAX_TOOL_LOOPS"` specifically because the inferred name would be the unreadable `ADHD_AGENT_SERVER_MAXTOOLLOOPS` (uppercasing a camelCase segment doesn't insert a word boundary — `inferEnvVar`, L464-466, only replaces `.`/`-`). Every one of agent-mcp's 17 fields (`config.ts` L75-187) declares an explicit `env:` — the "auto-route without declaring `env:`" path is, in practice, unused by the one real consumer.
2. **No reverse lookup exists.** Nothing lets a caller ask "which declared field does env var X feed," and nothing validates that two fields don't collide on the same computed env var name — an explicit `env:` override can silently collide with another field's inferred name today, undetected.
3. **`FieldSpec.at` defaults to `'build'`** (`environment-base-spec/src/index.ts` L127-133). A correctly-namespaced env var only overrides at construction time, once, by default. There is no tier meaning "resolved once, and env never touches it at all," and the *default* is the opposite of what most fields plausibly want (an operator flipping `ADHD_AGENT_LOG_LEVEL` expects it to take effect without a restart).
4. **Provenance is a "where," not a "why and what else."** `ProvenanceEntry {source, scope, env?}` (`environment-base-spec/src/index.ts` L257-262) records only the winning layer. `config-resolver.ts`'s `resolveConfig` loop (L163-169) walks every file layer and computes each one's contribution as it goes, but **overwrites** `fallbackValue`/`fallbackSource` on every hit — the per-layer trail is computed and then discarded. There is no single, documented accessor that returns value + was-it-overridden + which env var would change it + the full layer trail together.

**Specification:**

**1. Declared-field reverse-routing — solved by inverting the ALREADY-COMPUTED forward map, never by parsing the env var string.**

The crux this item must solve (`ADHD_AGENT_MAX_TOOL_LOOPS` → `max.tool.loops` vs `maxToolLoops` vs `max.toolLoops`) is unsolvable as a *general string-inversion* problem — once segments are collapsed into uppercase-and-underscored text, the original word/segment boundaries are genuinely ambiguous. **The fix is to never invert a string at all for declared fields.** Every declared field's effective env var name is already computed once, per field, by the existing forward function (`field.env ?? inferEnvVar(prefix, key)`). Build the reverse map from those concrete, already-known outputs — an O(1) exact-match lookup table, not a heuristic parser:

```typescript
// environment-builder/src/config-resolver.ts — new export
/** Inverts the field→env-name map for a spec's declared fields. Never
 *  re-derives a dot-path from an env var string — unambiguous by
 *  construction for every declared field, regardless of camelCase/hyphen/
 *  depth in that field's dot-path, because it only ever looks up a string
 *  this same resolver already produced. */
export function buildReverseEnvIndex(
  configSpec: Record<string, FieldSpec>,
  prefix: string,
): Map<string, string /* dot-path */> {
  const index = new Map<string, string>();
  for (const key of Object.keys(configSpec)) {
    const field = configSpec[key];
    const envName = field.env && field.env !== '' ? field.env : inferEnvVar(prefix, key);
    const existing = index.get(envName);
    if (existing !== undefined && existing !== key) {
      throw new FieldEnvCollisionError(envName, existing, key);
    }
    index.set(envName, key);
  }
  return index;
}
```

```typescript
// environment-base-spec/src/index.ts — new error type, alongside the existing LoneSurrogateError
export class FieldEnvCollisionError extends Error {
  constructor(public readonly envVar: string, public readonly fieldA: string, public readonly fieldB: string) {
    super(`env var "${envVar}" is claimed by both "${fieldA}" and "${fieldB}" — give one an explicit, distinct FieldSpec.env`);
  }
}
```

`Environment`'s constructor calls `buildReverseEnvIndex` once at construction (cheap — one pass over already-known fields; throws `FieldEnvCollisionError` on a genuine collision, fail-fast rather than silently picking one) and exposes two new instance methods:
- `env.fieldForEnvVar(name: string): string | undefined` — reverse lookup.
- `env.envVarForField(path: string): string | undefined` — forward lookup, formalizing what `entrypoint/agent-mcp/src/config.ts`'s `PROVIDER_DEFAULTS` table (L210-214) currently hand-maintains as duplicated string literals into a single queryable API.

**Companion fix bundled in this item (load-bearing, not optional):** `inferEnvVar` must decamelize each path segment *before* uppercasing, so an auto-routed name is one a human would actually type without reading source:

```typescript
// environment-base-spec/src/index.ts — inferEnvVar, revised
export function inferEnvVar(prefix: string, fieldPath: string): string {
  const decamelized = fieldPath.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return `${prefix}_${decamelized.toUpperCase().replace(/[.-]/g, '_')}`;
}
// inferEnvVar("ADHD_AGENT_MCP", "server.maxToolLoops")
//   → "ADHD_AGENT_MCP_SERVER_MAX_TOOL_LOOPS"   (was: "..._SERVER_MAXTOOLLOOPS")
```

This is a **breaking change to `inferEnvVar`'s output** for any field that (a) has no explicit `env:` and (b) has a camelCase dot-path segment — must ship as a documented breaking change (major version bump). Repo audit (`grep -rln "EnvironmentSpec<\|EnvironmentSpec ="` across the tree, excluding worktrees): `entrypoint/agent-mcp/src/config.ts` declares an explicit `env:` on all 17 fields (L75-187), and `packages/agent/agent-core-env/src/spec.ts` has an empty `config: {}` (L44) — **neither in-repo consumer is affected**, but any future spec relying on the old squished inferred name must re-audit against this new output before upgrading.

**2. Undeclared/dynamic keys — canonical split rule contributed to F3/G-3, not implemented here.**

For an env var inside the project's prefix that matches **no** declared field (per the reverse index above), this item does **not** materialize a new config path — that is F3's job (`SYNTHESIS.md §3` row F3, the `record`/passthrough field type) and G-3's job (`GAPS_TO_ARCHITECT.md` item 1, "auto-scaffold from env var naming"). What this item contributes to that still-open question (G-3 question 1, "what delimiter triggers scaffolding") is the answer the reverse-index exercise proves necessary: **a bare `_` can never safely be treated as a hierarchy delimiter for an undeclared key**, because `_` is also the word-boundary marker *inside* a single decamelized segment (`MAX_TOOL_LOOPS`, from the one path segment `maxToolLoops`, is three underscore-joined words, not three path segments) — there is no way to tell, from the string alone, which underscore is a "new segment" boundary and which is a "word boundary within one segment." **Recommendation fed into G-3/F3 (not implemented here — cross-reference only, does not gate this item's own Status):** require `__` (double underscore) as the *only* hierarchy delimiter for auto-scaffolded/undeclared keys; a single `_` always stays inside a segment and is lowercased verbatim, with no de-camelize attempt on the way back (provably lossy, per the crux example above) — e.g. `ADHD_SOX_HOST_RUNTIME__LOG_LEVEL` → `host_runtime.log_level` (splits only on `__`). This should be pasted into `GAPS_TO_ARCHITECT.md` item 1's decision record when G-3 is scheduled. **Shipping G-7 does not require G-3 to also ship, and vice versa.**

**3. Runtime-override semantics — default flips to `'runtime'`; new `'fixed'` tier added.**

```typescript
// environment-base-spec/src/index.ts — FieldSpec.at, revised
export interface FieldSpec {
  type: FieldType;
  default?: unknown;
  /** NEW DEFAULT: `'runtime'` (was `'build'`). A correctly-namespaced env
   *  var is live-overridable by default.
   *  - `'runtime'` (DEFAULT) — re-read `process.env` on every access
   *    (mechanism unchanged from today's opt-in `at:'runtime'`).
   *  - `'build'` — resolved once at construction; an env var already set
   *    BEFORE construction still contributes to that one resolution
   *    (unchanged from today's *default* behavior — now an explicit
   *    opt-in for fields that must not shift mid-process, e.g. a port
   *    already bound, a DB path an already-open handle depends on).
   *  - `'fixed'` (NEW) — resolved once at construction, AND the env layer
   *    is excluded from that resolution entirely (only the
   *    system/global/project/local file layers + `default` participate).
   *    For fields that must never be influenced by ambient environment,
   *    even at startup. */
  at?: 'runtime' | 'build' | 'fixed';
  // ...remaining fields (env, scope, secret, description, JSON-Schema keywords) unchanged.
}
```

**Cascade-precedence interaction** (`config-resolver.ts` L143-193): `'runtime'` and `'build'` keep today's identical cascade (`code default → system → global → project → local → env`, env highest precedence) — they differ only in *when* the env layer is consulted (every access vs. once, at construction). `'fixed'` **truncates the cascade**: `code default → system → global → project → local` — env is never consulted for that field, at construction or later. This is a new resolver behavior, not a rename: `resolveConfig` must add a branch so a `'fixed'` field's live-env lookup (L171, `processEnv[envName]`) is skipped outright rather than merely excluded from the live-re-read installer.

**Migration impact — agent-mcp, audited field-by-field (all 17 currently undeclared `at`, so all 17 resolve under today's default, `'build'`):**

| Fields | New behavior under the flipped default | Required action |
|---|---|---|
| `db.path`, `server.registryDbPath`, `transport.kind`, `transport.port`, `sse.port`, `sse.host` (6) | Would become live-re-reading — risky: these back an already-opened SQLite handle or an already-bound socket. `resolveInitialSsePort()` (`config.ts` L326-334) explicitly depends on `sse.port` being decided **once**, before `startSseServer()` binds. | **Must pin explicit `at: 'build'`** before upgrading — required, not optional. |
| `plugins.configPath` (1) | Read once at plugin-load time; a live re-read would be a no-op at best (nothing reloads plugins) and misleading at worst (implies hot-reload that doesn't exist). | Pin `at: 'build'`. |
| `logging.level`, `queue.concurrency`, `server.maxDepth`, `server.maxToolLoops`, `server.defaultMaxTokens`, `server.contextLimit`, `server.allowedAgents`, `sse.enabled`, `sse.baseUrl`, `plugins.entries` (10) | Become live-toggleable without restart — `logging.level` is the canonical case FOR this flip (an operator setting `ADHD_AGENT_LOG_LEVEL=debug` expects it to take effect without a restart). | Leave `at` unset (adopt the new default). Verified safe: `toEngineConfig()` (`config.ts` L388-407) reads `env.config.*` fresh on every call rather than caching a snapshot at startup, so a live re-read reaches every consumer. |

6 + 1 + 10 = 17, matching the full field count in `entrypoint/agent-mcp/src/config.ts`. **General migration procedure for any spec (ship as an `ARCHITECTURE.md` §7 checklist item):** audit every field lacking an explicit `at`; for each, ask "if this env var changes mid-process, is a live re-read (a) safe, (b) meaningful, (c) consistent with an already-open resource?" — pin `'build'` (or `'fixed'`) for any "no," otherwise adopt the new `'runtime'` default.

**4. Provenance surfacing — EXTEND `ProvenanceEntry`/`env.provenance`, add `env.explain(path)`. Do not rebuild what already works.**

**What already exists and must be kept exactly as-is (backward compatible):** `ProvenanceEntry {source, scope, env?}` (`environment-base-spec/src/index.ts` L257-262), populated per field by `config-resolver.ts`'s `resolveConfig` (L186-188) via `provenance.ts`'s `buildProvenanceEntry`, exposed today as the flat `env.provenance: Record<string, ProvenanceEntry>` (`environment.ts` L187-188, L428) and via `env.get("provenance.<path>")` (`environment.ts` L295-296). This is a real, working "where did it come from" that agent-mcp already consumes (`config.ts` L326-329, `resolveInitialSsePort`'s `explicit` check reads `env.provenance["sse.port"].source`).

**What's missing:** one accessor that answers "what is it, was it overridden, by what, and what env var would change it" together, plus the per-layer trail that `resolveConfig`'s loop computes and discards.

```typescript
// environment-base-spec/src/index.ts — new exported type
export interface FieldExplanation {
  path: string;
  value: unknown;                  // current resolved value (live getter applied for at:'runtime' fields)
  source: ProvenanceSource;        // the winning layer — same value as ProvenanceEntry.source
  scope: Scope;
  wasOverridden: boolean;          // source !== 'default'
  envVarName: string | undefined; // the env var THIS field would read, whether or not it is currently set —
                                   // always known for a declared field, not only when source === 'env'
  at: 'runtime' | 'build' | 'fixed';
  /** Per-layer contributed value, present only for layers that actually
   *  declared this key — including a layer that was then overridden by a
   *  higher-precedence layer. NEW: config-resolver.ts's cascade loop must
   *  accumulate every hit into this map instead of overwriting
   *  `fallbackValue` with only the last one. */
  layerValues: Partial<Record<ProvenanceSource, unknown>>;
}
```

```typescript
// environment-builder/src/config-resolver.ts — ResolveConfigResult gains a new field
export interface ResolveConfigResult {
  raw: Record<string, unknown>;
  nested: Record<string, unknown>;
  typedRaw: Record<string, unknown>;
  provenance: Record<string, ProvenanceEntry>;
  fields: Record<string, ResolvedFieldSpec>;
  /** NEW — every layer's contributed value per field, not just the winner. */
  layerValues: Record<string, Partial<Record<ProvenanceSource, unknown>>>;
}
```

```typescript
// environment-core-node/src/environment.ts — new instance method
/** First-class, documented per-field explain accessor — the PRIMARY way to
 *  ask "why is this config value what it is." Throws for an undeclared
 *  `path` (use `env.get('provenance.*')` for raw pass-through debug access
 *  to the flat map; `explain` is deliberately field-validated). */
explain(path: string): FieldExplanation;
```

`SnapshotData<T>` gains a `fieldsMeta: Record<string, { env: string; at: FieldSpec['at']; layerValues: Partial<Record<ProvenanceSource, unknown>> }>` member — parallel to the existing `liveFields` (`environment-base-spec/src/index.ts` L271-283), which today covers only `at:'runtime'`/`secret` fields. `fieldsMeta` covers **every** declared field, so `explain()` never needs to re-run the resolver.

**Scope boundary vs F1/F3/§6 (explicit, per the dedup instruction):**
- **F1** (`GAP_SPECS.md` G-1, external-env allowlist) is orthogonal — F1 is about env vars **outside** the project's own prefix (`SOX_ECOSYSTEM_HOME`, `CODEX_HOME`). This item is entirely **inside**-prefix (`ADHD_<PROJECT>_*`). A field using F1's `env:`/`envFallback` alias still gets this item's reverse-index entry, `at` tier, and `explain()` support — additive, no conflict.
- **F3 / G-3** (dynamic/undeclared config) is the item this most overlaps. Delineation: **this item = declared-field mechanism** (reverse index, override tiers, provenance). **F3/G-3 = undeclared-key materialization** (the `record` field type / auto-scaffold that creates a NEW config path that was never a `FieldSpec`). §2 above is a **recommendation fed into G-3's open naming-convention question**, not an implementation of G-3.
- **§6 auto-wiring** (see Gap Task G-8 below) is unaffected either way — a generated spec, once it declares fields, gets this item's routing/override/provenance behavior automatically. G-8 does not need G-7 to exist to keep working, though a generated spec should default new fields to the (post-G-7) `'runtime'` tier unless the generator author pins otherwise — see G-8's dependency note.

**Dependencies:** Builds on the shipped redesign (`ARCHITECTURE.md` — DONE per `packages/environment/BACKLOG.md`'s Wave 1-3 record). No dependency on F1/F2/F4/F5/F6 (G-1/2/4/5/6). Informs (but does not depend on) F3/G-3 — see scope boundary above. Recommended to land before G-8, so a cluster-aware generated spec is born with the corrected `inferEnvVar` and the new `at` default already in place rather than migrating immediately after generation.

**Acceptance / Definition of Done:**
1. `buildReverseEnvIndex` unit-proven: two declared fields with colliding env names (an explicit `env:` override colliding with another field's inferred name) → `FieldEnvCollisionError` thrown at `Environment` construction. Negative control: remove the collision check → test goes RED.
2. `inferEnvVar` decamelize proven: `inferEnvVar(prefix, "server.maxToolLoops")` produces the underscored form; a real `Environment` constructed with an undeclared-`env:` camelCase field is overridden correctly by that computed name — round-trip proof: set the computed env var, read `env.config.*`, confirm the override took, confirm `env.envVarForField(path)` returns the exact string used to set it.
3. `at: 'fixed'` proven via a three-way differential test: `'runtime'` changes live between two `env.get()` calls when `process.env` changes; `'build'` honors an env var present BEFORE construction but ignores a change AFTER construction; `'fixed'` ignores the env var at every point (zero effect, at construction or after).
4. Default-flip proven: a field with no explicit `at` re-reads `process.env` between two `env.get()` calls — the now-default path, mirroring (not replacing) `ARCHITECTURE.md` §7.5's existing runtime-vs-build proof.
5. `env.explain(path)` proven end-to-end against a real 3-layer cascade (file + env layering, per `ARCHITECTURE.md` §7.3's existing cascade proof): asserts `wasOverridden`, `envVarName`, and `layerValues` all show the correct trail — including a layer that contributed a value later overridden by a higher layer (proving `layerValues` is not just the winner restated).
6. agent-mcp migration lands as explicit `at: 'build'` pins on the 7 identified fields (the table above), `nx build agent-mcp` clean, full agent-mcp test suite green, and `entrypoint/agent-mcp/src/__tests__/sse-port-contention.test.ts` passes unmodified (proves the migration did not silently change the one-shot-port behavior it depends on).
7. `nx lint` clean on `environment-base-spec`, `environment-builder`, `environment-core-node`, and `agent-mcp`.

**Status:** `SPECIFIED`

---

### Gap Task G-8 — Cluster-Aware Env Wiring in `@adhd/workspace-codegen-nx` (operationalizing `SYNTHESIS.md` §6 in THIS repo)

**Source:**
- `SYNTHESIS.md §6` ("Prevention — auto-wiring the sox-ecosystem builders") and `§2c` ("Shared-config clusters — packages that should share ONE config") — this item ports that recommendation from the sox-ecosystem's `sox-authoring` templates onto **this repo's own** generator family, `packages/workspace/workspace-codegen-nx`, per `AGENTS.md` §1.
- Grounded in `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts` (`scaffoldGenerator`, `TYPE_TO_CLASS`, and the existing post-generation-patch pattern — `patchViteConfig`/`patchReleasePublish`/`ensureReadme`/`patchEslintrc`/`patchTsconfigLib` — this item's env-wiring step extends that same pattern) and `workspace-config.ts` (`.adhd/workspace.json`-driven `validateGroup`/`validatePlatform`/`validateNxLayer` — the pattern this item's new `validateCluster` follows exactly).
- Reference cluster: `packages/agent/agent-core-env/src/spec.ts` (`AGENT_REGISTRY_PROJECT_ID`, `agentRegistryEnvironmentSpec`, `AgentRegistryEnvConfig`) — already ships exactly the "shared spec module" shape this item's generated output must import, per `SYNTHESIS.md §2c`'s "Agent registry" cluster row.

**Description:**

Every tier generator (`base`/`core`/`engine`/`store`/`plugin`/`generator`/`query`/`entrypoint`) currently scaffolds a package whose entire generated body is a one-line stub — `scaffoldEntrypoint()` writes `// Entrypoint: @adhd/${name}\n` (`shared/generator.ts` L203) for entrypoints, and every other tier gets only whatever `@nx/js:library` emits by default (`shared/generator.ts` L74-81) — **no generator wires `@adhd/environment` at all.** This means every new runtime-facing package in this repo is scaffolded with exactly the "path of least resistance" `SYNTHESIS.md §6` identifies as the root cause of the sox-ecosystem's G1/G2 gaps (21 packages each): a developer reaches for `process.env.X` and `./data/x.db` because nothing in the generated stub points them anywhere else. This repo has the identical exposure its own survey diagnosed elsewhere — a new `agent-*`/`dispatch-*` package can silently open a *fourth* divergent `registry.db` path today, exactly the hazard `SYNTHESIS.md §2c` already flags as "the highest-value, already-live coordination hazard" (a live problem this repo's own agent-registry cluster is in the middle of consolidating away from — see `packages/agent/agent-core-env`).

**Specification:**

**1. Tier-purity gate — which generators wire env, which never do.**

```typescript
// packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts
// NEW — extends the existing TYPE_TO_CLASS tier-classification pattern (L21-31).
const ENV_WIRING_ELIGIBLE: ReadonlySet<ScaffoldGeneratorSchema['type']> = new Set([
  'engine', 'store', 'entrypoint',
  // NOT 'base' | 'core' | 'types' — tier purity (AGENTS.md §8: base/core must
  // never depend on higher tiers; @adhd/environment is itself a
  // core-tier/foundation package, and a types/base package must stay
  // zero-dep). NOT 'plugin' | 'generator' | 'query' BY DEFAULT — these are
  // typically consumed BY a host engine that already owns env resolution;
  // opt in explicitly with --wireEnv if a specific plugin/query package
  // genuinely opens its own files/dirs.
]);
```
A generator invocation may force either direction with an explicit `--wireEnv <true|false>` flag on the generator schema, defaulting to `ENV_WIRING_ELIGIBLE.has(type)`. This directly implements `SYNTHESIS.md §6`'s "only wire templates that produce runtime artifacts" line, translated into this repo's own `pkg-kind` tier vocabulary rather than the sox-ecosystem's `service`/`mcp-server`/`bundle-member` vocabulary.

**2. Cluster registry — `.adhd/workspace.json` gains a `clusters` key, validated exactly like `groups`/`platforms`/`layers` already are.**

```jsonc
// .adhd/workspace.json — NEW top-level key, sibling to "groups"/"kinds"/"platforms"/"layers"
{
  // ...existing groups/kinds/platforms/layers/defaults unchanged...
  "clusters": {
    "agent-registry": {
      "description": "Shared registry.db — agent-store-prompts/-tools, agent-core-policy/-provider, agent-engine-compiler, host agent-mcp. See SYNTHESIS.md §2c.",
      "projectId": "AGENT_REGISTRY_PROJECT_ID",
      "specModule": "@adhd/agent-core-env",
      "specExport": "agentRegistryEnvironmentSpec",
      "configTypeExport": "AgentRegistryEnvConfig"
    }
  }
}
```

```typescript
// packages/workspace/workspace-codegen-nx/src/generators/shared/workspace-config.ts
export interface WorkspaceConfig {
  scope: string;
  groups: Record<string, { description: string }>;
  kinds: Record<string, { class: string; description: string }>;
  platforms: Record<string, { description: string }>;
  layers: Record<string, { description: string }>;
  defaults: { /* unchanged */ };
  /** NEW. */
  clusters?: Record<string, {
    description: string;
    projectId: string;         // named export identifier from specModule
    specModule: string;        // e.g. "@adhd/agent-core-env"
    specExport: string;        // named export identifier from specModule
    configTypeExport: string;  // named type export identifier from specModule
  }>;
}

export function validateCluster(cluster: string, config?: WorkspaceConfig | null): string | null {
  if (!config) return null; // No config means no validation — matches validateGroup/validatePlatform/validateNxLayer's existing convention
  if (!config.clusters || !config.clusters[cluster]) {
    const known = config.clusters ? Object.keys(config.clusters).join(', ') : '(none registered)';
    return `Unknown cluster "${cluster}". Known clusters: ${known}. Register it in .adhd/workspace.json "clusters" first.`;
  }
  return null;
}
```

**3. Generator schema gains `--cluster <name>` (optional) on every `ENV_WIRING_ELIGIBLE` tier.** E.g. `packages/workspace/workspace-codegen-nx/src/generators/engine/schema.json` (and the `store`/`entrypoint` siblings) gain:
```json
{ "cluster": { "type": "string", "description": "Registered cluster id from .adhd/workspace.json \"clusters\" — wires this package into the cluster's SHARED Environment instance instead of scaffolding a standalone one." } }
```

**4a. Cluster-aware output — imports the shared spec; a new member cannot drift into a divergent path.**

```typescript
// Generated src/config.ts when --cluster agent-registry is passed
import { Environment } from '@adhd/environment';
import { AGENT_REGISTRY_PROJECT_ID, agentRegistryEnvironmentSpec } from '@adhd/agent-core-env';
import type { AgentRegistryEnvConfig } from '@adhd/agent-core-env';

/** Shared with every other agent-registry cluster member — see
 *  .adhd/workspace.json "clusters"."agent-registry" and
 *  packages/agent/agent-core-env/src/spec.ts. Do NOT declare a fresh
 *  EnvironmentSpec here; import the shared one. */
export const env = new Environment<AgentRegistryEnvConfig>(
  AGENT_REGISTRY_PROJECT_ID,
  agentRegistryEnvironmentSpec,
  { namespace: 'production' },
);
```
The generated `package.json` gains `@adhd/environment` and the cluster's `specModule` (`@adhd/agent-core-env`) as declared dependencies, and the generator's `formatFiles()` step is followed by a `sync-deps`-equivalent write (`AGENTS.md` §5) so the dependency-graph edge is never left implicit for `nx lint`'s `@nx/dependency-checks` to flag on the very next run.

**4b. Standalone (no `--cluster`) output — still zero-config, still env-wired, own prefix.**

```typescript
// Generated src/config.ts when --cluster is omitted, for an ENV_WIRING_ELIGIBLE tier
import { Environment } from '@adhd/environment';
import type { EnvironmentSpec } from '@adhd/environment-base-spec';

export interface ${PascalName}Config {}
// TODO: declare this package's config fields here — see packages/environment/ARCHITECTURE.md §3.1.

export const ${camelName}EnvironmentSpec: EnvironmentSpec<${PascalName}Config> = {
  namespaces: ['production'],
  dirs: { data: { kind: 'data' } },
  config: {},
};

export const env = new Environment<${PascalName}Config>('${projectName}', ${camelName}EnvironmentSpec, { namespace: 'production' });
```
This satisfies the *reachability prerequisite* `SYNTHESIS.md §6` calls out as its prerequisite (1) — already trivially true in THIS repo (unlike the cross-repo sox-ecosystem case that section discusses): `@adhd/environment` is already workspace-resolvable via `tsconfig.base.json` path mapping, the exact mechanism `scaffoldGenerator` already wires for every generated package's own import path (`shared/generator.ts` L112-113). No publish-to-npm step is required for this item.

**5. Prove-first gate carried over from `SYNTHESIS.md §7` Step 4.** This item ships, but its `--cluster` option targets **only the `agent-registry` cluster initially** — the one already proven per `packages/environment/BACKLOG.md`'s Wave 1-3 record and `packages/agent/agent-core-env`'s existing shared spec. Do not pre-register speculative cluster entries in `.adhd/workspace.json`; add each new cluster only when that cluster's shared spec module actually ships, mirroring `SYNTHESIS.md §7`'s "two proofs away, not zero" discipline.

**Dependencies:** `@adhd/agent-core-env` (already exists, `packages/agent/agent-core-env`) as the first registered cluster. Loosely depends on G-7 above — a generated spec is better born with G-7's corrected `at` default and decamelized `inferEnvVar`, but this item does not block on G-7 shipping first; either order works. **Recommended order: G-7 then G-8.**

**Acceptance / Definition of Done:**
1. `npx nx g @adhd/workspace-codegen-nx:store --group agent --name test-cluster-member --nxLayer ai --platform node --cluster agent-registry --dry-run` produces a `src/config.ts` that imports `@adhd/agent-core-env`'s `agentRegistryEnvironmentSpec`/`AGENT_REGISTRY_PROJECT_ID` verbatim — no fresh `EnvironmentSpec` literal in the generated file. (Dry-run only; never committed as a permanent fixture package.)
2. The same invocation with an unregistered `--cluster nonexistent-cluster` fails fast with `validateCluster`'s message. Negative control: skip validation → the generator silently emits a broken import — test goes RED.
3. The same invocation targeting a `base`-tier generator (`npx nx g @adhd/workspace-codegen-nx:base ... --cluster agent-registry --dry-run`) is REJECTED at generation time — proves the `ENV_WIRING_ELIGIBLE` tier-purity gate fires even when a cluster is explicitly requested, not merely documented.
4. Standalone (`--cluster` omitted) generation for an `engine`/`store`/`entrypoint` tier produces a package whose generated `src/config.ts` builds clean (`nx build <generated-project>`) with zero files/env vars on disk (zero-config proof, mirroring `ARCHITECTURE.md` §7.2), then is deleted as generator-test scaffolding.
5. `nx lint` clean on `workspace-codegen-nx` itself, including new generator unit tests exercising `ENV_WIRING_ELIGIBLE`, `validateCluster`, and both output-template branches (4a/4b).

**Status:** `SPECIFIED`

---

### Gap Task G-9 — Browser-Safe Resolved-Config Reader (`environment-core-browser`)

**Source:**
- `packages/environment/ARCHITECTURE.md` §1 point 3 ("Cross-language (Py/Rust) from day one... Node-only") and §2d ("Cross-language sharing — the unsolved half," `SYNTHESIS.md §2d`) — this item is the browser instance of the same unsolved half, not a new problem class.
- Grounded in `environment-core-node/src/environment.ts` (`node:fs`/`node:path` imports L19-20, `fromSnapshot` L255-262, `resolveEnvName`/`isEnvNameAllowed`/`lock()` L306-359) and the platform split already present in the codebase, confirmed by reading each package's `project.json` tags: `environment-base-spec` is `platform:shared` with **zero** Node built-in imports (its own doc comment at `environment-base-spec/src/index.ts` L607-615 explains its from-scratch SHA-256 implementation exists *specifically* so this package's Vite build can externalize `node:*` as browser stubs), while `environment-builder` and `environment-core-node` are both `platform:node` and import `node:fs`/`node:path` across `layer-files.ts`, `dirs.ts`, `snapshot.ts`, `snapshot-writer.ts`, `scope.ts`, `roots.ts`, and `environment.ts` itself.

**Description:**

`@adhd/environment` is Node-only by design (`ARCHITECTURE.md` §1 point 3), and the redesign was correct not to build cross-language support speculatively. But a browser consumer inside this monorepo (any `platform:browser` package under `packages/ui-react/*`, or a future SPA) has **no** way to read the same resolved config today — not even via the "SECONDARY — read a snapshot" path `ARCHITECTURE.md` §3 describes as the cross-process handoff mechanism, because `Environment.fromSnapshot()` itself calls `existsSync`/`readFileSync` from `node:fs` (`environment.ts` L256, L259). A real bundler resolving that import for a browser target either fails outright or silently substitutes a broken shim — exactly the platform-isolation failure `AGENTS.md` §3 exists to prevent ("`platform:browser`... NEVER import Node internals").

**Specification (full rationale + alternatives comparison in the companion note, `docs/environment/BROWSER.md`):**

**Recommended strategy: (a) build-time snapshot embed as the primary path, with (b) a live browser-appropriate override layer on top — NOT (c) a from-scratch browser resolver that re-implements file/cascade resolution.** Rationale: a browser genuinely cannot resolve scope, cwd, files, dirs, or locks — there is no filesystem, no `process.env`, no `os.homedir()` to resolve *from*. The only thing that can legitimately move to the browser is **consuming an already-Node-resolved result**, which is exactly what the existing `SnapshotData`/`.write()`/§2d design already produces. The new package's job is to be a browser-safe *reader* of that artifact, never a second resolver.

**1. New package: `environment-core-browser`** (`domain:environment`, `pkg-kind:core`, `platform:browser` — deliberately NOT `platform:shared`: its live-override sources — `window`, `localStorage` — are DOM-specific, unlike `environment-base-spec`'s genuinely dual-safe primitives). Depends ONLY on `environment-base-spec` (already `platform:shared`, zero Node built-ins) — never on `environment-builder`/`environment-core-node` (both `platform:node`).

```typescript
// environment-core-browser/src/index.ts
import type { SnapshotData, ProvenanceSource, Scope, FieldSpec } from '@adhd/environment-base-spec';

/** FieldExplanation is shared verbatim with G-7's Environment#explain — one
 *  mental model, two runtimes. Import it once G-7 lands (environment-base-spec). */
export interface BrowserFieldExplanation {
  path: string;
  value: unknown;
  source: ProvenanceSource | 'window-override' | 'local-storage-override'; // widened — see below
  scope: Scope;
  wasOverridden: boolean;
  envVarName: string | undefined;
  at: FieldSpec['at'];
}

export interface BrowserEnvironmentOptions<T> {
  /** The Node-resolved snapshot — imported at build time (Vite/webpack JSON
   *  import, or a generated `.ts` module) or fetched at runtime. Required —
   *  there is no zero-config default in the browser; the spec + defaults
   *  already ran on the server/at build time. */
  snapshot: SnapshotData<T>;
  /** Live override source, consulted on every access for a field this
   *  snapshot's `fieldsMeta` (G-7) marks `at: 'runtime'`. Defaults to
   *  reading `window.__ADHD_ENV__?.[envVarName]` when `window` exists (the
   *  "config.js before the app bundle" pattern) — SSR-safe no-op otherwise. */
  liveOverrideSource?: (envVarName: string) => string | undefined;
  /** Optional secondary override layer, checked with HIGHER precedence than
   *  `liveOverrideSource` — client-side experimentation / local dev only.
   *  Never wire this to a production override path. */
  localStorageKeyPrefix?: string;
}

export class BrowserEnvironment<T = Record<string, unknown>> {
  readonly config: T;
  readonly provenance: Record<string, unknown>;
  readonly project: string;
  readonly namespace: string;
  readonly scope: Scope;   // fixed passthrough of whatever the Node build chose — never re-derived
  readonly hash: string;

  constructor(opts: BrowserEnvironmentOptions<T>);

  get<K extends string>(key: K): unknown;
  explain(path: string): BrowserFieldExplanation;

  // Explicitly ABSENT — each throws NotSupportedInBrowserError naming the
  // Node-only alternative, rather than silently degrading to a broken path:
  // paths, files, ensureDirs(), write(), lock()
}

export class NotSupportedInBrowserError extends Error {}
export class SecretNotAvailableInBrowserError extends Error {}
```

**2. Secrets are never bundled — enforced, not just documented.** A `secret: true` field's value in a `.write()`'d snapshot is already never plaintext (`SnapshotData.config`'s doc comment, `environment-base-spec/src/index.ts` L301-306 — it is the `makeEnvRef` sentinel string). `BrowserEnvironment` goes one step further: reading `env.config.<secretField>` for a `secret: true` field throws `SecretNotAvailableInBrowserError` rather than returning the sentinel string — returning the sentinel would leak the *shape* of a secret reference into client code and invites a future author to "helpfully" wire a live resolution path for it. This is the one feature that does not degrade — there is no browser-safe way to honor `secret: true`, and the API must say so loudly rather than leave a foot-gun.

**3. Feature-degradation table (as required):**

| Node feature | Browser behavior |
|---|---|
| `at: 'runtime'` live env re-read (G-7) | Re-reads the injected `liveOverrideSource` (default: `window.__ADHD_ENV__`) instead of `process.env` — genuinely live if the host app mutates `window.__ADHD_ENV__` after a remote-config fetch. `import.meta.env` is deliberately NOT the default live source: Vite/webpack inline it at build time, so it cannot change at runtime regardless of how it's read. |
| `at: 'build'` / `'fixed'` (G-7) | Identical semantics — read once from the embedded snapshot, never touched by any browser override source. |
| Scope/cwd auto-detection (`ARCHITECTURE.md` §2.3) | Removed — no cwd in a browser. `BrowserEnvironment.scope` is a fixed passthrough of whatever the Node build-time resolution chose; never re-derived client-side. |
| `env.paths` / `env.files` | Throw `NotSupportedInBrowserError('paths/files require a filesystem — resolve them at build time and pass the resulting URLs as ordinary config fields instead')`. |
| `env.lock()` | Throw by default. **Stretch goal, explicitly NOT required for v1:** where `navigator.locks` exists, an opt-in `useWebLocksApi: true` option could implement genuine cross-tab exclusivity via `navigator.locks.request(name, ...)` — noted as a real, spec'able-later option, deliberately deferred. |
| `secret: true` fields | Throw `SecretNotAvailableInBrowserError` — see §2. Never "best-effort" degrade. |
| Runtime overrides in-browser | `window.__ADHD_ENV__` (live, app-mutable) is the primary override channel; an optional `localStorage`-backed layer (higher precedence, local-dev/experimentation only) — both surfaced through the SAME `explain()` shape as Node (via the two new widened `ProvenanceSource`-adjacent source values). |

**4. Platform isolation (`AGENTS.md` §3):** `environment-core-browser`'s `vite.config.ts` sets `external: []` (browser libraries are consumed by the host app's own bundler — same convention as every existing `platform:browser` package, e.g. `ui-react-base-storybook`), and its ESLint config adds an import-restriction rule forbidding `environment-builder`/`environment-core-node` — a lint rule, not just a doc comment, so a future PR cannot silently reintroduce the exact `node:fs` transitive-import failure mode this item exists to avoid.

**Dependencies:** Requires a Node-side producer to have already run `env.write()` (or G-5's future `generateSpecArtifact`/`export-snapshot` CLI, `GAP_SPECS.md` Gap Task G-5) at build time — this item does not change how the snapshot is produced, only how it is read. No dependency on G-7/G-8, though G-7's `FieldExplanation` shape should be finalized first so `BrowserEnvironment.explain()` can mirror it exactly rather than drift into a second, incompatible shape.

**Acceptance / Definition of Done:**
1. `environment-core-browser` builds under `@nx/vite:build` targeting a browser environment with zero `node:*` externals needed — proves zero Node built-in imports. Negative control: add a stray `import { readFileSync } from 'node:fs'` → build fails, proving the check has teeth.
2. A real bundler smoke test (Vite, per `AGENTS.md` §7's "drive the real components" standard) imports `environment-core-browser` inside a minimal browser-target entry point and constructs a `BrowserEnvironment` from an embedded snapshot fixture — asserts `config`, `explain()`, the `NotSupportedInBrowserError` throws for `paths`/`files`/`lock()`, and `SecretNotAvailableInBrowserError` for a `secret:true` fixture field.
3. Live-override proof: mutate `window.__ADHD_ENV__` between two `env.get()` calls on an `at:'runtime'` fixture field → the value changes; an `at:'build'`/`'fixed'` fixture field does not — mirrors G-7's Node-side three-way differential proof, run browser-side.
4. `nx lint` clean on `environment-core-browser`, including the new import-restriction rule actually firing against a deliberately-reintroduced `environment-core-node` import (negative control).

**Status:** `SPECIFIED`
