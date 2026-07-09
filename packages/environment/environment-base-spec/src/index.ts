/**
 * @adhd/environment-base-spec
 *
 * The canonical, cross-language contract for the `@adhd/environment` package
 * family (TypeScript, Python, Rust). This package has ZERO internal
 * dependencies and is the root of the dependency graph — every other
 * `environment-*` package (builder, core-node, core-py, core-rs, cli) imports
 * its shared types and pure primitives from here.
 *
 * Everything exported from this file MUST:
 *   1. Match `spec/adhd-environment.schema.json` exactly (schema is the
 *      single source of truth for the on-disk snapshot format — see
 *      `spec/SPEC.md`).
 *   2. Produce byte-identical output, for the pure functions
 *      (`contentHash`, `projectEnvPrefix`, `inferEnvVar`,
 *      `generateFieldSchema`), across the TypeScript, Python, and Rust
 *      runtime clients. The pinned vectors in
 *      `spec/cross-language-test-vectors.json` are the gate — never change
 *      the algorithm here without updating all three language clients AND
 *      that vectors file in the same change.
 *
 * NOTE ON FILE LAYOUT: per this package's build-order reservation
 * (docs/plan/adhd-environment/contexts/contract-base-spec.md), the entire
 * contract lives in this single `src/index.ts` module rather than being
 * split across `types.ts` / `constants.ts` / `content-hash.ts` /
 * `env-prefix.ts` / `json-schema-gen.ts`. The section banners below mirror
 * what would otherwise be separate files (see
 * docs/plan/adhd-environment/interfaces-architect.md §2 for the reference
 * module layout other packages are wired against).
 *
 * NOTE ON HASHING: `contentHash()` uses a small hand-rolled, dependency-free
 * SHA-256 implementation (section 14 below) rather than `node:crypto`. This
 * package's Vite library build target externalizes Node builtins as browser
 * stubs (the generator-scaffolded `vite.config.ts` — not owned by this
 * package's build-order reservation — has no `rollupOptions.external` entry
 * for `node:*`), so `import { createHash } from 'node:crypto'` fails at
 * bundle time. A pure-JS implementation sidesteps that entirely, and also
 * more strongly satisfies this package's "zero runtime dependencies"
 * invariant: it needs no Node built-in and is portable to any JS runtime
 * (browser, edge, Node). It is cross-checked byte-for-byte against
 * `node:crypto`'s SHA-256 across ~15 inputs, including every block-padding
 * boundary (55/56/57/63/64/65-byte messages) and multi-megabyte inputs,
 * during development of this contract (see the executor report for
 * `contract-base-spec`).
 */

// ============================================================================
// 1. Constants
// ============================================================================

/** Snapshot contract semver. Bump when the on-disk shape changes. */
export const SPEC_VERSION = '0.0.5';

/** Default org-level directory segment in the data root (see `orgNamespace`). */
export const DEFAULT_ORG_NAMESPACE = 'adhd';

/** Default environment segment when `namespaces` is absent from the YAML. */
export const DEFAULT_NAMESPACE = 'default';

/** Filename of the written snapshot inside its resolved directory. */
export const SNAPSHOT_FILENAME = 'adhd-environment.json';

// ============================================================================
// 2. Shared scalar / union types
//
// Extracted as named types (rather than restating the inline unions from
// interfaces-architect.md §2 everywhere) so every package that needs
// "the scope enum" or "the field type enum" imports one canonical name.
// ============================================================================

/** Three-tier field/config resolution scope. `project` overrides `global`
 *  overrides `system` (see `[def:scope-cascade]` in `contexts/_shared.md`). */
export type ConfigScope = 'system' | 'global' | 'project';

/** JSON-Schema-derived value type a config field may hold. */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'array';

/** Directory catalog entry kind. */
export type DirectoryType =
  | 'state.data'
  | 'runtime.log'
  | 'runtime.cache'
  | 'runtime.temp';

/**
 * The origin of a resolved config field's value, recorded per-field in
 * `SnapshotData.provenance` at build time.
 *
 *  - `"project.env"`      — from `process.env` at build time
 *  - `"project.set"`      — from an `adhd-env set` stored value
 *  - `"project.default"`  — from the field's `default`
 *  - `"project.override"` — from an explicit `env:` override in the field def
 *  - `"global.env"`       — global-scoped env
 *  - `"global.default"`   — global-scoped default
 *  - `"system.default"`   — system-scoped default
 */
export type ProvenanceSource =
  | 'project.env'
  | 'project.set'
  | 'project.default'
  | 'project.override'
  | 'global.env'
  | 'global.default'
  | 'system.default';

