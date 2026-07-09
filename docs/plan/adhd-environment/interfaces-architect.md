# @adhd/environment v0.0.5 — Implementation Interfaces & Wiring

> **Role:** Architecture specification — the contract implementers code against.
> **Status:** Authoritative for all v0.0.5 implementations.
> **Derived from:** SCOPE.md, SPEC_0.0.5.md, USE_CASES.md, TOOLS.md, dag.json, apigen patterns.

---

## 1. Package Dependency Graph & Build Order

```
                          environment-base-spec
                          (no deps)
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                 ▼
     environment-builder  environment-core-py  environment-core-rs
     (yaml, ajv)          (jsonschema)         (serde, sha2, jsonschema)
              │
              ├──────────────────┐
              ▼                  ▼
     environment-core-node   environment-cli
     (no runtime deps)       (apigen, builder, core-node)
```

**Build order:** `base-spec` → `builder` + `core-py` + `core-rs` (parallel) → `core-node` → `cli`

**npm scope:** All under `@adhd/`. Package names:
- `@adhd/environment-base-spec` — JSON Schema, test vectors, SPEC.md
- `@adhd/environment-builder` — internal builder engine (not published)
- `@adhd/environment` — TypeScript runtime client (npm: `@adhd/environment`)
- `@adhd/environment-cli` — CLI (npm: `@adhd/environment-cli`)
- `adhd-environment` — Python runtime client (PyPI)
- `adhd-environment` — Rust runtime client (crates.io)

---

## 2. Type Definitions — `environment-base-spec`

Package: `packages/environment/environment-base-spec`

### 2.1 `src/types.ts` — Canonical TypeScript Interfaces

These are the **authoritative interfaces** shared by all TypeScript packages. The builder and runtime packages re-export from here.

```typescript
// ============================================================
// 2.1.1 Project Configuration (adhd.environment.yaml shape)
// ============================================================

export interface ProjectConfig {
  /** Project name (kebab-case). Required. */
  name: string;

  /** Organization namespace. Defaults to "adhd". Feeds directory path. */
  orgNamespace?: string;

  /** Optional. When absent, env prefix is inferred from project name:
   *    projectName → uppercase, dots→underscores → "ADHD_" + result
   *    Ex: "agent-mcp" → "ADHD_AGENT_MCP"
   */
  envPrefixOverride?: string;

  /** Optional. Description for documentation. */
  description?: string;

  /** Optional. When absent, namespace defaults to "default".
   *  When listed, only those namespaces are valid — no automatic "default".
   */
  namespaces?: string[];

  /** Directory catalog. Optional — projects with no dirs declare `dirs: []`. */
  dirs?: DirectoryEntry[];

  /** Config field definitions by scope. */
  config?: {
    system?: Record<string, ConfigFieldDefinition>;
    global?: Record<string, ConfigFieldDefinition>;
    project?: Record<string, ConfigFieldDefinition>;
  };
}

// ============================================================
// 2.1.2 Parsed YAML Spec (parsed from adhd.environment.yaml)
// ============================================================

export interface ParsedYamlSpec {
  project: ProjectConfig;
  /** Populated from YAML `namespaces:` or defaults to ["default"]. */
  namespaces: string[];
  /** Populated from YAML `dirs:` or defaults to []. */
  dirs: DirectoryEntry[];
  /** Populated from YAML `config:` scopes. */
  config: {
    system: Record<string, YamlFieldDefinition>;
    global: Record<string, YamlFieldDefinition>;
    project: Record<string, YamlFieldDefinition>;
  };
  /** Resolved org namespace (explicit or "adhd"). */
  orgNamespace: string;
  /** Resolved env prefix (from override or inferred). */
  envPrefix: string;
}

// ============================================================
// 2.1.3 Directory Entry
// ============================================================

export type DirectoryType = 'state.data' | 'runtime.log' | 'runtime.cache' | 'runtime.temp';

export interface DirectoryEntry {
  /** Type-primary key for directory lookup. */
  type: DirectoryType;

  /** Optional name for disambiguation when multiple dirs share a type.
   *  Used in lookup: `path("state.data", "registry")` vs `path("state.data")`.
   */
  name?: string;

  /** Optional path override. When absent, path is auto-derived from
   *  orgNamespace/project/namespace/scope/{type}/{name?}.
   *  Supports $HOME, ${PROJECT_ROOT}, ${NAMESPACE} interpolation.
   */
  path?: string;

  /** Scope: system | global | project. Default: project. */
  scope?: 'system' | 'global' | 'project';

  /** Optional description for documentation. */
  description?: string;
}

// ============================================================
// 2.1.4 YAML Field Definition (as authored in adhd.environment.yaml)
// ============================================================

export interface YamlFieldDefinition {
  /**
   * JSON Schema type keyword. Valid values:
   *   "string", "integer", "number", "boolean", "array"
   */
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';

  /** Default value. Used when no env var or stored value is present. */
  default?: unknown;

  /** Optional. Explicit env var name override. When absent, env var
   *  is inferred from project prefix + field path.
   */
  env?: string;

  /** Optional scope override (for field-level scope, rare). */
  scope?: 'system' | 'global' | 'project';

  /** Optional description for documentation. */
  description?: string;

  // JSON Schema validation keywords — all optional.
  // These are passed through to the generated fieldSchema.
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
  secret?: boolean; // marks field as sensitive (not logged)

  /** Optional. When true, env var inference is suppressed for this field.
   *  The field can only be set via `adhd-env set` or `default`.
   */
  noEnv?: boolean;
}

// ============================================================
// 2.1.5 Config Field Definition (resolved, merged, scope-aware)
// ============================================================

export interface ConfigFieldDefinition {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  default: unknown;
  /** Effective scope after merge (project > global > system). */
  scope: 'system' | 'global' | 'project';
  /** Effective env var name. If env is explicitly set in YAML, that value.
   *  Otherwise, inferred from prefix + field path.
   */
  env: string;
  /** The source scope from which this field originated. */
  sourceScope: 'system' | 'global' | 'project';
  description?: string;
  secret?: boolean;
  noEnv?: boolean;
  // Validation keywords (merged from all scopes):
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
}

// ============================================================
// 2.1.6 Provenance Entry
// ============================================================

export interface ProvenanceEntry {
  /** The source of the resolved value.
   *  "project.env" — from process.env at build time
   *  "project.set" — from `adhd-env set` stored value
   *  "project.default" — from field default
   *  "project.override" — from envVarOverride in field definition
   *  "global.env" — global-scoped env
   *  "global.default" — global-scoped default
   *  "system.default" — system-scoped default
   */
  source: string;
  /** The effective scope of the resolved value. */
  scope: 'system' | 'global' | 'project';
  /** The env var name, if resolved from an env var. */
  env?: string;
}

// ============================================================
// 2.1.7 Snapshot Shape (what gets written to disk)
// ============================================================

export interface SnapshotData {
  /** Snapshot format version (semver). */
  version: string;
  /** Library version that produced this snapshot. */
  libraryVersion: string;
  /** ISO timestamp of when the snapshot was generated. */
  generatedAt: string;
  /** Project metadata from the YAML. */
  project: {
    name: string;
    orgNamespace: string;
    envPrefix: string;
    namespace: string;
    description?: string;
  };
  /** Fully resolved, nested config object. */
  config: Record<string, unknown>;
  /** Flat, un-nested config (dot.path → value) for hashing + lookup. */
  raw: Record<string, unknown>;
  /** Generated JSON Schema for validation of `config`. */
  fieldSchema: object | null;
  /** SHA-256 config content hash ("sha256-" + hex). */
  configHash: string;
  /** SHA-256 directory structure hash. */
  structureHash: string;
  /** Resolved directory paths (fully expanded, absolute). */
  dirs: Array<{
    type: DirectoryType;
    name?: string;
    path: string;
    scope: string;
  }>;
  /** Provenance map: flat field path → provenance entry. */
  provenance: Record<string, ProvenanceEntry>;
  /** Env var values recorded at build time. */
  envVars: Record<string, string>;
}

// ============================================================
// 2.1.8 Build Options
// ============================================================

export interface BuildOptions {
  /** Target namespace. Defaults to "default". */
  namespace?: string;
  /** Scope filter. When set, only fields from that scope are resolved. */
  scope?: 'system' | 'global' | 'project';
  /** Override the ADHD root directory. Defaults to os.homedir()/.adhd. */
  adhdRoot?: string;
  /** Custom snapshot output path (overrides auto-derived path). */
  configPath?: string;
  /** When true, skip disk writes (returns snapshot in memory only). */
  dryRun?: boolean;
}

// ============================================================
// 2.1.9 Environment Constructor Params (runtime client)
// ============================================================

export interface EnvironmentParams {
  /** Project name (kebab-case). Required. */
  project: string;
  /** Optional scope filter. */
  scope?: 'system' | 'global' | 'project';
  /** Optional namespace. Defaults to "default". */
  namespace?: string;
  /** Root directory containing org directories. Defaults to os.homedir()/.adhd. */
  adhdRoot?: string;
}

// ============================================================
// 2.1.10 Deep-path type extraction (utility types)

/** Given a nested object type T, extracts the type at a dot-separated path K.
 *  Example: DeepPath<{ a: { b: string } }, "a.b"> → string
 */
export type DeepPath<T, K extends string> =
  K extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? DeepPath<T[Head], Tail>
      : unknown
    : K extends keyof T
      ? T[K]
      : unknown;
```

