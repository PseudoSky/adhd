# @adhd/environment — Implementation Spec v0.0.0 (SUPERSEDED)

> **Superseded by SPEC_0.0.1.md** on 2026-07-06. This revision used Zod as optional peer dependency for validation, treated Python/Rust as stub-only, and had a flat non-inheriting field definition model. See SPEC_0.0.1.md for the current design: validation keywords embedded in field definitions with auto-generated JSON Schema, full cross-language implementations, scope-based field/ directory inheritance, provenance tracking, and configurable .env within the configuration definition.

Produced by the architect agent on 2026-07-01. Revised 2026-07-06 after Q&A with full stakeholder input.

## Summary

`@adhd/environment` gives every ADHD project deterministic namespacing, typed configuration, directory cataloging, content-hashed versioning (config + structure), and a language-agnostic JSON snapshot that any runtime can consume. It ships as five monorepo packages under `packages/environment/`, three implemented now, two with full interface stubs + contract tests:

| Package | npm | Language | Status |
|---|---|---|---|---|
| `environment-base-spec` | `@adhd/environment-base-spec` | JSON Schema + SPEC.md | **implement now** |
| `environment-core-node` | `@adhd/environment` | TypeScript (Node) | **implement now** |
| `environment-cli` | `@adhd/environment-cli` | TypeScript (Node, apigen-generated CLI) | **implement now** |
| `environment-core-py` | `adhd-environment` | Python | interface stubs + contract test |
| `environment-core-rs` | `adhd-environment` | Rust | interface stubs + contract test |

The TypeScript implementation has **zero external runtime dependencies** — `.env` parsing is internal (~40 lines), content hashing uses `node:crypto`, Zod is an optional peer dependency for `validate()`.

### Design principles (informed by sox-ecosystem analysis)

- **Scope-cascaded resolution:** env var → project-scoped default → global default → system default. Deterministic, auditable.
- **Single data-root resolver:** one place computes all paths. Two orthogonal overrides: `ADHD_HOME` (root) and `ADHD_SANDBOX_ROOT` (test isolation).
- **Content-addressed config:** SHA-256 hashes of both resolved config AND directory structure — any drift is detected on `initialize()`.
- **Atomically written snapshots:** write to `.tmp` then `renameSync` — never a partial file on disk.
- **Generalizes sox-ecosystem patterns:** scope cascade, `SOX_CONFIG_*` → `<PREFIX>_*` injection, data-root resolver, atomic writes.

---

## Language-agnostic contract

### `environment-base-spec/spec/adhd-environment.schema.json`

The canonical format for `~/.adhd/<project>/adhd-environment.json`. Every language client reads and writes this exact shape. The schema is the authority — TypeScript types derive from it.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://adhd.dev/schemas/adhd-environment.json",
  "title": "ADHD Environment Snapshot",
  "type": "object",
  "required": ["project", "version", "directories", "config", "envPrefix", "envVars"],
  "properties": {
    "project": {
      "type": "object",
      "required": ["name"],
      "properties": {
        "name":        { "type": "string" },
        "description": { "type": "string" },
        "repo":        { "type": "string", "format": "uri" },
        "homepage":    { "type": "string", "format": "uri" },
        "license":     { "type": "string" },
        "meta":        { "type": "object", "additionalProperties": { "type": "string" } }
      }
    },
    "version": {
      "type": "object",
      "required": ["configHash", "structureHash", "generatedAt", "libraryVersion"],
      "properties": {
        "configHash":     { "type": "string", "pattern": "^sha256-[a-f0-9]{64}$" },
        "structureHash":  { "type": "string", "pattern": "^sha256-[a-f0-9]{64}$" },
        "generatedAt":    { "type": "string", "format": "date-time" },
        "libraryVersion": { "type": "string" }
      }
    },
    "directories": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "required": ["path", "type", "description"],
        "properties": {
          "path":        { "type": "string" },
          "type":        {
            "type": "string",
            "pattern": "^(state|runtime|user)\\.[a-z][a-z0-9-]*$",
            "description": "Hierarchical: state.data | state.config | runtime.log | runtime.cache | runtime.pid | user.bin | user.custom"
          },
          "description": { "type": "string" }
        }
      }
    },
    "config": {
      "type": "object",
      "description": "Resolved config values — shape is project-defined"
    },
    "envPrefix": {
      "type": "string"
    },
    "envVars": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    }
  }
}
```

### `environment-base-spec/spec/SPEC.md` — Behavioral contract

Every language client MUST implement these sections.

#### §1 Snapshot I/O

```
read_snapshot(project_name: string) → EnvironmentSnapshot
```

Reads `~/.adhd/<project_name>/adhd-environment.json`. MUST throw if missing or malformed. Error MUST include the file path.

```
write_snapshot(project_name: string, snapshot: EnvironmentSnapshot) → string
```

Writes `~/.adhd/<project_name>/adhd-environment.json`. **Atomic write:** write to `<path>.tmp`, then `renameSync`. Creates parent directories. Returns the written path. JSON prettified (2-space indent), trailing newline.

#### §2 Directory Registry (constructor-only)

```
DirectoryRegistry(root_dir: string, entries: DirectoryEntry[])