// ============================================================================
// 3. Project Configuration (adhd.environment.yaml shape)
// ============================================================================

export interface ProjectConfig {
  /** Project name (kebab-case). Required. */
  name: string;

  /** Organization namespace. Defaults to "adhd". Feeds directory path. */
  orgNamespace?: string;

  /** Optional. When absent, env prefix is inferred from the project name:
   *    projectName → uppercase, dashes→underscores, prepend "ADHD_"
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

/**
 * The resolved identity of a project + namespace pairing — the portion of
 * `SnapshotData` describing *who* produced the snapshot and *where* it
 * lives, independent of the resolved config values themselves.
 */
export interface ProjectIdentity {
  /** Project name (kebab-case). */
  name: string;
  /** Resolved org namespace (explicit or "adhd"). */
  orgNamespace: string;
  /** Resolved env prefix (from `envPrefixOverride` or inferred). */
  envPrefix: string;
  /** The namespace this snapshot was built for (explicit or "default"). */
  namespace: string;
  /** Optional. Description for documentation. */
  description?: string;
}

// ============================================================================
// 4. Parsed YAML Spec (parsed from adhd.environment.yaml)
// ============================================================================

export interface ParsedYamlSpec {
  project: ProjectConfig;
  /** Populated from YAML `namespaces:` or defaults to `["default"]`. */
  namespaces: string[];
  /** Populated from YAML `dirs:` or defaults to `[]`. */
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

// ============================================================================
// 5. Directory Entry
// ============================================================================

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
  scope?: ConfigScope;

  /** Optional description for documentation. */
  description?: string;
}

/** A `DirectoryEntry` after path resolution — as written into the snapshot's
 *  `dirs` array. `path` is now fully expanded and absolute. */
export interface ResolvedDirectoryEntry {
  type: DirectoryType;
  name?: string;
  /** Fully expanded, absolute path. */
  path: string;
  scope: string;
}

// ============================================================================
// 6. YAML Field Definition (as authored in adhd.environment.yaml)
// ============================================================================

export interface YamlFieldDefinition {
  /** JSON Schema type keyword. */
  type: FieldType;

  /** Default value. Used when no env var or stored value is present. */
  default?: unknown;

  /** Optional. Explicit env var name override. When absent, env var
   *  is inferred from project prefix + field path.
   */
  env?: string;

  /** Optional scope override (for field-level scope, rare). */
  scope?: ConfigScope;

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
  /** Marks field as sensitive (not logged). */
  secret?: boolean;