### 2.2 `src/index.ts` — Package Barrel

```typescript
// environment-base-spec — canonical types and utilities
export * from './types';
export { SPEC_VERSION } from './constants';
export { generateFieldSchema } from './json-schema-gen';
export { inferEnvVar, projectEnvPrefix } from './env-prefix';
```

### 2.3 `src/constants.ts`

```typescript
export const SPEC_VERSION = '0.0.5';
export const DEFAULT_ORG_NAMESPACE = 'adhd';
export const DEFAULT_NAMESPACE = 'default';
export const SNAPSHOT_FILENAME = 'adhd-environment.json';
```

### 2.4 Cross-language utilities (pure functions, no deps)

These live in `environment-base-spec` because they must produce identical output in all 3 languages:

```typescript
// src/content-hash.ts
export function contentHash(config: Record<string, string>): string;
// Returns "sha256-" + hex(SHA-256(sorted key=value\n))
// Test vector: {b:"2", a:"1"} → "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"

// src/env-prefix.ts
export function projectEnvPrefix(projectName: string): string;
// "agent-mcp" → "ADHD_AGENT_MCP"
// "decompile-cli" → "ADHD_DECOMPILE_CLI"
// Algorithm: uppercase + replace /-/g with '_' + prepend "ADHD_"

export function inferEnvVar(prefix: string, fieldPath: string): string;
// inferEnvVar("ADHD_AGENT_MCP", "db.path") → "ADHD_AGENT_MCP_DB_PATH"
// Algorithm: uppercase fieldPath + replace /\./g with '_' + prepend prefix + "_"

// src/json-schema-gen.ts
export function generateFieldSchema(fields: Record<string, YamlFieldDefinition>): object;
// Converts flat field definitions → nested JSON Schema object
// Example: {"server.port": {type:"integer", minimum:1024}} →
//   {type:"object", properties: {server: {type:"object", properties: {port: {type:"integer", minimum:1024}}}}}
```

---

## 3. Module Wiring — `environment-builder`

Package: `packages/environment/environment-builder` (internal, not published)

### 3.1 File Structure

```
packages/environment/environment-builder/
├── package.json          # name: "@adhd/environment-builder", deps: yaml, ajv
├── project.json          # tags: ["domain:environment", "layer:logic", "platform:node"]
├── tsconfig.json
├── tsconfig.lib.json
├── tsconfig.spec.json
├── vite.config.ts
└── src/
    ├── index.ts                      # barrel export — see 3.3
    ├── yaml-parser.ts                # parseYamlSpec, validateYamlSpec
    ├── field-merge.ts                # mergeFieldDefinitions
    ├── config-resolver.ts            # resolveConfig, interpolateValue
    ├── json-schema-gen.ts            # generateFieldSchema (re-exports base-spec version + scope-aware wrapper)
    ├── provenance.ts                 # trackProvenance
    ├── validation.ts                 # validateConfig (ajv wrapper)
    ├── snapshot-writer.ts            # atomicWrite, resolveConfigPath
    ├── environment-snapshot.ts       # build(), EnvironmentSnapshot class
    └── __tests__/
        ├── yaml-parser.test.ts
        ├── field-merge.test.ts
        ├── config-resolver.test.ts
        ├── json-schema-gen.test.ts
        ├── provenance.test.ts
        ├── snapshot-writer.test.ts
        └── environment-snapshot.test.ts
```