get_directory_path(dir_name: string) → string
ensure_directories() → void
snapshot() → DirectoryRegistrySnapshot
```

All directories are declared at construction time. No runtime `register()` method. `ensure_directories()` creates all registered directories on disk (idempotent).

**Directory types** use hierarchical dot-path namespacing:

| Type | Category | Purpose | Behavior |
|---|---|---|---|
| `state.data` | state | Persistent application data (databases) | Persisted, never auto-deleted |
| `state.config` | state | Configuration files | Persisted, version-controlled |
| `runtime.log` | runtime | Log output | Auto-created, append-only |
| `runtime.cache` | runtime | Temporary / safe to delete | May be cleared at any time |
| `runtime.pid` | runtime | Process IDs, sockets, lock files | Ephemeral, cleaned on shutdown |
| `user.bin` | user | Executables / scripts | May be added to PATH |
| `user.custom` | user | User-defined purpose | No special behavior |

Going forward, all ADHD packages use this hierarchy. New subtypes are added to the appropriate category — never ad-hoc.

#### §3 Config Resolution

```
resolve_config(project_name: string, env_vars?: Map<string,string>, env_overrides?: Map<string,string>) → ConfigSnapshot
```

1. Load `.env` hierarchy (§4).
2. Apply `env_overrides` (aliases): if `env_overrides["ORIGINAL_VAR"] = "ALIASED_VAR"`, reads from `ALIASED_VAR` instead of `ORIGINAL_VAR`.
3. For each field: check `env_vars?[field.env]` → `process.env[field.env]` → scoped default.
4. Expand `${VAR}` references in values (§3a).
5. Compute `configHash` (§5) and `structureHash` (§5a).
6. Return `{ raw, hash, structureHash, envVars }`.

**Config scopes for defaults:** `project` (relative to CWD), `global` (`~/.adhd/`), `system` (`/etc/adhd/`).

#### §3a Variable Interpolation

Values MAY contain `${VAR}` references. Resolution order per reference:

```
1. Same-file env var (already loaded, same key scope)
2. process.env[VAR]
3. Scoped default for the field being resolved
4. Leave unresolved: ${VAR} stays as literal text
```

Example: `ADHD_AGENT_DB_PATH=${HOME}/.adhd/agent-mcp/db` → expands `${HOME}` from `process.env`.

#### §4 Env File Loading

Standard hierarchy (lowest → highest precedence):

```
1. <adhd_root>/.env              (no override — sets only if unset)
2. <cwd>/.adhd/.env              (override)
3. <cwd>/.env                    (override)
```

Custom order via `load_env_files(paths, cwd?)`.

Parsing rules:
- Blank lines and `#`-prefixed lines skipped
- `export KEY=VALUE` → `KEY=VALUE` (prefix stripped)
- Matching quotes (`"..."` or `'...'`) stripped from values
- `${VAR}` references are **not expanded at parse time** — expansion happens during `resolve_config()`

#### §5 Content Hashing

```
compute_content_hash(config: Map<string,string>) → string
```

1. Sort keys lexicographically (byte-order).
2. For each key: append `key=value\n` (unexpanded values — `${VAR}` preserved as-is).
3. SHA-256 hash the buffer.
4. Return `"sha256-"` + lowercase hex digest.

**Contract test vector (MUST pass in every client):**

