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