### 3.2 Module Dependency Graph (internal)

```
yaml-parser.ts ──────────────────────────────────────────────────────┐
  (depends on: environment-base-spec types, yaml npm package)         │
                                                                      │
field-merge.ts ──────────────────────────────────────────────────────┤
  (depends on: environment-base-spec types)                           │
                                                                      │
config-resolver.ts ──────────────────────────────────────────────────┤
  (depends on: field-merge, environment-base-spec types)              │
                                                                      │
json-schema-gen.ts ──────────────────────────────────────────────────┤
  (depends on: field-merge, environment-base-spec types)              │
                                                                      ├──► index.ts
provenance.ts ───────────────────────────────────────────────────────┤
  (depends on: environment-base-spec types)                           │
                                                                      │
validation.ts ───────────────────────────────────────────────────────┤
  (depends on: ajv, environment-base-spec types)                      │
                                                                      │
snapshot-writer.ts ──────────────────────────────────────────────────┤
  (depends on: validation, node:fs, node:crypto)                      │
                                                                      │
environment-snapshot.ts ─────────────────────────────────────────────┘
  (depends on: ALL of the above + node:path, node:os)
```

### 3.3 `src/index.ts` — Barrel Export

```typescript
// Builder engine — everything the CLI and external consumers need

// Factory function
export { build } from './environment-snapshot';

// Class (for instanceof checks and type annotations)
export { EnvironmentSnapshot } from './environment-snapshot';

// YAML parsing
export { parseYamlSpec, validateYamlSpec, DEFAULT_SPEC_TEMPLATE } from './yaml-parser';

// Pipeline steps (exposed for testing and CLI commands that run individual steps)
export { mergeFieldDefinitions } from './field-merge';
export { resolveConfig, interpolateValue } from './config-resolver';
export { generateFieldSchema } from './json-schema-gen';
export { trackProvenance } from './provenance';
export { validateConfig } from './validation';
export { atomicWrite, resolveConfigPath } from './snapshot-writer';

// Utilities
export { contentHash, structureHash } from './hashes';
export { projectEnvPrefix, inferEnvVar } from '@adhd/environment-base-spec';

// Re-export base types for consumers
export type {
  ProjectConfig,
  ParsedYamlSpec,
  YamlFieldDefinition,
  ConfigFieldDefinition,
  DirectoryEntry,
  DirectoryType,
  ProvenanceEntry,
  SnapshotData,
  BuildOptions,
} from '@adhd/environment-base-spec';
```

### 3.4 `src/environment-snapshot.ts` — Core Class & Factory

```typescript
import type { ParsedYamlSpec, BuildOptions, SnapshotData, DeepPath } from '@adhd/environment-base-spec';

/**
 * Typed snapshot instance returned by `build()`.
 *
 * Type parameter `T` provides typed access for `get()`. When omitted,
 * `get()` returns `unknown`.
 *
 * Lifecycle:
 *   1. `build(parsedYamlSpec, options)` — runs the full 17-step pipeline,
 *      returns a valid EnvironmentSnapshot.
 *   2. `build(existingSnapshot, options)` — rebuilds from an existing snapshot,
 *      preserving values set via `.set()` while incorporating YAML changes.
 *   3. `.set(path, value)` — mutates in memory (no validation).
 *   4. `.get(path)` — reads from memory.
 *   5. `.write()` — validates against fieldSchema, atomically writes to disk.
 */
export class EnvironmentSnapshot<T = Record<string, unknown>> {
  /** The resolved snapshot data. */
  private _data: SnapshotData;

  /** The resolved output path for the snapshot file. */
  readonly configPath: string;

  /** The build options used to create this snapshot. */
  readonly options: BuildOptions;

  constructor(data: SnapshotData, configPath: string, options: BuildOptions);

  /**
   * Typed getter. When T is provided, path access is type-safe.
   * Falls back to `unknown` for paths not in T.
   */
  get<K extends string>(path: K): DeepPath<T, K>;

  /**
   * Untyped getter — returns `unknown`. Use when the generic T is not provided.
   */
  get(path: string): unknown;

  /**
   * Typed setter — mutates in memory. No validation occurs until `.write()`.
   */
  set<K extends string>(path: K, value: DeepPath<T, K>): void;

  /**
   * Untyped setter.
   */
  set(path: string, value: unknown): void;

  /**
   * Validate against fieldSchema, then atomically write to configPath.
   * Throws ValidationError if config fails validation.
   * Uses atomic .tmp + renameSync — never creates a partial file.
   *
   * @param opts.skipValidation — when true, bypasses fieldSchema validation.
   */
  write(opts?: { skipValidation?: boolean }): void;

  /**
   * Returns a deep clone of the internal snapshot data.
   */
  toJSON(): SnapshotData;
}

/**
 * Factory function. Runs the full 17-step builder pipeline.
 *
 * @param spec — ParsedYamlSpec (from YAML) or an existing EnvironmentSnapshot (to rebuild).
 * @param options — BuildOptions (namespace, scope, adhdRoot, etc.)
 * @returns EnvironmentSnapshot<T> — typed snapshot instance with set/get/configPath/write.
 */
export function build<T = Record<string, unknown>>(
  spec: ParsedYamlSpec | EnvironmentSnapshot,
  options?: BuildOptions,
): EnvironmentSnapshot<T>;
```

---

## 4. Module Wiring — `environment-core-node`

Package: `packages/environment/environment-core-node` (npm: `@adhd/environment`)

### 4.1 File Structure

```
packages/environment/environment-core-node/
├── package.json          # name: "@adhd/environment", deps: none (runtime)
├── project.json          # tags: ["domain:environment", "layer:shared", "platform:node"]
├── tsconfig.json
├── tsconfig.lib.json
├── tsconfig.spec.json
├── vite.config.ts
└── src/
    ├── index.ts               # barrel export
    ├── environment.ts         # Environment<T> class
    └── __tests__/
        └── environment.test.ts
```

### 4.2 `src/environment.ts` — Runtime Client