  /** Optional. When true, env var inference is suppressed for this field.
   *  The field can only be set via `adhd-env set` or `default`.
   */
  noEnv?: boolean;
}

// ============================================================================
// 7. Config Field Definition (resolved, merged, scope-aware)
// ============================================================================

export interface ConfigFieldDefinition {
  type: FieldType;
  default: unknown;
  /** Effective scope after merge (project > global > system). */
  scope: ConfigScope;
  /** Effective env var name. If `env` is explicitly set in YAML, that value.
   *  Otherwise, inferred from prefix + field path.
   */
  env: string;
  /** The source scope from which this field originated. */
  sourceScope: ConfigScope;
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

// ============================================================================
// 8. Provenance Entry
// ============================================================================

export interface ProvenanceEntry {
  /** The source of the resolved value. */
  source: ProvenanceSource;
  /** The effective scope of the resolved value. */
  scope: ConfigScope;
  /** The env var name, if resolved from an env var. */
  env?: string;
}

// ============================================================================
// 9. Snapshot Shape (what gets written to disk)
// ============================================================================

export interface SnapshotData {
  /** Snapshot format version (semver). */
  version: string;
  /** Library version that produced this snapshot. */
  libraryVersion: string;
  /** ISO timestamp of when the snapshot was generated. */
  generatedAt: string;
  /** Project metadata from the YAML. */
  project: ProjectIdentity;
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
  dirs: ResolvedDirectoryEntry[];
  /** Provenance map: flat field path → provenance entry. */
  provenance: Record<string, ProvenanceEntry>;
  /** Env var values recorded at build time. */
  envVars: Record<string, string>;
}

/**
 * Alias for `SnapshotData` — the *shape* of a built snapshot.
 *
 * Do not confuse with the `EnvironmentSnapshot` *class* exported by
 * `@adhd/environment-builder` (see interfaces-architect.md §3.4): that class
 * wraps this data shape with `.set()` / `.get()` / `.configPath` / `.write()`
 * builder-side behavior. This package is types-only and owns no behavior
 * beyond the pure cross-language primitives below, so it exports only the
 * data shape, under both names, for callers that reference either.
 */
export type EnvironmentSnapshot = SnapshotData;

// ============================================================================
// 10. Build Options
// ============================================================================

export interface BuildOptions {
  /** Target namespace. Defaults to "default". */
  namespace?: string;
  /** Scope filter. When set, only fields from that scope are resolved. */
  scope?: ConfigScope;
  /** Override the ADHD root directory. Defaults to os.homedir()/.adhd. */
  adhdRoot?: string;
  /** Custom snapshot output path (overrides auto-derived path). */
  configPath?: string;
  /** When true, skip disk writes (returns snapshot in memory only). */
  dryRun?: boolean;
}

// ============================================================================
// 11. Environment Constructor Params (runtime client)
// ============================================================================

export interface EnvironmentParams {
  /** Project name (kebab-case). Required. */
  project: string;
  /** Optional scope filter. */
  scope?: ConfigScope;
  /** Optional namespace. Defaults to "default". */
  namespace?: string;
  /** Root directory containing org directories. Defaults to os.homedir()/.adhd. */
  adhdRoot?: string;
}

// ============================================================================
// 12. Deep-path type extraction (utility types)
// ============================================================================

/** Given a nested object type T, extracts the type at a dot-separated path K.
 *  Example: `DeepPath<{ a: { b: string } }, "a.b">` → `string`
 */
export type DeepPath<T, K extends string> = K extends `${infer Head}.${infer Tail}`
  ? Head extends keyof T
    ? DeepPath<T[Head], Tail>
    : unknown
  : K extends keyof T
    ? T[K]
    : unknown;

// ============================================================================
// 13. Cross-language pure primitives
//
// These four functions must produce byte-identical output in TypeScript,
// Python, and Rust. `spec/cross-language-test-vectors.json` pins the gate.
// ============================================================================

/** Content-hash serialization format version. Bumped from the original
 *  (unversioned) `key=value\n` form to `v2` when the length-prefixed,
 *  injective encoding was adopted (see `contentHash` and SPEC.md §4.1).
 *  Every pinned digest in `cross-language-test-vectors.json` is a `v2`
 *  digest. */
export const CONTENT_HASH_FORMAT_VERSION = 2;

/**
 * Raised by `contentHash` when a key or value contains a lone surrogate
 * code unit (an unpaired UTF-16 surrogate, U+D800–U+DFFF). Such strings are
 * not well-formed Unicode and have no canonical UTF-8 encoding; rather than
 * silently substituting U+FFFD (old TS behaviour) or raising a language-
 * specific encoder error (old Python behaviour), all three ports reject them
 * with this one, specified error. Rust `String`s cannot represent a lone
 * surrogate at all, so the condition is unreachable there by construction.
 */
export class LoneSurrogateError extends Error {
  constructor(
    /** Whether the offending string was a map key or a map value. */
    readonly location: 'key' | 'value',
    /** The offending string (as received). */
    readonly offending: string,
  ) {
    super(`contentHash: lone surrogate in ${location} (not well-formed Unicode)`);
    this.name = 'LoneSurrogateError';
  }
}

/** True if `s` contains an unpaired UTF-16 surrogate code unit. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — must be followed by a low surrogate.
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++; // valid pair — skip the low surrogate
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate with no preceding high surrogate.
      return true;
    }
  }
  return false;
}

/** Ordinal comparison by Unicode code point (NOT UTF-16 code unit).
 *
 * `String.prototype.sort()`'s default and `localeCompare` both order by
 * UTF-16 code unit, which places astral-plane characters (≥ U+10000, encoded
 * as a surrogate pair whose lead unit is 0xD800–0xDBFF) *before* BMP
 * characters in U+E000–U+FFFF. Python's `sorted()` and Rust's `str::cmp`
 * order by scalar value (code point / UTF-8 byte order). This comparator
 * reproduces the Python/Rust order in TS so all three agree — code-point
 * order is the canonical, portable order (see SPEC.md §4.1). */
function codePointCompare(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    const da = ca[i].codePointAt(0) ?? 0;
    const db = cb[i].codePointAt(0) ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  if (ca.length === cb.length) return 0;
  return ca.length < cb.length ? -1 : 1;
}

/** UTF-8 byte length of a (well-formed) string. Callers must reject lone
 *  surrogates first (see `hasLoneSurrogate`) so `TextEncoder` never has to
 *  substitute U+FFFD here. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * `sha256-` hash of a flat config record, using a length-prefixed,
 * **injective** serialization (format `v2`). TS, Python, and Rust MUST all
 * produce the identical hex digest for the identical input.
 *
 * Algorithm (canonical, per SPEC.md §4.1 `[def:contentHash]`):
 *   1. Reject any key or value containing a lone surrogate
 *      (`LoneSurrogateError`).
 *   2. Take `Object.keys(config)`, sort ascending by **Unicode code point**
 *      (NOT UTF-16 code unit — see `codePointCompare`).
 *   3. For each key `k` in that order, let `lk`/`lv` be the UTF-8 byte
 *      lengths of `k` and `config[k]`, and emit the line
 *      `` `${lk}:${k}=${lv}:${config[k]}\n` ``.
 *   4. Concatenate all lines (no extra separator — each carries its own `\n`).
 *   5. SHA-256 the resulting UTF-8 string; hex-encode; prefix `"sha256-"`.
 *
 * The byte-length prefixes make the encoding injective: a decoder reads
 * exactly `lk`/`lv` bytes for the key/value, so `=` or `\n` occurring
 * *inside* a key or value can never be mistaken for a structural delimiter.
 * The old `key=value\n` form (format v1) collided — e.g.
 * `{a:"1\nb=2"}` and `{a:"1", b:"2"}` hashed identically; under v2 they do
 * not (proven in the cross-language vectors: `value-with-newline-collision-a`
 * vs `two-entries-no-collision`).
 *
 * @example
 * contentHash({ b: "2", a: "1" })
 * // sorts to ["a","b"], serializes to "1:a=1:1\n1:b=1:2\n", then SHA-256.
 */
export function contentHash(config: Record<string, string>): string {
  const sortedKeys = Object.keys(config).sort(codePointCompare);
  let serialized = '';
  for (const key of sortedKeys) {
    const value = config[key];
    if (hasLoneSurrogate(key)) throw new LoneSurrogateError('key', key);
    if (hasLoneSurrogate(value)) throw new LoneSurrogateError('value', value);
    serialized += `${utf8ByteLength(key)}:${key}=${utf8ByteLength(value)}:${value}\n`;
  }
  const hex = sha256Hex(serialized);
  return `sha256-${hex}`;
}

/**
 * Infers a project's env var prefix from its (kebab-case) name.
 *
 * Algorithm: uppercase the project name, replace every `-` **and** `.` with
 * `_`, prepend `"ADHD_"`. Both separators are folded so the result is always
 * a legal POSIX env-var name even for dotted project names (`"foo.bar"` →
 * `"ADHD_FOO_BAR"`, not the illegal `"ADHD_FOO.BAR"`); this matches
 * `inferEnvVar`, which already folds both. See SPEC.md §4.2.
 *
 * @example projectEnvPrefix("agent-mcp") // → "ADHD_AGENT_MCP"
 * @example projectEnvPrefix("decompile-cli") // → "ADHD_DECOMPILE_CLI"
 * @example projectEnvPrefix("foo.bar") // → "ADHD_FOO_BAR"
 */
export function projectEnvPrefix(projectName: string): string {
  return `ADHD_${projectName.toUpperCase().replace(/[.-]/g, '_')}`;
}

/**
 * Infers the effective env var name for a config field path, given a
 * project's (possibly overridden) prefix.
 *
 * Algorithm: uppercase `fieldPath`, replace every `.` and `-` with `_`,
 * prepend `` `${prefix}_` ``.
 *
 * A field's explicit `env:` override in the YAML replaces the inferred name
 * entirely (that substitution happens in `environment-builder`'s
 * `field-merge` step, not here — this function only computes the inferred
 * default).
 *
 * @example inferEnvVar("ADHD_AGENT_MCP", "db.path") // → "ADHD_AGENT_MCP_DB_PATH"
 * @example inferEnvVar("ADHD_AGENT_MCP", "provider-key.secret")
 *   // → "ADHD_AGENT_MCP_PROVIDER_KEY_SECRET"
 */
export function inferEnvVar(prefix: string, fieldPath: string): string {
  return `${prefix}_${fieldPath.toUpperCase().replace(/[.-]/g, '_')}`;
}

/**
 * Converts a flat map of dot-path field definitions into a nested JSON
 * Schema object describing the shape produced by resolving those fields.
 *
 * Each flat key is split on `.` and turned into nested `{ type: "object",
 * properties: { ... } }` levels; the terminal (leaf) segment receives a
 * JSON-Schema property built from the field definition's own JSON-Schema-
 * legal keywords (`type`, `default`, `description`, `minimum`, `maximum`,
 * `enum`, `pattern`, `minLength`, `maxLength`, `items`). adhd-specific
 * metadata keywords (`env`, `scope`, `secret`, `noEnv`) are NOT JSON Schema
 * validation keywords and are intentionally omitted from the generated
 * schema.
 *
 * @example
 * generateFieldSchema({ "server.port": { type: "integer", minimum: 1024 } })
 * // → {
 * //     type: "object",
 * //     properties: {
 * //       server: {
 * //         type: "object",
 * //         properties: { port: { type: "integer", minimum: 1024 } }
 * //       }
 * //     }
 * //   }
 */
export function generateFieldSchema(
  fields: Record<string, YamlFieldDefinition>,
): Record<string, unknown> {
  interface SchemaNode {
    type: 'object';
    properties: Record<string, unknown>;
    /** Index signature so a `SchemaNode` is itself a valid `Record<string, unknown>`
     *  (the function's declared return/property type). */
    [key: string]: unknown;
  }

  const root: SchemaNode = { type: 'object', properties: {} };

  for (const fieldPath of Object.keys(fields)) {
    const definition = fields[fieldPath];
    const segments = fieldPath.split('.');
    let node: SchemaNode = root;

    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        node.properties[segment] = fieldDefinitionToJsonSchema(definition);
        return;
      }
      const existing = node.properties[segment] as SchemaNode | undefined;
      if (existing === undefined) {
        const child: SchemaNode = { type: 'object', properties: {} };
        node.properties[segment] = child;
        node = child;
      } else {
        node = existing;
      }
    });
  }

  return root;
}