```
Input:  { "b": "2", "a": "1" }
Output: "sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

#### §5a Structure Hashing

```
compute_structure_hash(directories: DirectoryRegistrySnapshot) → string
```

1. Sort directory names lexicographically.
2. For each directory: append `name:type\n` (path is NOT hashed — only logical structure).
3. SHA-256 hash the buffer.
4. Return `"sha256-"` + lowercase hex digest.

This detects when directory entries are added, removed, or have type changes — independent of the absolute paths.

#### §6 Env Prefix Derivation

```
derive_env_prefix(project_name: string) → string
```

1. Uppercase name.
2. Replace `[^A-Z0-9]` with `_`.
3. Prepend `"ADHD_"`.

```
"agent-mcp" → "ADHD_AGENT_MCP"
"my app"    → "ADHD_MY_APP"
```

---

## File manifest

### `packages/environment/environment-base-spec/` — Contract package

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | create | `@adhd/environment-base-spec`, `type: "module"`, `private: false` |
| `project.json` | create | Nx project, tags `["platform:shared", "layer:base"]` |
| `tsconfig.json` | create | Extends `tsconfig.base.json` |
| `spec/SPEC.md` | create | Behavioral contract §1–§6 (the client interface) |
| `spec/adhd-environment.schema.json` | create | JSON Schema for the snapshot file |
| `src/index.ts` | create | TypeScript type re-exports from the schema |
| `README.md` | create | Package overview + link to SPEC.md |

### `packages/environment/environment-core-node/` — TypeScript reference implementation

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | create | `@adhd/environment`, dep on `environment-base-spec: "workspace:*"`, peer dep on `zod` (optional) |
| `project.json` | create | Nx project, tags `["platform:node", "layer:core"]` |
| `tsconfig.json` | create | Extends `tsconfig.base.json` |
| `tsconfig.lib.json` | create | outDir `dist/out-tsc`, include `src/**/*.ts` |
| `vite.config.ts` | create | Externalize `zod`, `node:*` builtins |
| `src/index.ts` | create | Public API re-exports |
| `src/lib/types.ts` | create | All shared types |
| `src/lib/project-identity.ts` | create | `ProjectIdentity` + `projectEnvPrefix()` |
| `src/lib/parse-env-file.ts` | create | Internal `.env` parser — zero deps |
| `src/lib/env-loader.ts` | create | `loadEnvHierarchy()`, `loadEnvFiles()` |
| `src/lib/directory-registry.ts` | create | `DirectoryRegistry` (constructor-only) |
| `src/lib/config-resolver.ts` | create | `ConfigResolver` with aliasing + `${VAR}` expansion |
| `src/lib/interpolate.ts` | create | `${VAR}` expansion per §3a |
| `src/lib/unflatten.ts` | create | Dot-path → nested object |
| `src/lib/content-hash.ts` | create | `contentHash()` + `structureHash()` |
| `src/lib/snapshot.ts` | create | `readSnapshot()`, `writeSnapshot()` (atomic) |
| `src/lib/environment.ts` | create | `Environment` — composition root |
| `src/__tests__/contract-compliance.test.ts` | create | Validates against SPEC.md test vectors |
| `src/__tests__/parse-env-file.test.ts` | create | `.env` parser unit tests |
| `src/__tests__/directory-registry.test.ts` | create | Directory registry unit tests |
| `src/__tests__/config-resolver.test.ts` | create | Config resolver unit tests |
| `src/__tests__/interpolate.test.ts` | create | `${VAR}` expansion tests |
| `src/__tests__/snapshot.test.ts` | create | Snapshot I/O unit tests |
| `src/__tests__/environment.test.ts` | create | Integration tests |
| `README.md` | create | API reference + usage examples |

### `packages/environment/environment-core-py/` — Python stubs + contract test

| Path | Change | Description |
|------|--------|-------------|
| `pyproject.toml` | create | `adhd-environment`, Python >=3.10 |
| `project.json` | create | Nx project with shell-command targets for `lint` (ruff), `test` (pytest), `build` |
| `src/adhd_environment/__init__.py` | create | Public API exports |
| `src/adhd_environment/environment.py` | create | `Environment` class stub + docstrings |
| `src/adhd_environment/directory_registry.py` | create | `DirectoryRegistry` class stub + docstrings |
| `src/adhd_environment/config_resolver.py` | create | `ConfigResolver` class stub + docstrings |
| `src/adhd_environment/content_hash.py` | create | `content_hash()` + `structure_hash()` — FULL implementation (must pass test vector) |
| `src/adhd_environment/snapshot.py` | create | `read_snapshot()` + `write_snapshot()` stubs |
| `src/adhd_environment/types.py` | create | Type definitions (dataclasses) |
| `tests/test_contract.py` | create | Contract compliance: content hash test vector, prefix derivation |
| `README.md` | create | Package overview |

### `packages/environment/environment-core-rs/` — Rust stubs + contract test

| Path | Change | Description |
|------|--------|-------------|
| `Cargo.toml` | create | `adhd-environment` |
| `project.json` | create | Nx project with cargo targets for `build`, `test`, `lint` (clippy) |
| `src/lib.rs` | create | Public API exports |
| `src/environment.rs` | create | `Environment` struct stub + doc comments |
| `src/directory_registry.rs` | create | `DirectoryRegistry` struct stub + doc comments |
| `src/config_resolver.rs` | create | `ConfigResolver` struct stub + doc comments |
| `src/content_hash.rs` | create | `content_hash()` + `structure_hash()` — FULL implementation (must pass test vector) |
| `src/snapshot.rs` | create | `read_snapshot()` + `write_snapshot()` stubs |
| `src/types.rs` | create | Type definitions (structs + enums) |
| `tests/contract.rs` | create | Contract compliance: content hash test vector, prefix derivation |
| `README.md` | create | Package overview |

### `packages/environment/environment-cli/` — CLI (apigen-generated)

The CLI is generated by `@adhd/apigen-generator-nx` from a single `src/api.ts` file. This file exports plain JSDoc'd async functions with **scalar parameters only** — no class instances, no interface-typed params. Every exported function becomes one `.command()` in the generated Commander CLI. Real implementation lives in `src/lib/core.ts`.

| Path | Change | Description |
|------|--------|-------------|
| `package.json` | create | `@adhd/environment-cli`, dep on `@adhd/environment`, `commander` (runtime), `@adhd/apigen-engine-runtime` |
| `project.json` | create | Nx project with `generate-cli` target using `@adhd/apigen-generator-nx:generate` |
| `tsconfig.json` | create | Extends `tsconfig.base.json` |
| `tsconfig.lib.json` | create | outDir `dist/out-tsc` |
| `vite.config.ts` | create | Externalize `commander` |
| `src/api.ts` | create | Apigen extraction surface — thin router, JSDoc'd exports only |
| `src/lib/core.ts` | create | Real implementation wiring to `Environment`, `readSnapshot`, `writeSnapshot` |
| `src/__tests__/cli.test.ts` | create | Smoke test: spawns generated CLI, asserts exit codes + JSON output |

#### `src/api.ts` — apigen extraction surface (the contract the generator reads)

Every function signature below is the **exact contract** that apigen reads via ts-morph. Parameter names become `--kebab-case` CLI flags. Boolean params use explicit defaults (no `?`) so the generator extracts clean boolean types.

```typescript
/**
 * api.ts — apigen extraction surface for environment-cli.
 *
 * Plain, JSDoc'd async functions ONLY. No interfaces, no class instances,
 * no function-typed parameters. @adhd/apigen reads this file (ts-morph +
 * ts-json-schema-generator) to derive a JSON Schema per export and project
 * it to a Commander CLI — one .command() per export, flags derived from
 * each schema's data.properties.
 *
 * This file does no business logic — it is a thin command router over the
 * @adhd/environment stack. Real wiring lives in ./lib/core.ts.
 */