```typescript
import type {
  SnapshotData,
  EnvironmentParams,
  ProvenanceEntry,
  DirectoryEntry,
  DeepPath,
} from '@adhd/environment-base-spec';

/**
 * Thin runtime client. Reads a pre-built snapshot JSON file and exposes
 * typed accessors. Does NOT do: YAML parsing, env var resolution, field merge,
 * fieldSchema generation, validation, or directory creation.
 *
 * Usage:
 *   const env = new Environment<AgentMcpConfig>({
 *     project: "agent-mcp",
 *     namespace: "production",
 *   });
 *   const port: number = env.get("config.transport.port");
 *
 * @typeParam T — The config shape type. Defines what `get()` returns.
 *   When omitted, `get()` returns `unknown`.
 */
export class Environment<T = Record<string, unknown>> {
  /** The full snapshot data as read from disk. */
  private readonly _data: SnapshotData;

  /** Project name (kebab-case). */
  readonly project: string;

  /** Effective namespace. */
  readonly namespace: string;

  /** Effective org namespace. */
  readonly orgNamespace: string;

  /** Scope filter (may be undefined = no filter). */
  readonly scope: 'system' | 'global' | 'project' | undefined;

  /** Path to the snapshot file. */
  readonly snapshotPath: string;

  /** Env prefix. Namespace-aware by default; overridable per project via
   *  `envPrefixOverride` in the YAML (agent-mcp sets `ADHD_AGENT` to preserve
   *  its deployed `ADHD_AGENT_*` names — the namespace is not folded in). */
  readonly prefix: string;

  /** Content hash from snapshot. */
  readonly hash: string;

  /**
   * @param params.project — Required. Project name.
   * @param params.namespace — Optional. Defaults to "default".
   * @param params.scope — Optional. Filters returned values by scope.
   * @param params.adhdRoot — Optional. Defaults to `os.homedir() + "/.adhd"`.
   *
   * @throws If the snapshot file does not exist.
   */
  constructor(params: EnvironmentParams);

  /**
   * Typed config/dir/provenance/env accessor.
   *
   * Path prefixes:
   *   "config.*" → reads from _data.config (nested, dot-separated path)
   *   "path.*"   → reads from _data.dirs (by type or type+name)
   *   "env.*"    → reads from _data.envVars
   *   "provenance.*" → reads from _data.provenance
   *
   * Scope filtering: when `this.scope` is set, non-matching values
   *   return undefined.
   *
   * @example env.get("config.transport.port") // number
   * @example env.get("path.state.data")    // string (first matching dir path)
   */
  get<K extends string>(key: K): DeepPath<T, K>;

  /**
   * Untyped accessor — returns `unknown`.
   */
  get(key: string): unknown;

  /**
   * Bracket access shorthand. `env["config.transport.port"]` === `env.get("config.transport.port")`.
   */
  [key: string]: unknown;

  /**
   * Returns a deep-freeze copy of the full snapshot. Used for debugging.
   */
  toJSON(): Readonly<SnapshotData>;
}
```

### 4.3 `src/index.ts` — Barrel Export

```typescript
export { Environment } from './environment';
export type { EnvironmentParams } from '@adhd/environment-base-spec';
```

---

## 5. Module Wiring — `environment-cli`

Package location: `entrypoint/environment-cli/` (npm: `@adhd/environment-cli`)

### 5.1 File Structure

```
entrypoint/environment-cli/
├── package.json          # name: "@adhd/environment-cli"
├── project.json          # tags: ["domain:environment", "layer:presentation", "platform:node", "entrypoint:cli"]
├── tsconfig.json
├── tsconfig.lib.json
├── tsconfig.spec.json
├── vite.config.ts
└── src/
    ├── api.ts                        # apigen extraction surface — see 6.
    ├── core.ts                       # DI'd implementation — all real logic
    ├── commands/
    │   ├── set.ts                    # set command store (builder's internal store)
    │   ├── init.ts                   # generate adhd.environment.yaml template
    │   └── build.ts                  # full build pipeline orchestration
    └── __tests__/
        ├── api.spec.test.ts
        ├── commands/
        │   ├── set.test.ts
        │   ├── init.test.ts
        │   └── build.test.ts
        └── fixtures/
            └── minimal-yaml.yaml
```

### 5.2 `project.json` — CLI Targets

```jsonc
{
  "name": "environment-cli",
  "$schema": "../../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "entrypoint/environment-cli/src",
  "projectType": "library",
  "tags": ["domain:environment", "layer:presentation", "platform:node", "entrypoint:cli", "publish:npm"],
  "targets": {
    "build": {
      "executor": "@nx/js:tsc",
      "outputs": ["{options.outputPath}"],
      "options": {
        "outputPath": "dist/entrypoint/environment-cli",
        "main": "entrypoint/environment-cli/src/index.ts",
        "tsConfig": "entrypoint/environment-cli/tsconfig.lib.json"
      }
    },
    "test": {
      "executor": "@nx/vite:test",
      "options": {
        "configFile": "entrypoint/environment-cli/vite.config.ts"
      }
    },
    "generate-cli": {
      "executor": "@adhd/apigen-generator-nx:generate",
      "options": {
        "source": "src/api.ts",
        "type": "cli",
        "outDir": "dist/entrypoint/environment-cli/cli"
      }
    }
  }
}
```

---

## 6. CLI Command Signatures — `src/api.ts`

### 6.1 Apigen Extraction Surface

Every exported function becomes a CLI command. Parameters must be **scalar primitives** (`string`, `number`, `boolean`, `string[]`) — the apigen extractor derives JSON Schema from these. No complex objects as parameters.

The pattern: `api.ts` is a thin command router. All real logic lives in `core.ts` (which receives DI-injected builder engine). The `ctx` parameter (if present) is excluded from the generated CLI schema.