/** Converts a single `YamlFieldDefinition` into a JSON-Schema property,
 *  keeping only genuine JSON-Schema keywords (see `generateFieldSchema`). */
function fieldDefinitionToJsonSchema(
  def: YamlFieldDefinition,
): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: def.type };
  if (def.default !== undefined) schema.default = def.default;
  if (def.description !== undefined) schema.description = def.description;
  if (def.minimum !== undefined) schema.minimum = def.minimum;
  if (def.maximum !== undefined) schema.maximum = def.maximum;
  if (def.enum !== undefined) schema.enum = def.enum;
  if (def.pattern !== undefined) schema.pattern = def.pattern;
  if (def.minLength !== undefined) schema.minLength = def.minLength;
  if (def.maxLength !== undefined) schema.maxLength = def.maxLength;
  if (def.items !== undefined) schema.items = def.items;
  return schema;
}

// ============================================================================
// 13b. Secret references (credential redaction — see SPEC.md §7)
//
// A resolved snapshot must NEVER persist the plaintext value of a
// `secret: true` field. Instead it stores a *reference* — a reserved-prefix
// string carrying the env-var name the secret is read from — and the runtime
// client resolves the actual value from the process environment at read time
// (`Environment.get`). The reference form is a plain string (not an object)
// so it is representable both in the nested `config` (a JSON value) and in
// the flat `raw` map (whose values are strings in every port, including
// Rust's `BTreeMap<String, String>`).
// ============================================================================