import type { EnvironmentSnapshot } from '@adhd/environment';

// ---- core.ts re-exports (implementation detail) ----
import {
  initCore, statusCore, verifyCore, doctorCore,
  configGetCore, configSetCore, configRemapCore, configHashCore,
  snapshotExportCore, snapshotDiffCore,
} from './lib/core.js';

// ---- return types (must be simple objects — JSON-serializable) ----

export interface InitResult {
  projectName: string;
  snapshotPath: string;
  directories: string[];
  configHash: string;
  structureHash: string;
}

export interface StatusEntry {
  name: string;
  type: string;
  path: string;
  exists: boolean;
}

export interface StatusResult {
  projectName: string;
  envPrefix: string;
  snapshotPath: string;
  configHash: string;
  structureHash: string;
  directories: StatusEntry[];
  envVars: Record<string, string>;
  warnings: string[];
}

export interface VerifyFinding {
  level: 'error' | 'warning';
  message: string;
}

export interface VerifyResult {
  passed: boolean;
  findings: VerifyFinding[];
}

export interface DoctorResult {
  fixed: string[];
  skipped: string[];
  errors: string[];
}

// ---- commands ----

/**
 * Initialize a new environment for a project.
 * Creates ~/.adhd/<name>/ with standard directories and writes the
 * first adhd-environment.json snapshot.
 *
 * @param projectName - Unique project name (e.g. "agent-mcp").
 * @param description - Human-readable project description.
 * @param fromPackage - Derive identity from the current directory's package.json.
 * @param dryRun - Show what would be created without writing anything.
 */
export async function init(
  projectName: string,
  description = '',
  fromPackage = false,
  dryRun = false,
): Promise<InitResult> {
  return initCore(projectName, { description, fromPackage, dryRun });
}

/**
 * Show the current state of a project's environment.
 *
 * @param projectName - Project name.
 * @param json - Output as JSON (default: human-readable table).
 */
export async function status(
  projectName: string,
  json = false,
): Promise<StatusResult> {
  return statusCore(projectName, { json });
}

/**
 * Verify a project's environment against its snapshot.
 * Exit 0 if clean, exit 1 if findings. CI gate.
 *
 * @param projectName - Project name.
 * @param strict - Treat warnings as errors.
 * @param againstSnapshot - Path to a snapshot file to compare against (default: on-disk snapshot).
 */
export async function verify(
  projectName: string,
  strict = false,
  againstSnapshot?: string,
): Promise<VerifyResult> {
  return verifyCore(projectName, { strict, againstSnapshot });
}

/**
 * Fix environment issues automatically.
 *
 * @param projectName - Project name.
 * @param yes - Non-interactive: fix everything without prompting.
 * @param dryRun - Show what would be fixed without applying changes.
 */
export async function doctor(
  projectName: string,
  yes = false,
  dryRun = false,
): Promise<DoctorResult> {
  return doctorCore(projectName, { yes, dryRun });
}

/**
 * Get a resolved config value. Omit field to get all.
 *
 * @param projectName - Project name.
 * @param field - Dot-path field name (e.g. "db.path"). Omit for all.
 */
export async function configGet(
  projectName: string,
  field?: string,
): Promise<Record<string, unknown>> {
  return configGetCore(projectName, field);
}

/**
 * Set a config override. Writes to the project's .adhd/.env.
 *
 * @param projectName - Project name.
 * @param field - Dot-path field name (e.g. "db.path").
 * @param value - New value.
 */
export async function configSet(
  projectName: string,
  field: string,
  value: string,
): Promise<{ field: string; value: string }> {
  return configSetCore(projectName, field, value);
}

/**
 * Remap an env var alias. Writes to the project's .adhd/.env.
 *
 * @param projectName - Project name.
 * @param originalVar - The env var the package expects (e.g. ADHD_AGENT_MCP_DB_PATH).
 * @param aliasedVar - The env var to read from instead (e.g. CUSTOM_DB_PATH).
 */
export async function configRemap(
  projectName: string,
  originalVar: string,
  aliasedVar: string,
): Promise<{ originalVar: string; aliasedVar: string }> {
  return configRemapCore(projectName, originalVar, aliasedVar);
}