```typescript
// entrypoint/environment-cli/src/api.ts
// ============================================================
// Thin apigen extraction surface — one exported async function per CLI command.
// All functions call into core.ts for real implementation.
// ============================================================

/**
 * Initialize a new adhd.environment.yaml in the current directory.
 *
 * CLI: adhd-env init [--generate-config]
 */
export async function init(generateConfig: boolean): Promise<InitResult>;

/**
 * Build the environment snapshot from adhd.environment.yaml and stored values.
 *
 * CLI: adhd-env build [--namespace <ns>] [--scope <scope>] [--config <path>] [--adhd-root <path>] [--dry-run]
 */
export async function build(
  namespace: string,      // default: "default"
  scope: string,          // default: "" → no filter. Valid: "system" | "global" | "project"
  config: string,         // default: "adhd.environment.yaml" — path to YAML file
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
  dryRun: boolean,        // default: false
): Promise<BuildResult>;

/**
 * Set a config value in the builder's internal store. No .env file.
 *
 * CLI: adhd-env set <field> <value> [--namespace <ns>] [--config <path>] [--adhd-root <path>]
 */
export async function set(
  field: string,          // dot-path field name, e.g. "providers.openai.secret"
  value: string,          // the value to store
  namespace: string,      // default: "default"
  config: string,         // default: "adhd.environment.yaml"
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<SetResult>;

/**
 * Show the current environment status for a project.
 *
 * CLI: adhd-env status [--project <name>] [--namespace <ns>] [--json]
 */
export async function status(
  project: string,        // default: "" → derive from CWD or YAML
  namespace: string,      // default: "default"
  json: boolean,          // default: false — output JSON instead of human-readable
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<StatusResult>;

/**
 * Verify that a snapshot matches the current YAML spec. Exit 0 if clean,
 * exit non-zero with diff if drifted.
 *
 * CLI: adhd-env verify [--project <name>] [--namespace <ns>] [--config <path>]
 */
export async function verify(
  project: string,        // default: "" → derive from CWD or YAML
  namespace: string,      // default: "default"
  config: string,         // default: "adhd.environment.yaml"
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<VerifyResult>;

/**
 * Diagnose configuration issues. Checks YAML validity, missing env vars,
 * directory existence, snapshot drift, fieldSchema gaps.
 *
 * CLI: adhd-env doctor [--project <name>] [--namespace <ns>] [--config <path>]
 */
export async function doctor(
  project: string,        // default: "" → derive from CWD or YAML
  namespace: string,      // default: "default"
  config: string,         // default: "adhd.environment.yaml"
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<DoctorResult>;

/**
 * Read a single config value from the snapshot.
 *
 * CLI: adhd-env config-get <path> [--project <name>] [--namespace <ns>]
 */
export async function configGet(
  path: string,           // required — dot-path to read, e.g. "config.db.path"
  project: string,        // default: "" → derive from CWD
  namespace: string,      // default: "default"
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<ConfigGetResult>;

/**
 * Export the full snapshot as JSON.
 *
 * CLI: adhd-env export [--project <name>] [--namespace <ns>] [--output <file>] [--pretty]
 */
export async function exportSnapshot(
  project: string,        // default: "" → derive from CWD
  namespace: string,      // default: "default"
  output: string,         // default: "" → stdout. If set, write to file.
  pretty: boolean,        // default: true — pretty-print JSON
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<ExportResult>;

/**
 * Diff two snapshots or compare a snapshot against the current YAML spec.
 *
 * CLI: adhd-env diff [--from <path>] [--to <path>] [--project <name>] [--namespace <ns>]
 */
export async function diff(
  from: string,           // default: "" → current snapshot from YAML. Or path to snapshot.
  to: string,             // default: "" → rebuild from current YAML. Or path to compare.
  project: string,        // default: "" → derive from CWD
  namespace: string,      // default: "default"
  adhdRoot: string,       // default: "" → os.homedir()/.adhd
): Promise<DiffResult>;
```

### 6.2 Return Type Interfaces

```typescript
// These are the return types for the apigen API. They are plain objects
// (JSON-serializable) — no class instances, no functions.

interface InitResult {
  success: boolean;
  path: string;           // path to the created adhd.environment.yaml
  template: string;       // the YAML content (when generateConfig is true)
}

interface BuildResult {
  success: boolean;
  configPath: string;     // path to the written snapshot
  namespace: string;
  configHash: string;
  structureHash: string;
  fieldCount: number;
  dirCount: number;
  warnings: string[];
}

interface SetResult {
  success: boolean;
  field: string;
  value: string;          // masked if field.secret is true
  namespace: string;
  message: string;
}

interface StatusResult {
  project: string;
  namespace: string;
  snapshotPath: string;
  snapshotExists: boolean;
  configHash: string;
  generatedAt: string;
  fieldCount: number;
  dirCount: number;
  envVarCount: number;
}

interface VerifyResult {
  clean: boolean;         // true when snapshot matches YAML
  drift: string[];        // descriptions of what drifted
  hash: string;
}

interface DoctorResult {
  healthy: boolean;
  checks: DoctorCheck[];  // list of pass/fail checks
}

interface DoctorCheck {
  name: string;
  pass: boolean;
  message: string;
}

interface ConfigGetResult {
  path: string;
  value: unknown;
  type: string;
  provenance: {
    source: string;
    scope: string;
    env?: string;
  };
}

interface ExportResult {
  snapshot: object | string;  // the full SnapshotData when output is empty,
                              // or the file path when output is set
}

interface DiffResult {
  hasChanges: boolean;
  added: string[];
  removed: string[];
  changed: Array<{ path: string; from: unknown; to: unknown }>;
}
```

---

## 7. Builder Pipeline — 17-Step Pseudocode

The `build()` factory function in `environment-snapshot.ts` executes this pipeline:

```
INPUT:  spec (ParsedYamlSpec | EnvironmentSnapshot)
        options (BuildOptions)

STEP 1:  PARSE SOURCE
         if spec is EnvironmentSnapshot:
           existing = spec
           yaml = parseYamlSpec(spec.options.configPath → resolve YAML)
         else:
           existing = null
           yaml = spec

STEP 2:  RESOLVE ORG + PREFIX
         org = yaml.project.orgNamespace || "adhd"
         prefix = yaml.project.envPrefixOverride || projectEnvPrefix(yaml.project.name)

STEP 3:  RESOLVE NAMESPACE
         ns = options.namespace || "default"
         if yaml.namespaces.length > 0 && !yaml.namespaces.includes(ns):
           throw Error(`namespace "${ns}" not in declared namespaces: ${yaml.namespaces}`)

STEP 4:  MERGE FIELD DEFINITIONS
         merged = mergeFieldDefinitions(
           yaml.config.system,   // lowest priority
           yaml.config.global,   // mid priority
           yaml.config.project   // highest priority
         )
         // Returns: Record<string, ConfigFieldDefinition>
         // Project overrides global; global overrides system.
         // Validation keywords (minimum, maximum, etc.) are inherited from lower scopes.

STEP 5:  LOAD STORED VALUES (from adhd-env set store)
         store = readStore(adhdRoot, yaml.project.name, ns)
         // File: <adhdRoot>/<org>/<project>/<ns>/.adhd-store.json
         // Returns Record<string, string> (field → value)

STEP 6:  INFER ENV VAR NAMES (for fields without explicit env)
         for each field in merged:
           if merged[field].env is NOT explicitly set:
             merged[field].env = inferEnvVar(prefix, field)

STEP 7:  RESOLVE FIELD VALUES (for each field in merged)
         for each field in merged (optionally filtered by options.scope):
           effectiveEnv = merged[field].env
           resolution chain:
             1. if !merged[field].noEnv && process.env[effectiveEnv] exists:
                  raw[field] = process.env[effectiveEnv]
                  provenance[field] = { source: "<scope>.env", scope, env: effectiveEnv }
             2. else if store[field] exists:
                  raw[field] = store[field]
                  provenance[field] = { source: "<scope>.set", scope }
             3. else if merged[field].default !== undefined:
                  raw[field] = merged[field].default
                  provenance[field] = { source: "<scope>.default", scope }
             4. else:
                  raw[field] = undefined
                  provenance[field] = { source: "<scope>.none", scope }

STEP 8:  PRESERVE EXISTING OVERRIDES (rebuild from snapshot)
         if existing is not null:
           for each field in existing._data.raw:
             if existing field was set via ".set()" call (tracked by internal flag):
               raw[field] = existing._data.raw[field]

STEP 9:  INTERPOLATE ${VAR} REFERENCES
         for each field in raw:
           raw[field] = interpolateValue(raw[field])
           // Single-level only: ${VAR} → process.env[VAR] or literal.
           // Unresolved vars stay as literal "${VAR}".

STEP 10: UNFLATTEN TO NESTED CONFIG
         nested = unflatten(raw)
         // {"db.path": "/tmp/db", "server.port": "3000"} →
         //   {db: {path: "/tmp/db"}, server: {port: "3000"}}

STEP 11: TYPE-COERCE VALUES
         for each field in nested:
           coerce according to merged[field].type:
             "integer" → parseInt
             "number"  → parseFloat
             "boolean" → value === "true" || value === true
             "string"  → String(value)
             "array"   → if string, split on ","
           // Invalid coercion → keep original value + add warning.

STEP 12: GENERATE FIELD SCHEMA
         fieldSchema = generateFieldSchema(merged)
         // Flat definitions → nested JSON Schema object.
         // Validation keywords (minimum, maximum, pattern, enum, etc.)
         // are placed at the leaf properties.

STEP 13: VALIDATE CONFIG
         if fieldSchema is not empty:
           validateConfig(nested, fieldSchema)  // throws on failure

STEP 14: COMPUTE HASHES
         configHash = contentHash(raw)          // sorted key=value\n → SHA-256
         structureHash = structureHash(yaml.dirs)  // sorted type:name:scope → SHA-256

STEP 15: RESOLVE DIRECTORIES
         resolvedDirs = yaml.dirs.map(dir => ({
           ...dir,
           path: resolvePath(dir.path, { home, project, ns, org }),
           scope: dir.scope || "project",
         }))

STEP 16: READ EXISTING + DETECT DRIFT
         existingPath = resolveConfigPath(adhdRoot, org, yaml.project.name, ns)
         if existingPath exists on disk:
           existingSnap = JSON.parse(readFile(existingPath))
           drift = detectDrift(existingSnap, { raw, dirs: resolvedDirs })
           if drift.typeChanges.length > 0: throw DriftError
           if drift.scopeChanges.length > 0: throw DriftError
           if drift.added.length > 0: warn "New dirs added"
           if drift.removed.length > 0: warn "Dirs removed"

STEP 17: BUILD SNAPSHOT + RETURN
         snapshotData: SnapshotData = {
           version: "0.0.5",
           libraryVersion: "0.0.5",
           generatedAt: new Date().toISOString(),
           project: { name: yaml.project.name, orgNamespace: org, envPrefix: prefix, namespace: ns },
           config: nested,
           raw,
           fieldSchema,
           configHash,
           structureHash,
           dirs: resolvedDirs,
           provenance,
           envVars: collectEnvVars(raw, merged),  // map of env var name → value
         }
         return new EnvironmentSnapshot(snapshotData, resolvedPath, options)
```

### Pipeline Step Ownership

| Step | Module | Function | Pure or Side-effecting |
|------|--------|----------|----------------------|
| 1-3 | `yaml-parser.ts`, `environment-snapshot.ts` | `parseYamlSpec`, `projectEnvPrefix` | Pure (except file read) |
| 4 | `field-merge.ts` | `mergeFieldDefinitions` | Pure |
| 5 | `config-resolver.ts` | `readStore` | Side (reads disk) |
| 6-7 | `config-resolver.ts` | `resolveConfig` | Side (reads process.env) |
| 8 | `environment-snapshot.ts` | (inline in build) | Pure |
| 9 | `config-resolver.ts` | `interpolateValue` | Side (reads process.env) |
| 10 | `config-resolver.ts` | `unflatten` | Pure |
| 11 | `config-resolver.ts` | `coerceValue` | Pure |
| 12 | `json-schema-gen.ts` | `generateFieldSchema` | Pure |
| 13 | `validation.ts` | `validateConfig` | Pure (throws) |
| 14 | (inline) | `contentHash`, `structureHash` | Pure |
| 15 | `snapshot-writer.ts` | `resolveDirs` | Pure |
| 16 | `environment-snapshot.ts` | `detectDrift` | Side (reads disk) |
| 17 | `environment-snapshot.ts` | `EnvironmentSnapshot` constructor | Pure (no write yet) |

---

## 8. Internal Store Format (Builder)

The `adhd-env set` command stores values in a simple JSON file. Format (implementation detail — executor may choose alternative):

```
Path: <adhdRoot>/<orgNamespace>/<project>/<namespace>/.adhd-store.json
```