/** Reserved prefix marking a redacted secret reference. A field value of
 *  `"adhd-secret-ref:ADHD_FOO_SECRET"` means "read the secret from the env
 *  var `ADHD_FOO_SECRET` at runtime". This prefix is reserved: a genuine
 *  config value must not begin with it. */
export const SECRET_REF_PREFIX = 'adhd-secret-ref:';

/** Builds the persisted reference for a secret field, given the env-var name
 *  its value is resolved from. */
export function makeSecretRef(envVarName: string): string {
  return `${SECRET_REF_PREFIX}${envVarName}`;
}

/** True if `value` is a secret reference string (see `SECRET_REF_PREFIX`). */
export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_REF_PREFIX);
}

/** Extracts the env-var name from a secret reference, or `undefined` if
 *  `value` is not a secret reference. */
export function secretRefEnvVar(value: unknown): string | undefined {
  return isSecretRef(value) ? (value as string).slice(SECRET_REF_PREFIX.length) : undefined;
}

/**
 * Resolves a secret reference against a supplied environment map, returning
 * the live secret value (or `undefined` if the env var is unset). Non-secret
 * values are returned unchanged. This is the read-time counterpart to
 * `makeSecretRef`; every runtime client (TS/Python/Rust) applies the
 * equivalent resolution in its `Environment.get`.
 */
export function resolveSecretRef(
  value: unknown,
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
): unknown {
  const envVar = secretRefEnvVar(value);
  if (envVar === undefined) return value;
  return env[envVar];
}

// ============================================================================
// 14. Internal — dependency-free SHA-256
//
// Not exported. Public surface of this package is exactly the types above +
// the four pure functions in section 13. Implements FIPS 180-4 SHA-256 from
// scratch (no Node built-ins, no npm dependency) so `contentHash()` works
// under this package's Vite library build (which externalizes `node:*` as
// unresolved browser stubs) and so the algorithm is portable to any JS
// runtime. See the file-header note above for verification methodology.
// ============================================================================