/**
 * Print the current config hash.
 *
 * @param projectName - Project name.
 */
export async function configHash(
  projectName: string,
): Promise<{ hash: string }> {
  return configHashCore(projectName);
}

/**
 * Export the current snapshot as JSON. Prints to stdout or writes to a file.
 *
 * @param projectName - Project name.
 * @param outFile - Write to this file instead of stdout.
 */
export async function snapshotExport(
  projectName: string,
  outFile?: string,
): Promise<EnvironmentSnapshot> {
  return snapshotExportCore(projectName, outFile);
}

/**
 * Diff two snapshots. Prints structural differences.
 *
 * @param projectName - Project name.
 * @param againstFile - Path to the snapshot to compare against.
 */
export async function snapshotDiff(
  projectName: string,
  againstFile: string,
): Promise<VerifyFinding[]> {
  return snapshotDiffCore(projectName, againstFile);
}
```

#### `project.json` — generate-cli target

```json
{
  "name": "environment-cli",
  "sourceRoot": "packages/environment/environment-cli/src",
  "projectType": "library",
  "tags": ["entrypoint:cli", "pkg-class:entrypoint", "platform:node"],
  "targets": {
    "generate-cli": {
      "executor": "@adhd/apigen-generator-nx:generate",
      "options": {
        "source": "src/api.ts",
        "type": "cli",
        "outDir": "dist/packages/environment/environment-cli/cli"
      }
    }
  }
}
```

#### Generated CLI commands

| `api.ts` export | Generated command | Example |
|---|---|---|
| `init(projectName, ...)` | `adhd-env init` | `adhd-env init --project-name agent-mcp --from-package` |
| `status(projectName, ...)` | `adhd-env status` | `adhd-env status --project-name agent-mcp --json` |
| `verify(projectName, ...)` | `adhd-env verify` | `adhd-env verify --project-name agent-mcp --strict` |
| `doctor(projectName, ...)` | `adhd-env doctor` | `adhd-env doctor --project-name agent-mcp --yes` |
| `configGet(projectName, ...)` | `adhd-env config-get` | `adhd-env config-get --project-name agent-mcp --field db.path` |
| `configSet(projectName, ...)` | `adhd-env config-set` | `adhd-env config-set --project-name agent-mcp --field db.path --value /custom` |
| `configRemap(projectName, ...)` | `adhd-env config-remap` | `adhd-env config-remap --project-name agent-mcp --original-var ADHD_DB --aliased-var CUSTOM_DB` |
| `configHash(projectName)` | `adhd-env config-hash` | `adhd-env config-hash --project-name agent-mcp` |
| `snapshotExport(projectName, ...)` | `adhd-env snapshot-export` | `adhd-env snapshot-export --project-name agent-mcp --out-file /tmp/snap.json` |
| `snapshotDiff(projectName, ...)` | `adhd-env snapshot-diff` | `adhd-env snapshot-diff --project-name agent-mcp --against-file /tmp/old.json` |

#### `src/lib/core.ts` — real implementation (sketch)

```typescript
import { Environment, readSnapshot, writeSnapshot } from '@adhd/environment';
import type { EnvironmentSnapshot, DirectoryEntry } from '@adhd/environment';

// Thin wrappers that construct Environment, call methods, return plain objects.
// The api.ts functions call these — api.ts never touches Environment directly
// because Environment is a class (not a scalar param — incompatible with apigen).

export async function initCore(
  projectName: string,
  opts: { description?: string; fromPackage?: boolean; dryRun?: boolean }
): Promise<InitResult> {
  const env = new Environment({
    project: { name: projectName, description: opts.description },
  });
  if (opts.dryRun) {
    return { projectName, snapshotPath: '', directories: env.dirs.names, configHash: '', structureHash: '' };
  }
  const snapshot = env.initialize();
  return {
    projectName,
    snapshotPath: writeSnapshot(projectName, snapshot),
    directories: env.dirs.names,
    configHash: snapshot.version.configHash,
    structureHash: snapshot.version.structureHash,
  };
}

// ... statusCore, verifyCore, doctorCore, etc. — same pattern:
// construct Environment → call method → return plain object.
```

---

## TypeScript interfaces

### `Environment` — composition root

```typescript
export interface EnvironmentOptions {
  /** Project identity. */
  project: ProjectIdentity;
  /** Directory entries (constructor-only — no runtime registration). */
  dirs?: DirectoryEntry[];
  /** Config resolver options. */
  config?: Omit<ConfigResolverOptions, 'prefix'>;
  /** .env load order override. Omit for default 3-level hierarchy. */
  envFiles?: string[];
  /** Custom root for ~/.adhd/ (default: os.homedir()/.adhd). */
  adhdRoot?: string;
  /** Custom CWD for project-scoped resolution. */
  cwd?: string;
}

export class Environment {
  readonly project: Readonly<ProjectIdentity>;
  readonly dirs: DirectoryRegistry;
  readonly config: ConfigResolver;
  readonly envPrefix: string;

  constructor(options: EnvironmentOptions);