```jsonc
{
  "version": "0.0.5",
  "values": {
    "providers.openai.secret": "sk-...",
    "providers.openai.model": "gpt-4o"
  },
  "updatedAt": "2026-07-08T12:00:00.000Z"
}
```

The store is **flat** (dot-path keys → string values). Type coercion happens at build time in the pipeline (step 11), not at store time.

---

## 9. Test Strategy (per package)

### 9.1 `environment-base-spec`

**Test runner:** Vitest (`@nx/vite:test`)

| Test file | What it tests |
|-----------|---------------|
| `types.test.ts` | TypeScript compilation check — ensure all interface types are exported and usable |
| `content-hash.test.ts` | `contentHash()` — canonical test vector: `{b:"2", a:"1"}` → `"sha256-9f86d08..."`. Also: empty object, single key, special chars in keys/values, order-independence |
| `env-prefix.test.ts` | `projectEnvPrefix()` — "agent-mcp", "decompile-cli", "my.tool", "FOO-BAR". `inferEnvVar()` — contract test vectors from TOOLS.md |
| `json-schema-gen.test.ts` | `generateFieldSchema()` — single flat field → nested schema, multiple fields → nested, inheritance (min/max keywords pass through) |
| `test-vectors.spec.ts` | Cross-language gate — reads `cross-language-test-vectors.json`, runs each vector through the TypeScript implementation, asserts output matches expected. Each vector doc: `{ name, input, expected }` |

### 9.2 `environment-builder`

**Test runner:** Vitest

| Test file | What it tests |
|-----------|---------------|
| `yaml-parser.test.ts` | `parseYamlSpec()` — valid YAML → correct ParsedYamlSpec. Missing project.name → throws. Invalid field type → throws. orgNamespace defaults to "adhd". envPrefixOverride present → used. envPrefixOverride absent → inferred. namespaces absent → defaults to ["default"]. namespaces present → uses them (no automatic "default"). Round-trip: parse → access all fields. |
| `field-merge.test.ts` | `mergeFieldDefinitions()` — system+global+project → project wins. Keywords inherit from lower scopes. Default from project overrides default from global. Empty scopes are valid. |
| `config-resolver.test.ts` | `resolveConfig()` — env var present → uses it. env var absent + default → uses default. env var absent + store value → uses store. env var absent + default absent → undefined. `noEnv` flag suppresses env lookup. `env` override on field uses that env var name instead of inferred. Scope filter: options.scope="project" → ignores system/global fields. |
| `interpolate.test.ts` | `interpolateValue()` — `${HOME}/data` → `/Users/nix/data`. `${MISSING}` → literal `${MISSING}`. `${VAR1}_${VAR2}` → concatenated. Non-string values pass through unchanged. |
| `json-schema-gen.test.ts` | `generateFieldSchema()` — same as base-spec tests, plus: scope-aware generation (scope filter). |
| `provenance.test.ts` | `trackProvenance()` — env source → `{ source: "project.env", scope, env }`. default source → `{ source: "project.default", scope }`. set source → `{ source: "project.set", scope }`. |
| `validation.test.ts` | `validateConfig()` — valid config passes. minimum violation throws. maximum violation throws. enum violation throws. pattern violation throws. Missing required field (no default, no env, no store) — warning not error. Empty fieldSchema → skip validation. |
| `snapshot-writer.test.ts` | `atomicWrite()` — write → file exists. kill mid-write (simulate) → no partial file (only .tmp exists). `resolveConfigPath()` — with namespace → correct path. without namespace → includes "default". orgNamespace in path. |
| `environment-snapshot.test.ts` | `build()` — from ParsedYamlSpec → returns EnvironmentSnapshot. `build()` — from EnvironmentSnapshot → returns EnvironmentSnapshot preserving overrides. `.get()` returns correct value. `.set()` mutates in memory. `.configPath` returns correct path. `.write()` validates + writes atomically. `.write({ skipValidation: true })` bypasses validation. Rebuild preserves set values. |

### 9.3 `environment-core-node`

**Test runner:** Vitest

| Test file | What it tests |
|-----------|---------------|
| `environment.test.ts` | `new Environment(params)` — reads snapshot file (fixture). `env.get("config.db.path")` returns correct value. `env.get("path.state.data")` returns first matching dir path. `env.get("env.OPENAI_API_KEY")` returns recorded env var. `env.get("provenance.db.path")` returns provenance entry. `env.prefix` returns namespace-aware prefix. `env.hash` returns config hash. Bracket access: `env["config.transport.port"]` matches `env.get(...)`. Scope filter: `scope: "system"` hides project values. Missing snapshot throws descriptive error. Typed generic: `Environment<TestConfig>` → `get("config.transport.port")` returns `number` (TypeScript type check). |

**Test fixture:** A minimal `adhd-environment.json` snapshot file in `__tests__/fixtures/`.

### 9.4 `environment-cli`

**Test runner:** Vitest + integration tests

| Test file | What it tests |
|-----------|---------------|
| `api.spec.test.ts` | Each api.ts function exists and has correct parameter types. `__samples__` fixture matches function signatures. |
| `commands/init.test.ts` | `init(true)` → writes `adhd.environment.yaml` to tmpdir. `init(false)` → validates but doesn't write template. Generated YAML has `orgNamespace: adhd`, no `envPrefixOverride`, placeholder namespaces/dirs/config. |
| `commands/set.test.ts` | `set("providers.openai.secret", "sk-test", "production")` → writes to store. Read back from store → value matches. Secret field → value masked in result message. Unset field → store has no entry. |
| `commands/build.test.ts` | `build()` with valid YAML → exits 0, produces snapshot. `build("production")` → snapshot at correct namespace path. `build("default", "project")` → only project-scoped fields in snapshot. `build()` with drifts → detects and reports. `build()` with invalid field → validation error, no snapshot written. Dry run → no file on disk. |
| `integration/cli.smoke.test.ts` | Full pipeline: `init → set → build → status → verify → config-get → export → diff`. Each returns expected result shape. |

### 9.5 `environment-core-py`

**Test runner:** `pytest`

- Contract test vectors from `environment-base-spec/spec/cross-language-test-vectors.json`
- `contentHash()` matches TypeScript output
- `Environment.get()` reads same snapshot as TS client
- `generateFieldSchema()` produces identical JSON

### 9.6 `environment-core-rs`