/** Round constants — first 32 bits of the fractional parts of the cube
 *  roots of the first 64 primes (FIPS 180-4 §4.2.2). */
const SHA256_ROUND_CONSTANTS: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** Initial hash values — first 32 bits of the fractional parts of the
 *  square roots of the first 8 primes (FIPS 180-4 §5.3.3). */
const SHA256_INITIAL_HASH: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rightRotate32(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/** Computes the raw 32-byte SHA-256 digest of a byte sequence. */
function sha256Digest(message: Uint8Array): Uint8Array {
  const h = Uint32Array.from(SHA256_INITIAL_HASH);

  // Padding: append 0x80, then zero bytes until length ≡ 56 (mod 64), then
  // an 8-byte big-endian bit-length (FIPS 180-4 §5.1.1).
  const messageLengthBits = message.length * 8;
  let paddedLength = message.length + 1;
  while (paddedLength % 64 !== 56) paddedLength++;
  paddedLength += 8;

  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

  // JS numbers are safe integers up to 2^53 — ample for any realistic
  // config string, so a 64-bit big-endian split via hi/lo 32-bit halves is
  // exact (no precision loss) for every input this function will ever see.
  const highBits = Math.floor(messageLengthBits / 0x100000000);
  const lowBits = messageLengthBits >>> 0;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, highBits, false);
  paddedView.setUint32(paddedLength - 4, lowBits, false);

  const messageSchedule = new Uint32Array(64);

  for (let chunkStart = 0; chunkStart < paddedLength; chunkStart += 64) {
    for (let i = 0; i < 16; i++) {
      messageSchedule[i] = paddedView.getUint32(chunkStart + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = messageSchedule[i - 15];
      const w2 = messageSchedule[i - 2];
      const sigma0 = rightRotate32(w15, 7) ^ rightRotate32(w15, 18) ^ (w15 >>> 3);
      const sigma1 = rightRotate32(w2, 17) ^ rightRotate32(w2, 19) ^ (w2 >>> 10);
      messageSchedule[i] =
        (messageSchedule[i - 16] + sigma0 + messageSchedule[i - 7] + sigma1) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const bigSigma1 = rightRotate32(e, 6) ^ rightRotate32(e, 11) ^ rightRotate32(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 =
        (hh + bigSigma1 + choice + SHA256_ROUND_CONSTANTS[i] + messageSchedule[i]) >>> 0;
      const bigSigma0 = rightRotate32(a, 2) ^ rightRotate32(a, 13) ^ rightRotate32(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let i = 0; i < 8; i++) digestView.setUint32(i * 4, h[i], false);
  return digest;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** SHA-256 of a UTF-8 string, returned as a lowercase hex digest. */
function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  return bytesToHex(sha256Digest(bytes));
}

// ============================================================================
// 15. Cross-language conformance-vector generator (see SPEC.md §4, §8)
//
// This is the SINGLE SOURCE OF TRUTH for `spec/cross-language-test-vectors.json`.
// The committed JSON file is *emitted* by `generateCrossLanguageVectors()`
// running the real primitives above — it is never hand-authored — so a
// pinned `expected` can never silently drift from the implementation that
// produced it (that drift is exactly what let ENV-CORE-001/002/003 ship
// green against a pure vector-replay suite). The Python and Rust suites load
// the emitted file and assert their ports reproduce every vector, including
// the adversarial cases below. Regenerate with
// `packages/environment/environment-base-spec` build + the emit script noted
// in SPEC.md §8; a drift guard in `environment-builder`'s test suite asserts
// the committed file deep-equals a fresh generation.
// ============================================================================

/** A single primitive vector. `expected` is present for success cases;
 *  `error` (the thrown error's `name`) is present for specified failure
 *  cases (e.g. lone-surrogate rejection). */
export interface CrossLanguageVector {
  name: string;
  description?: string;
  /** Normal case: the input as a JSON value. Omitted for inputs that cannot
   *  be portably serialized as JSON (see `inputKeyCodeUnits`). */
  input?: unknown;
  /** Error case only: a `contentHash` key expressed as raw UTF-16 code units
   *  (integers). Used for inputs containing a lone surrogate, which cannot be
   *  represented as a literal JSON string that every language's parser
   *  accepts (`serde_json` rejects a `\uD800` escape outright). Consumers
   *  reconstruct the key in-language; Rust cannot build a lone-surrogate
   *  `String` and skips these, as documented. Paired with `inputValue`. */
  inputKeyCodeUnits?: number[];
  /** Error case only: the value paired with `inputKeyCodeUnits`. */
  inputValue?: string;
  expected?: unknown;
  error?: string;
}

export interface CrossLanguageVectors {
  $schema: string;
  specVersion: string;
  contentHashFormatVersion: number;
  description: string;
  contentHash: CrossLanguageVector[];
  projectEnvPrefix: CrossLanguageVector[];
  inferEnvVar: CrossLanguageVector[];
  generateFieldSchema: CrossLanguageVector[];
}

/** Runs `contentHash`, capturing either the digest or the thrown error name,
 *  so error-case vectors are generated from the real behaviour rather than
 *  asserted by hand. */
function contentHashVector(
  name: string,
  input: Record<string, string>,
  description?: string,
): CrossLanguageVector {
  try {
    return { name, ...(description ? { description } : {}), input, expected: contentHash(input) };
  } catch (err) {
    return {
      name,
      ...(description ? { description } : {}),
      input,
      error: err instanceof Error ? err.name : String(err),
    };
  }
}

/**
 * Emits the full, authoritative set of cross-language conformance vectors by
 * running the real primitive implementations in this module. The returned
 * object is what gets written to `spec/cross-language-test-vectors.json`.
 */
export function generateCrossLanguageVectors(): CrossLanguageVectors {
  const contentHashVectors: CrossLanguageVector[] = [
    contentHashVector(
      'spec-example-unsorted-input',
      { b: '2', a: '1' },
      'Canonical example given out of sorted order — proves the function sorts before hashing.',
    ),
    contentHashVector(
      'spec-example-pre-sorted-input',
      { a: '1', b: '2' },
      'Same pairs pre-sorted — must equal spec-example-unsorted-input.',
    ),
    contentHashVector('empty-object', {}, 'Zero entries serialize to the empty string.'),
    contentHashVector('single-entry', { only: 'value' }),
    contentHashVector('three-entries-unsorted', { zeta: '26', alpha: '1', mid: '13' }),
    contentHashVector(
      'astral-plane-key-ordering',
      { '\u{1F600}': 'astral', '￿': 'bmp' },
      'ENV-CORE-002: a BMP key (U+FFFF) and an astral key (U+1F600) — canonical code-point order sorts U+FFFF BEFORE U+1F600. UTF-16 code-unit order (old TS `.sort()`) would place the astral key first (lead surrogate 0xD83D < 0xFFFF) and produce a different digest.',
    ),
    contentHashVector(
      'value-with-newline-collision-a',
      { a: '1\nb=2' },
      'ENV-CORE-004: under the old `key=value\\n` form this collided with two-entries-no-collision; the v2 length-prefixed form makes them distinct.',
    ),
    contentHashVector(
      'two-entries-no-collision',
      { a: '1', b: '2' },
      'ENV-CORE-004: must NOT equal value-with-newline-collision-a under the injective v2 encoding.',
    ),
    contentHashVector(
      'value-with-equals-and-newline',
      { key: 'a=b\nc=d', 'x=y': 'z' },
      'ENV-CORE-004: `=` and `\\n` inside both a value and a key — injectivity relies on the byte-length prefixes, not on these being separator-free.',
    ),
    contentHashVector(
      'dotted-keys',
      { 'providers.openai.secret': 'x', 'db.path': '/tmp/db' },
      'Flat dot-path keys (the real shape of `raw`).',
    ),
    contentHashVector(
      'unicode-values',
      { sharp: 'straße', micro: 'µ', turkish: 'İ' },
      'Multi-byte UTF-8 values — byte-length prefixes count UTF-8 bytes, not code points.',
    ),
    (() => {
      // ENV-CORE-005: a lone high surrogate as a key must be REJECTED with
      // LoneSurrogateError. Represented via code units (not a literal JSON
      // string) so the emitted file stays parseable by serde_json — see
      // `inputKeyCodeUnits`.
      const key = String.fromCharCode(0xd800);
      let error = '';
      try {
        contentHash({ [key]: 'x' });
      } catch (err) {
        error = err instanceof Error ? err.name : String(err);
      }
      return {
        name: 'lone-surrogate-key-rejected',
        description:
          'ENV-CORE-005: a lone high surrogate (U+D800) as a key must be REJECTED with LoneSurrogateError in TS and Python. Unreachable in Rust — a String cannot hold a lone surrogate — so the Rust suite skips it. Input given as UTF-16 code units because a literal lone surrogate is not portably JSON-serializable.',
        inputKeyCodeUnits: [0xd800],
        inputValue: 'x',
        error,
      } as CrossLanguageVector;
    })(),
  ];

  const projectEnvPrefixVectors: CrossLanguageVector[] = [
    { name: 'agent-mcp', input: 'agent-mcp', expected: projectEnvPrefix('agent-mcp') },
    { name: 'decompile-cli', input: 'decompile-cli', expected: projectEnvPrefix('decompile-cli') },
    {
      name: 'dotted-project-name',
      description:
        'ENV-CORE-003: a dotted project name folds `.`→`_` (like `-`), yielding a legal POSIX env-var prefix. Old TS/Python folded only `-` and emitted the illegal `ADHD_FOO.BAR`.',
      input: 'foo.bar',
      expected: projectEnvPrefix('foo.bar'),
    },
    {
      name: 'unicode-case-folding',
      description:
        'Unicode default case mapping under uppercasing (ß→SS, µ→Μ) must agree across TS toUpperCase / Python str.upper / Rust to_uppercase.',
      input: 'faß-µ',
      expected: projectEnvPrefix('faß-µ'),
    },
  ];

  const inferEnvVarVectors: CrossLanguageVector[] = [
    {
      name: 'dotted-path',
      input: { prefix: 'ADHD_AGENT_MCP', fieldPath: 'db.path' },
      expected: inferEnvVar('ADHD_AGENT_MCP', 'db.path'),
    },
    {
      name: 'dashed-and-dotted-path',
      input: { prefix: 'ADHD_AGENT_MCP', fieldPath: 'provider-key.secret' },
      expected: inferEnvVar('ADHD_AGENT_MCP', 'provider-key.secret'),
    },
    {
      name: 'deep-nested-path',
      input: { prefix: 'ADHD_AGENT_MCP', fieldPath: 'transport.port' },
      expected: inferEnvVar('ADHD_AGENT_MCP', 'transport.port'),
    },
  ];

  const generateFieldSchemaVectors: CrossLanguageVector[] = [
    {
      name: 'single-nested-field',
      input: { 'server.port': { type: 'integer', minimum: 1024 } },
      expected: generateFieldSchema({ 'server.port': { type: 'integer', minimum: 1024 } }),
    },
    {
      name: 'multiple-fields-shared-and-deep-parents',
      input: {
        'db.path': { type: 'string', default: './data.sqlite' },
        'db.pool.size': { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        'logging.level': { type: 'string', enum: ['debug', 'info', 'warn', 'error'], default: 'info' },
      },
      expected: generateFieldSchema({
        'db.path': { type: 'string', default: './data.sqlite' },
        'db.pool.size': { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        'logging.level': { type: 'string', enum: ['debug', 'info', 'warn', 'error'], default: 'info' },
      }),
    },
    { name: 'empty-fields', input: {}, expected: generateFieldSchema({}) },
    {
      name: 'adhd-metadata-stripped-from-leaf',
      description:
        'ENV-CORE-001 (security): adhd-specific keys (env, scope, secret, noEnv) MUST be dropped from the generated schema — Python/Rust previously copied the leaf verbatim, leaking which fields are secrets and their env-var names.',
      input: {
        'providers.openai.secret': {
          type: 'string',
          default: 'x',
          description: 'API key',
          minLength: 1,
          env: 'CUSTOM_OPENAI_KEY',
          scope: 'global',
          secret: true,
          noEnv: true,
        },
      },
      expected: generateFieldSchema({
        'providers.openai.secret': {
          type: 'string',
          default: 'x',
          description: 'API key',
          minLength: 1,
          env: 'CUSTOM_OPENAI_KEY',
          scope: 'global',
          secret: true,
          noEnv: true,
        } as YamlFieldDefinition,
      }),
    },
  ];

  return {
    $schema: 'https://adhd.dev/schemas/environment/cross-language-test-vectors.schema.json',
    specVersion: SPEC_VERSION,
    contentHashFormatVersion: CONTENT_HASH_FORMAT_VERSION,
    description:
      'Pinned cross-language conformance vectors for the pure primitives exported by @adhd/environment-base-spec (contentHash, projectEnvPrefix, inferEnvVar, generateFieldSchema). GENERATED by generateCrossLanguageVectors() in src/index.ts — do not hand-edit; regenerate (see SPEC.md §8). The TypeScript, Python, and Rust runtime clients MUST reproduce every "expected" value from the corresponding "input". A vector with "error" instead of "expected" is a specified FAILURE case: the port must raise the named error (Rust may legitimately be unable to construct the input — e.g. a lone surrogate — and skips only those). Comparison semantics: contentHash/projectEnvPrefix/inferEnvVar expected values are exact strings; generateFieldSchema expected values compare by structural (deep) equality — key insertion order is not significant.',
    contentHash: contentHashVectors,
    projectEnvPrefix: projectEnvPrefixVectors,
    inferEnvVar: inferEnvVarVectors,
    generateFieldSchema: generateFieldSchemaVectors,
  };
}