  /** Full pipeline: load .env, resolve config, ensure dirs, detect changes, write snapshot.
   *  Warns if structure changed from on-disk snapshot.
   *  Throws if a competing structure is detected (directory type changed or
   *  another project claims the same namespace). */
  initialize(): EnvironmentSnapshot;

  /** Re-resolve: invalidates caches, re-loads .env, re-computes hashes, writes snapshot. */
  refresh(): EnvironmentSnapshot;

  /** Get cached snapshot. Throws if initialize() was never called. */
  get snapshot(): EnvironmentSnapshot;
}
```

### `DirectoryRegistry` — directory management (constructor-only)

```typescript
export interface DirectoryRegistrySnapshot {
  paths: Record<string, string>;
  entries: Record<string, DirectoryEntry>;
}

export class DirectoryRegistry {
  /** All entries declared at construction time. No runtime register(). */
  constructor(rootDir: string, entries: DirectoryEntry[]);

  /** Get resolved absolute path. Throws if directory not declared. */
  path(name: string): string;

  /** All registered directory names. */
  get names(): string[];

  /** Create all directories on disk (mkdir -p). Idempotent. */
  ensure(): void;

  /** Serializable snapshot for hashing and JSON output. */
  snapshot(): DirectoryRegistrySnapshot;
}
```

### `ConfigResolver` — env-var + defaults + aliasing + interpolation

```typescript
export interface ConfigResolverOptions {
  /** Env-var prefix for this project. */
  prefix: string;
  /** Organization name for global/system path roots (default: "adhd"). */
  org?: string;
  /** Dot-path → field definition mapping. */
  fields?: ConfigFieldMap;
  /** Optional Zod schema for typed validation. */
  schema?: Zod.ZodType<unknown>;
  /** Custom .env file load order. */
  envFiles?: string[];
}

export interface ConfigSnapshot {
  /** Flat resolved key→value map (all strings, ${VAR} expanded). */
  raw: Record<string, string>;
  /** Typed config (only when schema is provided). */
  typed?: unknown;
  /** Content hash (SHA-256 of sorted raw values). */
  hash: string;
  /** All env vars read during resolution → their resolved values. */
  envVars: Record<string, string>;
}

export class ConfigResolver {
  constructor(options: ConfigResolverOptions);

  /**
   * Resolve all config fields.
   * @param envSnapshot    Test injection — overrides process.env for specific vars.
   * @param envOverrides   Aliasing map: {"ORIGINAL_VAR": "ALIASED_VAR"}.
   *                       When ORIGINAL_VAR is read, ALIASED_VAR is used instead.
   */
  resolve(
    envSnapshot?: Record<string, string | undefined>,
    envOverrides?: Record<string, string>
  ): ConfigSnapshot;

  /** Clear cached resolution — next resolve() re-reads env and re-computes. */
  invalidate(): void;
}
```

### Exported utilities

```typescript
export function parseEnvFile(filePath: string): Record<string, string>;
export function loadEnvHierarchy(cwd?: string): void;
export function loadEnvFiles(paths: string[], cwd?: string): void;
export function interpolate(value: string, context: Record<string, string>): string;
export function contentHash(config: Record<string, string>): string;
export function structureHash(dirs: DirectoryRegistrySnapshot): string;
export function unflatten(flat: Record<string, string>): Record<string, unknown>;
export function projectEnvPrefix(name: string): string;
export function readSnapshot(projectName: string, adhdRoot?: string): EnvironmentSnapshot;
export function writeSnapshot(projectName: string, snapshot: EnvironmentSnapshot, adhdRoot?: string): string;
```

### Types

```typescript
export type DirectoryType =
  | 'state.data' | 'state.config'
  | 'runtime.log' | 'runtime.cache' | 'runtime.pid'
  | 'user.bin' | 'user.custom';

export type ConfigScope = 'project' | 'global' | 'system';

export interface ProjectIdentity {
  name: string;
  description?: string;
  repo?: string;
  homepage?: string;
  license?: string;
  meta?: Record<string, string>;
}

export interface DirectoryEntry {
  name: string;
  type: DirectoryType;
  description: string;
}

export interface ConfigFieldDefinition {
  /** Env var name that overrides this field. */
  env: string;
  /** Default value when env is unset. May contain ${VAR} refs. */
  default: string;
  /** Scope for resolving the default path. */
  scope: ConfigScope;
}

export type ConfigFieldMap = Record<string, ConfigFieldDefinition>;

export interface EnvironmentSnapshot {
  project: ProjectIdentity;
  version: {
    configHash: string;
    structureHash: string;
    generatedAt: string;
    libraryVersion: string;
  };
  directories: Record<string, {
    path: string;
    type: DirectoryType;
    description: string;
  }>;
  config: Record<string, unknown>;
  envPrefix: string;
  envVars: Record<string, string>;
}
```

---

## Behavioral specification

### `parseEnvFile` — internal `.env` parser (zero deps)

Replaces `dotenv`. Pure function — reads a file, returns a `Record<string, string>`. Never mutates `process.env`.

- Skips blank lines and `#`-prefixed lines (trimmed first).
- Splits on first `=` only.
- Strips `export ` prefix from keys.
- Strips matching single or double quotes from values.
- `${VAR}` references are **not expanded** — preserved as literal strings for later resolution.
- Returns empty object for missing files (ENOENT). Throws on other read errors.