**Test runner:** `cargo test`

- Contract test vectors from `environment-base-spec/spec/cross-language-test-vectors.json`
- `contentHash()` matches TypeScript output
- `Environment.get()` reads same snapshot as TS client
- `generateFieldSchema()` produces identical JSON
- Serde deserialization round-trip of snapshot JSON

---

## 10. Aggregate Program — Full Assembly Order

```
┌────────────────────────────────────────────────────────────────────┐
│ Segment A: Contract (base-spec)                                     │
│  produces: JSON Schema, test vectors, types, pure util functions    │
│  validates: contentHash test vector gate                            │
│  blocked by: nothing                                               │
├────────────────────────────────────────────────────────────────────┤
│ Segment B1: Builder Engine                                          │
│  produces: yaml-parser, field-merge, config-resolver,               │
│           json-schema-gen, provenance, validation, snapshot-writer  │
│  validates: all unit tests pass                                    │
│  blocked by: Segment A                                              │
├────────────────────────────────────────────────────────────────────┤
│ Segment B2: Builder Snapshot API                                    │
│  produces: environment-snapshot.ts (build + EnvironmentSnapshot)    │
│  validates: build() → valid snapshot → set()/get()/write() work     │
│  blocked by: Segment B1                                             │
├────────────────────────────────────────────────────────────────────┤
│ Segment C1: Runtime Core-Node                                       │
│  produces: Environment<T> class (thin ~60-line client)              │
│  validates: typed get(), bracket access, scope filtering            │
│  blocked by: Segment B2 (needs snapshot fixture)                    │
├────────────────────────────────────────────────────────────────────┤
│ Segment C2: Runtime CLI                                             │
│  produces: api.ts, core.ts, commands/*, generate-cli output         │
│  validates: all commands work, generated CLI compiles               │
│  blocked by: Segment B2 + C1                                        │
├────────────────────────────────────────────────────────────────────┤
│ Segment D1: Runtime Python                                          │
│  produces: py Environment class (~40 lines)                         │
│  validates: contract test vectors pass                              │
│  blocked by: Segment A (test vectors)                               │
├────────────────────────────────────────────────────────────────────┤
│ Segment D2: Runtime Rust                                            │
│  produces: rs Environment struct (~50 lines)                        │
│  validates: contract test vectors pass                              │
│  blocked by: Segment A (test vectors)                               │
├────────────────────────────────────────────────────────────────────┤
│ Segment E: Agent-MCP Refactor                                       │
│  produces: adhd.environment.yaml, slimmed config.ts                 │
│  validates: agent-mcp tests still pass                              │
│  blocked by: Segments A, B, C                                       │
└────────────────────────────────────────────────────────────────────┘
```

**Parallelism:** Segments D1 and D2 can run in parallel with B1/B2/C1. Segment E is the final integrator.

---

## 11. Implementation Notes for Executors

### 11.1 TypeScript generics for typed `get()`

The `DeepPath<T, K>` utility type resolves a dot-separated path to the nested property type. Implementation in `environment-base-spec/src/types.ts`:

```typescript
export type DeepPath<T, K extends string> =
  K extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? DeepPath<T[Head], Tail>
      : unknown
    : K extends keyof T
      ? T[K]
      : unknown;
```

The `EnvironmentSnapshot<T>` and `Environment<T>` classes use overloaded `get()` signatures:

```typescript
// Typed overload (when T is provided)
get<K extends string>(path: K): DeepPath<T, K>;
// Untyped fallback (when T is not provided, or path not in T)
get(path: string): unknown;
```

### 11.2 Bracket access via Proxy or index signature

Option A (simpler): Use `[key: string]: unknown` index signature calling `get()`:

```typescript
class Environment<T> {
  get(key: string): unknown { /* ... */ }

  [key: string]: unknown;
}
// Note: TypeScript does NOT allow method + index signature with different types.
// Executor must resolve — either use a Proxy, or implement bracket access as
// a separate mechanism.
```

Option B (recommended): Use a `Proxy` for bracket access that delegates to `get()`:

```typescript
// In constructor:
return new Proxy(this, {
  get(target, prop) {
    if (typeof prop === 'string' && prop in target) return (target as any)[prop];
    if (typeof prop === 'string') return target.get(prop);
    return undefined;
  }
});
```

### 11.3 Snapshot schema (`adhd-environment.schema.json`)

Must be authored in `environment-base-spec/spec/`. The schema validates `SnapshotData` objects — not the YAML. It defines the on-disk format that all runtime clients read. Key constraints:

- `version` must match `"0.0.5"`
- `config` must be a nested object matching `fieldSchema`
- `provenance` keys must match `raw` keys
- `dirs` entries must have `type`, `path`, `scope`

### 11.4 `tsconfig.base.json` paths

The executor must add 6 new path mappings to `tsconfig.base.json`:

```jsonc
"@adhd/environment-base-spec": ["packages/environment/environment-base-spec/src/index.ts"],
"@adhd/environment-builder": ["packages/environment/environment-builder/src/index.ts"],
"@adhd/environment": ["packages/environment/environment-core-node/src/index.ts"],
"@adhd/environment-cli": ["entrypoint/environment-cli/src/index.ts"]
```

### 11.5 Apigen export mode

Use **named** export mode (the default). The `api.ts` file uses named `export async function` declarations. No `__samples__` export is needed (the apigen extractor skips it).

### 11.6 Python package structure

```
packages/environment/environment-core-py/
├── pyproject.toml
└── src/
    └── adhd_environment/
        ├── __init__.py       # exports Environment class
        └── environment.py    # Environment class implementation
```

### 11.7 Rust crate structure

```
packages/environment/environment-core-rs/
├── Cargo.toml
└── src/
    └── lib.rs               # Environment struct + impl
```

### 11.8 Authored artifacts vs generated

| File | Author or Generate |
|------|--------------------|
| `adhd-environment.schema.json` | Author (base-spec) |
| `cross-language-test-vectors.json` | Author (base-spec) |
| `SPEC.md` | Author (base-spec) |
| `dist/.../cli/cli.ts` | **Generate** (apigen) |
| Snapshot `.json` files | **Generate** (build step) |
| `.adhd-store.json` | **Generate** (set command) |
| `adhd.environment.yaml` templates | **Generate** (init command) |