### `interpolate` — variable expansion per §3a

```typescript
function interpolate(value: string, context: Record<string, string>): string
```

Finds all `${VAR}` patterns in `value`. For each:
1. Look up `VAR` in `context` (same-file env vars + process.env).
2. If found, replace with the resolved value.
3. If not found, leave `${VAR}` as literal text (no error).

Recursive references (`${A}` → resolves to `${B}` → resolves to `value`) are NOT supported in v1 — only one level of expansion.

### `contentHash` + `structureHash` — dual hashing

`contentHash`: hashes sorted `key=value\n` pairs of resolved config (per §5). Test vector MUST pass.

`structureHash`: hashes sorted `name:type\n` entries of the directory registry (per §5a). This is independent of absolute paths — it detects logical structure changes.

### `ConfigResolver.resolve()` — resolution order

1. Load `.env` files (side effect on `process.env`).
2. Apply `envOverrides`: for each `[original, aliased]`, if a field reads from `original`, redirect to `aliased`.
3. For each field in `fields`: check `envSnapshot?.[fieldDef.env]` → `process.env[fieldDef.env]` → scoped default.
4. Run `interpolate(value, process.env)` on each resolved value to expand `${VAR}` refs.
5. If `schema` is provided: `unflatten(raw)` → `schema.parse(nested)`.
6. Compute `contentHash(raw)`.
7. Cached. `invalidate()` clears.

### `Environment.initialize()` — full pipeline with change detection

1. Load `.env` files (delegates to ConfigResolver).
2. Resolve config (delegates to ConfigResolver).
3. Compute `structureHash(dirs.snapshot())`.
4. **Read on-disk snapshot** (if exists). Compare `structureHash`:
   - **Hash matches:** No structural change. Proceed.
   - **Hash differs:** Compare directory entries:
     - New directories added → **warn** (log each new dir with its type).
     - Directories removed → **warn** (log each removed dir).
     - Directory types changed → **throw** `Error("Competing structure: <dir> changed from <old> to <new>")`.
     - Project name mismatch in on-disk snapshot → **throw** `Error("Namespace conflict: <path> already claimed by <other-project>")`.
5. `dirs.ensure()` — create all directories on disk.
6. Build `EnvironmentSnapshot`.
7. **Atomic write:** write to `<path>.tmp`, then `renameSync` to `<path>`.
8. Cache and return snapshot.

### `Environment.refresh()` — re-resolution

Invalidates config cache, re-runs full `initialize()` pipeline. Used when `.env` files change at runtime.

---

## Independent segments (implementation order)

### Segment 1 — Contract package (`environment-base-spec`)

**Files:** All files in `packages/environment/environment-base-spec/`  
**Dependencies:** none  
**Output tokens:** ~2,430  
**Strategy:** Scaffold package, write `adhd-environment.schema.json` (validate against JSON Schema meta-schema), write `SPEC.md` §1–§6 with updated content (hierarchical dirs, interpolation, structure hashing, atomic writes), write `src/index.ts`.

### Segment 2 — Core utilities (`environment-core-node`)

**Files:** package.json, project.json, tsconfig.json, tsconfig.lib.json, vite.config.ts, `src/lib/types.ts`, `src/lib/parse-env-file.ts`, `src/lib/interpolate.ts`, `src/lib/unflatten.ts`, `src/lib/content-hash.ts`, `src/lib/project-identity.ts`  
**Dependencies:** Segment 1 (types must match schema)  
**Output tokens:** ~2,200  

### Segment 3 — Env loader + DirectoryRegistry

**Files:** `src/lib/env-loader.ts`, `src/lib/directory-registry.ts`  
**Dependencies:** Segment 2  
**Output tokens:** ~550  

### Segment 4 — ConfigResolver + snapshot + Environment + index

**Files:** `src/lib/config-resolver.ts`, `src/lib/snapshot.ts`, `src/lib/environment.ts`, `src/index.ts`  
**Dependencies:** Segments 2, 3  
**Output tokens:** ~1,600  

### Segment 5 — Tests

**Files:** All `src/__tests__/*.test.ts`  
**Dependencies:** Segments 1–4  
**Output tokens:** ~2,800  

### Segment 6 — Python stubs + contract test

**Files:** All files in `packages/environment/environment-core-py/`  
**Dependencies:** Segment 1 (spec is the contract)  
**Output tokens:** ~2,000  

### Segment 7 — Rust stubs + contract test

**Files:** All files in `packages/environment/environment-core-rs/`  
**Dependencies:** Segment 1 (spec is the contract)  
**Output tokens:** ~2,000  

### Segment 8 — CLI package (`environment-cli`)

**Files:** All files in `packages/environment/environment-cli/` (package.json, project.json, tsconfig, vite.config, `src/api.ts`, `src/lib/core.ts`, `src/__tests__/cli.test.ts`)  
**Dependencies:** Segments 1–4 (library must build before CLI can extract)  
**Read tokens:** ~100 (reference `entrypoint/dispatch-cli/` for template)  
**Output tokens:** ~3,000  
**Strategy:**
1. Scaffold the package with package.json (`@adhd/environment-cli`, deps on `@adhd/environment` + `commander` + `@adhd/apigen-engine-runtime`).
2. Write `src/api.ts` — exact function signatures as shown above. Every export is a thin router calling `core.ts`. Params are scalar only. Booleans use explicit defaults.
3. Write `src/lib/core.ts` — real implementation: construct `Environment` instances, call `initialize()`/`refresh()`, return plain objects. No classes in signatures.
4. Write `project.json` with `generate-cli` target pointing `source: "src/api.ts"` → `type: "cli"` → `outDir: "dist/packages/environment/environment-cli/cli"`.
5. Write smoke test: spawn the generated CLI, assert `--help` exits 0, `init --project-name test --dry-run` exits 0.  

---

## Test cases

### Contract compliance tests (`contract-compliance.test.ts`)

- `contentHash({ b: "2", a: "1" })` === exact test vector
- `projectEnvPrefix("agent-mcp")` === `"ADHD_AGENT_MCP"`
- `projectEnvPrefix("my app")` === `"ADHD_MY_APP"`
- `structureHash()` produces deterministic output for same directory set
- `structureHash()` changes when dir type changes
- Write snapshot → read back → deep-equal round-trip
- Written JSON validates against `adhd-environment.schema.json`
- Atomic write: if write fails mid-way, no partial `.json` file exists (only `.tmp`)

### Unit tests

- `parseEnvFile`: blank lines, comments, quotes, export prefix, missing file, `${VAR}` preserved as literal
- `interpolate`: `${HOME}` expands, `${UNSET}` stays literal, multiple refs, no recursive expansion
- `DirectoryRegistry`: constructor entries, path resolution, ensure idempotency, snapshot shape, duplicate name throws
- `ConfigResolver`: env var wins, default fallback, empty string treated as set, aliasing redirects env reads, `${VAR}` expansion in resolved values, schema validation, cache+invalidate
- `Environment`: full pipeline, structure change detection (warn on new/removed, throw on type change, throw on namespace conflict), idempotent initialize, refresh after env change, snapshot getter before initialize throws

### Integration tests

- Full pipeline: construct → initialize → verify snapshot on disk → verify directories exist → verify both hashes
- Two `Environment` instances → different project names → no collision
- Structure change: initialize with dirs A → modify to dirs B → re-initialize → warns on removed A, warns on new B

### Python/Rust contract tests

- `content_hash({"b": "2", "a": "1"})` === exact test vector (MUST pass)
- `structure_hash()` produces same output as TypeScript for identical input (cross-language parity)

---

## Edge cases

| Case | Behavior |
|---|---|
| Empty project name | `projectEnvPrefix("")` → `"ADHD_"` |
| Special chars in name | Non-`[A-Za-z0-9_-]` → mapped to `_` |
| No `.env` files exist | `loadEnvHierarchy()` no-op |
| `~/.adhd/` doesn't exist | `ensure()` and `writeSnapshot()` create it |
| Empty string env var | Treated as set — fails Zod validation, not silently using default |
| `~` in defaults | Expanded to `os.homedir()` at resolution time |
| `~` in `.env` values | NOT expanded by parser — but `interpolate` can expand `${HOME}` |
| `${VAR}` in `.env` values | Preserved as literal by parser, expanded by `interpolate` during `resolve()` |
| `${UNSET_VAR}` | Left as literal `${UNSET_VAR}` — no error |
| Recursive `${VAR}` | NOT expanded in v1 — only one level |
| Zod not installed | `validate()` throws with descriptive error |
| Snapshot file write fails mid-way | `.tmp` file may exist but `.json` is untouched |
| Concurrent access | Not guarded — last write wins (v1) |
| Custom `adhdRoot` | Testing override — points to temp dir |
| Cross-language hash parity | Test vector is the gate — Python/Rust MUST match TypeScript output |

---

## Future client gate

Each new language client MUST pass the §5 test vector before being considered complete:

```
Input:  { "b": "2", "a": "1" }
Output: "sha256-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
```

Any implementation producing a different hash is non-conformant.

---

## Migration targets (future — separate plans)

- `entrypoint/agent-mcp` — replace `config.ts` + `load-env.ts` with `Environment`
- `packages/agent/agent-engine-compiler` — replace ad-hoc `REGISTRY_DATABASE_PATH`
- `packages/agent/agent-store-prompts` — replace ad-hoc `DATABASE_PATH`
- `packages/agent/agent-store-tools` — replace ad-hoc `DATABASE_PATH`
- `packages/agent/agent-core-policy` — replace ad-hoc `DATABASE_PATH`
- `packages/agent/agent-core-provider` — replace ad-hoc `DATABASE_PATH`

## Related documents

- `docs/plan/workspace-cleanup/SCOPE.md` — monorepo naming convention
- `BACKLOG.md` §FEAT-ENV-001 — backlog entry (updated)
- sox-ecosystem analysis — patterns adopted: scope cascade, data-root resolver, atomic writes, `CONFIG_*` injection
