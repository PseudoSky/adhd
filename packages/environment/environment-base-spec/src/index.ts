/**
 * @adhd/environment-base-spec
 *
 * The canonical contract for the `@adhd/environment` package family
 * (`environment-builder`, `environment-core-node`). This package has ZERO
 * internal dependencies and is the root of the dependency graph — every
 * other `environment-*` package imports its shared types and pure
 * primitives from here.
 *
 * This is the ZERO-CONFIG REDESIGN contract — see
 * `packages/environment/ARCHITECTURE.md` (the authoritative work order this
 * module implements). It supersedes the prior snapshot-reader / YAML-spec
 * contract: `Environment` now resolves its whole cascade live, in memory,
 * at construction time, from a code-defined `EnvironmentSpec`. Defaults
 * always apply because the spec lives in code — a downstream consumer never
 * has to write a file or export a var just to make things run. Files and
 * env vars are purely optional overrides that layer on top (§2 of
 * ARCHITECTURE.md), exactly the way Claude Code's own settings cascade
 * layers `~/.claude/…` → `.claude/…` → `.claude/*.local` over built-in
 * defaults.
 *
 * Per ARCHITECTURE.md §4 this package's public surface is now Node-only
 * (no cross-language Python/Rust obligation): `generateCrossLanguageVectors`
 * / `CrossLanguageVectors` and the dotted `DirectoryType` union have been
 * removed. The four pure primitives that were cross-language-pinned
 * (`contentHash`, `projectEnvPrefix`, `inferEnvVar`, `generateFieldSchema`)
 * are KEPT — they are still useful, deterministic, dependency-free
 * primitives for this package's own (now TS-only) callers — but this
 * package no longer promises byte-identical behavior with any other
 * language runtime, and the pinned vector file is no longer a build gate.
 *
 * NOTE ON HASHING: `contentHash`/`structureHash` use a small hand-rolled,
 * dependency-free SHA-256 implementation (section 8 below) rather than
 * `node:crypto`. This package's Vite library build target externalizes Node
 * builtins as browser stubs (the generator-scaffolded `vite.config.ts` has
 * no `rollupOptions.external` entry for `node:*`), so
 * `import { createHash } from 'node:crypto'` fails at bundle time. A
 * pure-JS implementation sidesteps that entirely, and also more strongly
 * satisfies this package's "zero runtime dependencies" invariant: it needs
 * no Node built-in and is portable to any JS runtime (browser, edge, Node).
 */

// ============================================================================
// 1. Constants
// ============================================================================

/** Contract semver. Bump when the public shape changes. */
export const SPEC_VERSION = '1.0.0-redesign.1';

/** Default org-level directory segment in the data root (see `orgNamespace`). */
export const DEFAULT_ORG_NAMESPACE = 'adhd';

/** Default namespace segment when `EnvironmentSpec.namespaces` is absent. */
export const DEFAULT_NAMESPACE = 'default';

/** Filename of the optional written snapshot inside its resolved directory
 *  (`Environment#write()`). Never a read prerequisite — see ARCHITECTURE.md §2.1. */
export const SNAPSHOT_FILENAME = 'adhd-environment.json';

/** Filename of a scope-layer's config override file (project/global/system). */
export const CONFIG_FILENAME = 'config.yaml';

/** Filename of the project-local override file — the most specific,
 *  highest-priority file layer (`ARCHITECTURE.md` §2.2), analogous to
 *  Claude Code's `.claude/settings.local.json`. Conventionally gitignored. */
export const LOCAL_CONFIG_FILENAME = 'config.local.yaml';

// ============================================================================
// 2. Shared scalar / union types
// ============================================================================

/** Three-tier scope for directory roots and (optionally) individual fields.
 *  `project` root lives at `<projectRoot>/.adhd/…`; `global` at `~/.adhd/…`;
 *  `system` at the OS application-support directory. See ARCHITECTURE.md §2.4. */
export type Scope = 'system' | 'global' | 'project';

/** JSON-Schema-derived value type a config field may hold. */
export type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'array';

/** Directory catalog entry kind — determines the default multi-instance
 *  `Share` policy (see `DEFAULT_SHARE_BY_KIND` and ARCHITECTURE.md §5). */
export type DirKind = 'data' | 'logs' | 'cache' | 'state' | 'run' | 'temp' | 'config';

/** Multi-instance collision policy for a directory or file.
 *  - `shared` — same physical path across every instance of this process.
 *  - `per-instance` — path suffixed with `env.instanceId`; never collides.
 *  - `singleton` — same physical path as `shared`, but the *consumer*
 *    enforces one writer via `Environment#lock()`.
 *  See ARCHITECTURE.md §5. */
export type Share = 'shared' | 'per-instance' | 'singleton';

/** Default `Share` policy per `DirKind`, per ARCHITECTURE.md §5:
 *  `logs`/`temp` default to `per-instance` (never collide); everything else
 *  (`data`/`cache`/`state`/`config`/`run`) defaults to `shared`. A `DirSpec`
 *  may always override this with an explicit `share`. */
export const DEFAULT_SHARE_BY_KIND: Readonly<Record<DirKind, Share>> = {
  data: 'shared',
  cache: 'shared',
  state: 'shared',
  config: 'shared',
  run: 'shared',
  logs: 'per-instance',
  temp: 'per-instance',
};

/** The origin of a resolved config field's value, recorded per-field in
 *  `SnapshotData.provenance`. Mirrors the cascade layers of ARCHITECTURE.md
 *  §2.2 (`code defaults → system → global → project → local → env vars`),
 *  named identically to the layer they came from — `'default'` is the
 *  spec-code fallback (`FieldSpec.default`), `'env'` covers both a
 *  live-resolved env var AND an `at:'runtime'`/`secret:true` field (whose
 *  value is *always* env-sourced at read time, regardless of whether the
 *  var happens to be set at snapshot-build time). */
export type ProvenanceSource = 'default' | 'system' | 'global' | 'project' | 'local' | 'env';

// ============================================================================
// 3. Public spec contract (EnvironmentSpec<T> — ARCHITECTURE.md §3.1)
// ============================================================================

/** A single config field definition, keyed by its dot-path in
 *  `EnvironmentSpec.config` (e.g. `"transport.port"`). */
export interface FieldSpec {
  /** JSON-Schema type keyword. */
  type: FieldType;
  /** Fallback value used when no file layer or env var supplies one. */
  default?: unknown;
  /** `'build'` (default) — the value is resolved once at construction and
   *  never changes for the life of the `Environment` instance.
   *  `'runtime'` — the value is re-read from the live process environment
   *  on every access (an "env-ref" — see `makeEnvRef`/`resolveEnvRef`
   *  below), falling back to the cascade-resolved value only when the env
   *  var is unset at access time. */
  at?: 'build' | 'runtime';
  /** Explicit env var name. When absent, inferred from the project's env
   *  prefix + this field's dot-path via `inferEnvVar`. */
  env?: string;
  /** Optional scope annotation (provenance/documentation only — does not
   *  gate which file layers may set this field; every layer may set every
   *  field, per the cascade). */
  scope?: Scope;
  /** When `true`, this field is NEVER logged and is always treated as
   *  `at:'runtime'` (its resolved value is only ever read live from the
   *  env var at access time — never baked into a written snapshot). */
  secret?: boolean;
  /** Human-readable description (also emitted into the generated JSON Schema). */
  description?: string;
  // JSON-Schema validation keywords — all optional, passed through verbatim
  // to the generated `fieldSchema`.
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
}

/** A declared directory. Keyed by name in `EnvironmentSpec.dirs` (e.g.
 *  `dirs: { data: { kind: 'data' } }` → `env.paths.data`). */
export interface DirSpec {
  /** Determines the default `Share` policy (see `DEFAULT_SHARE_BY_KIND`). */
  kind: DirKind;
  /** Overrides the kind's default multi-instance policy. */
  share?: Share;
  /** Overrides the active scope for just this directory's root. */
  scope?: Scope;
  /** Explicit absolute-path override. Supports `${HOME}`/`$HOME`,
   *  `${PROJECT_ROOT}`, and `${NAMESPACE}` interpolation. When absent, the
   *  path is auto-derived from the (possibly overridden) scope's root. */
  path?: string;
}

/** A declared file living inside one of `EnvironmentSpec.dirs`. Keyed by
 *  name in `EnvironmentSpec.files` (e.g. `files: { db: { in: 'data', name: 'app.sqlite' } }`
 *  → `env.files.db`). */
export interface FileSpec {
  /** The `dirs` key this file resolves inside. */
  in: string;
  /** The file's base name (joined onto the resolved directory path). */
  name: string;
  /** Multi-instance policy metadata (descriptive; physical placement is
   *  inherited from the directory named by `in`). Defaults to `'shared'` —
   *  matching ARCHITECTURE.md §5's guidance that SQLite DBs are shared and
   *  opened WAL + `busy_timeout` for safe concurrent access. */
  share?: Share;
}

/** The full, code-defined specification passed to `new Environment(project, spec, options?)`.
 *  `T` is the shape of the *resolved, nested* config object (`env.config`). */
export interface EnvironmentSpec<T = Record<string, unknown>> {
  /** Organization namespace segment. Defaults to `"adhd"`. */
  orgNamespace?: string;
  /** Explicit env var prefix. When absent, inferred from the project name
   *  via `projectEnvPrefix` (e.g. `"agent-mcp"` → `"ADHD_AGENT_MCP"`). */
  envPrefixOverride?: string;
  /** Declared namespaces. Absent ⇒ `["default"]`. */
  namespaces?: string[];
  /** Directory catalog, keyed by name. */
  dirs?: Record<string, DirSpec>;
  /** File catalog, keyed by name. */
  files?: Record<string, FileSpec>;
  /** Config field definitions, keyed by dot-path (e.g. `"transport.port"`). */
  config: Record<string, FieldSpec>;
  /** Phantom marker — never read at runtime, used only so `T` participates
   *  in this interface's structural type for inference ergonomics. */
  readonly __configShape?: T;
}

/** Options accepted by the `Environment` constructor. Every field optional —
 *  the whole point of zero-config. */
export interface EnvironmentOptions {
  /** Forces the active scope, bypassing auto-detection (ARCHITECTURE.md §2.3 step 1). */
  scope?: Scope;
  /** Selects a declared namespace. Defaults to the spec's first declared
   *  namespace (or `"default"` when `namespaces` is absent). */
  namespace?: string;
  /** Overrides the base directory that would otherwise be
   *  `os.homedir()/.{orgNamespace}` (the `global`-scope root) AND the
   *  system-scope app-support base — primarily for test isolation. */
  adhdRoot?: string;
  /** Working directory used for project-marker auto-detection
   *  (`.git`/`.adhd`/`adhd.environment.yaml`) and `${PROJECT_ROOT}`
   *  interpolation. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Explicit instance id override. When absent, a fresh id
   *  (`pid + short random`) is generated per constructed instance. */
  instanceId?: string;
}

// ============================================================================
// 4. Resolved shapes (what a built snapshot/live-resolve looks like)
// ============================================================================

/** A resolved directory catalog entry — `DirSpec` after path resolution. */
export interface ResolvedDirEntry {
  /** The `dirs` record key this entry was declared under. */
  name: string;
  kind: DirKind;
  /** Fully expanded, absolute path. */
  path: string;
  scope: Scope;
  share: Share;
}

/** A resolved file catalog entry — `FileSpec` after path resolution. */
export interface ResolvedFileEntry {
  /** The `files` record key this entry was declared under. */
  name: string;
  /** The `dirs` key this file resolves inside. */
  in: string;
  /** Fully expanded, absolute path. */
  path: string;
  share: Share;
}

/** Per-field resolution metadata recorded in `SnapshotData.provenance`. */
export interface ProvenanceEntry {
  source: ProvenanceSource;
  scope: Scope;
  /** The env var name consulted, when `source === 'env'`. */
  env?: string;
}

/** Metadata needed to install a live, per-access re-reading getter for a
 *  `secret`/`at:'runtime'` field (`SnapshotData.liveFields`,
 *  ARCHITECTURE.md §3.1 `FieldSpec.at`/§7.5 runtime-vs-build proof). The
 *  `Environment` runtime client (both the live-constructed path AND
 *  `fromSnapshot`) reads this to know, for every env-ref leaf found in
 *  `config`, which live env var to re-check on each access and what to fall
 *  back to when that var is unset. */
export interface LiveFieldMeta {
  /** The env var name this field re-reads on every access. */
  env: string;
  type: FieldType;
  /** The value to use when the live env var is unset — the cascade result
   *  of just the file layers + spec default. SECURITY: for a `secret: true`
   *  field this is ALWAYS `undefined`, never the field's (possibly
   *  plaintext) `default`/file value — `SnapshotData` is a `.write()`-able,
   *  on-disk artifact, and a secret must never round-trip through it even
   *  as a "fallback". Only a non-secret `at: 'runtime'` field carries a
   *  real fallback here. */
  fallback: unknown;
}

/** The full resolved snapshot shape — computed live at `Environment`
 *  construction, and what `Environment#write()` optionally persists to disk
 *  (never a read prerequisite — ARCHITECTURE.md §2.1). */
export interface SnapshotData<T = Record<string, unknown>> {
  /** Snapshot format version (this package's `SPEC_VERSION`). */
  version: string;
  /** Library version that produced this snapshot. */
  libraryVersion: string;
  /** ISO timestamp of when this snapshot was resolved. */
  generatedAt: string;
  project: string;
  namespace: string;
  orgNamespace: string;
  envPrefix: string;
  scope: Scope;
  instanceId: string;
  /** Fully resolved, nested config object. A `secret`/`at:'runtime'` leaf
   *  holds an env-ref sentinel string (`makeEnvRef`) here — `Environment`
   *  replaces every such leaf with a live getter at construction/load time
   *  (see `liveFields`); a caller reading `SnapshotData.config` directly
   *  (e.g. from a raw `.write()`d JSON file) sees the sentinel, never a
   *  plaintext secret. */
  config: T;
  /** Flat, un-nested config (dot.path → value) for hashing + lookup. Same
   *  env-ref convention as `config`. */
  raw: Record<string, unknown>;
  /** Flat dot-path field name → live-getter metadata, for every field with
   *  `secret: true` or `at: 'runtime'`. */
  liveFields: Record<string, LiveFieldMeta>;
  /** Generated JSON Schema for validation of `config`. */
  fieldSchema: object | null;
  /** SHA-256 config content hash ("sha256-" + hex). */
  configHash: string;
  /** SHA-256 directory structure hash. */
  structureHash: string;
  dirs: ResolvedDirEntry[];
  files: ResolvedFileEntry[];
  /** Provenance map: flat field dot-path → provenance entry. */
  provenance: Record<string, ProvenanceEntry>;
}

// ============================================================================
// 5. Deep-path type extraction (utility types)
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
// 6. Pure primitives
// ============================================================================

/** Content-hash serialization format version. Bumped from the original
 *  (unversioned) `key=value\n` form to `v2` when the length-prefixed,
 *  injective encoding was adopted. */
export const CONTENT_HASH_FORMAT_VERSION = 2;

/**
 * Raised by `contentHash` when a key or value contains a lone surrogate
 * code unit (an unpaired UTF-16 surrogate, U+D800–U+DFFF). Such strings are
 * not well-formed Unicode and have no canonical UTF-8 encoding.
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
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Ordinal comparison by Unicode code point (NOT UTF-16 code unit) — see
 *  `contentHash`'s doc comment for why this matters. */
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

/** UTF-8 byte length of a (well-formed) string. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * `sha256-` hash of a flat config record, using a length-prefixed,
 * **injective** serialization (format `v2`).
 *
 * Algorithm:
 *   1. Reject any key or value containing a lone surrogate (`LoneSurrogateError`).
 *   2. Sort `Object.keys(config)` ascending by **Unicode code point**.
 *   3. For each key `k` in that order, let `lk`/`lv` be the UTF-8 byte
 *      lengths of `k` and `config[k]`, and emit `` `${lk}:${k}=${lv}:${config[k]}\n` ``.
 *   4. Concatenate all lines. SHA-256 the resulting UTF-8 string; hex-encode;
 *      prefix `"sha256-"`.
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
 * `sha256-` hash of a resolved directory catalog — a stable fingerprint of
 * the declared `dirs`' identity (`name`/`kind`/`scope`), independent of the
 * (host-specific) absolute `path` values. Used to detect structural drift
 * between two resolutions of the same spec.
 *
 * @example
 * structureHash([{ name: 'data', kind: 'data', scope: 'project' }])
 */
export function structureHash(entries: Array<{ name: string; kind: string; scope: string }>): string {
  const sorted = [...entries].sort((a, b) => codePointCompare(a.name, b.name));
  const serialized = sorted.map((e) => `${e.name}:${e.kind}:${e.scope}`).join('\n');
  return `sha256-${sha256Hex(serialized)}`;
}

/**
 * Infers a project's env var prefix from its (kebab-case) name.
 *
 * Algorithm: uppercase the project name, replace every `-` **and** `.` with
 * `_`, prepend `"ADHD_"`.
 *
 * @example projectEnvPrefix("agent-mcp") // → "ADHD_AGENT_MCP"
 */
export function projectEnvPrefix(projectName: string): string {
  return `ADHD_${projectName.toUpperCase().replace(/[.-]/g, '_')}`;
}

/**
 * Infers the effective env var name for a config field path, given a
 * project's (possibly overridden) prefix.
 *
 * @example inferEnvVar("ADHD_AGENT_MCP", "db.path") // → "ADHD_AGENT_MCP_DB_PATH"
 */
export function inferEnvVar(prefix: string, fieldPath: string): string {
  return `${prefix}_${fieldPath.toUpperCase().replace(/[.-]/g, '_')}`;
}

/** The subset of `FieldSpec` that is relevant to JSON-Schema generation. */
interface SchemaCompatibleField {
  type: string;
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: { type: string };
  /** Read only to decide whether `default` is safe to copy into the
   *  generated schema (see `fieldDefinitionToJsonSchema`) — never itself
   *  copied into the output. */
  secret?: boolean;
}

interface SchemaObjectNode {
  type: 'object';
  properties: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Converts a flat map of dot-path field definitions into a nested JSON
 * Schema object describing the shape produced by resolving those fields.
 * adhd-specific metadata keywords (`env`, `scope`, `secret`, `at`) are NOT
 * JSON Schema validation keywords and are intentionally omitted.
 *
 * @example
 * generateFieldSchema({ "server.port": { type: "integer", minimum: 1024 } })
 * // → { type: "object", properties: { server: { type: "object",
 * //      properties: { port: { type: "integer", minimum: 1024 } } } } }
 */
export function generateFieldSchema(
  fields: Record<string, FieldSpec> | Record<string, SchemaCompatibleField>,
): Record<string, unknown> {
  const root: SchemaObjectNode = { type: 'object', properties: {} };
  const typedFields = fields as Record<string, SchemaCompatibleField>;

  for (const fieldPath of Object.keys(typedFields)) {
    const definition = typedFields[fieldPath];
    const segments = fieldPath.split('.');
    let node: SchemaObjectNode = root;

    segments.forEach((segment, index) => {
      const isLeaf = index === segments.length - 1;
      if (isLeaf) {
        node.properties[segment] = fieldDefinitionToJsonSchema(definition);
        return;
      }
      const existing = node.properties[segment] as SchemaObjectNode | undefined;
      if (existing === undefined) {
        const child: SchemaObjectNode = { type: 'object', properties: {} };
        node.properties[segment] = child;
        node = child;
      } else {
        node = existing;
      }
    });
  }

  return root;
}

/** Converts a single field definition into a JSON-Schema leaf property,
 *  keeping only genuine JSON-Schema keywords (see `generateFieldSchema`).
 *  SECURITY: a `secret: true` field's `default` is NEVER copied into the
 *  generated schema — the schema is a shareable/loggable artifact (it is
 *  emitted into `SnapshotData.fieldSchema`, which `Environment#write()` may
 *  persist to disk), and a plaintext credential placed in `FieldSpec.default`
 *  must never leak through it. */
function fieldDefinitionToJsonSchema(def: SchemaCompatibleField): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: def.type };
  if (def.default !== undefined && def.secret !== true) schema.default = def.default;
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
// 7. Env-ref (runtime-resolved value reference) helpers
//
// A resolved snapshot must NEVER persist the plaintext value of a
// `secret: true` (or `at: 'runtime'`) field. Instead it stores a
// *reference* — a reserved-prefix string carrying the env-var name the
// value is read from — and the runtime client (`Environment`) resolves the
// actual value from the process environment at read time, live, on every
// access. See ARCHITECTURE.md §3.1 `FieldSpec.at`/`FieldSpec.secret`.
// ============================================================================

/** Reserved prefix marking a runtime-resolved env-var reference. A field
 *  value of `"adhd-env-ref:ADHD_FOO_SECRET"` means "read the live value
 *  from the env var `ADHD_FOO_SECRET` at access time". This prefix is
 *  reserved: a genuine config value must not begin with it. */
export const ENV_REF_PREFIX = 'adhd-env-ref:';

/** Builds the persisted reference for a runtime-resolved field, given the
 *  env-var name its value is resolved from. */
export function makeEnvRef(envVarName: string): string {
  return `${ENV_REF_PREFIX}${envVarName}`;
}

/** True if `value` is an env-var reference string (starts with `ENV_REF_PREFIX`). */
export function isEnvRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENV_REF_PREFIX);
}

/** Extracts the env-var name from an env-var reference, or `undefined` if
 *  `value` is not a reference. */
export function envRefVarName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith(ENV_REF_PREFIX)) return undefined;
  return value.slice(ENV_REF_PREFIX.length);
}

/**
 * Resolves an env-var reference against a supplied environment map,
 * returning the live value (or `undefined` if the env var is unset).
 * Non-reference values are returned unchanged. This is the read-time
 * counterpart to `makeEnvRef` — `Environment`'s live getters apply this
 * resolution on every access of a `secret`/`at:'runtime'` field.
 */
export function resolveEnvRef(
  value: unknown,
  env: Record<string, string | undefined> = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env ?? {},
): unknown {
  const envVar = envRefVarName(value);
  if (envVar === undefined) return value;
  return env[envVar];
}

// ============================================================================
// 8. Internal — dependency-free SHA-256
//
// Not exported. Implements FIPS 180-4 SHA-256 from scratch (no Node
// built-ins, no npm dependency) so `contentHash()`/`structureHash()` work
// under this package's Vite library build (which externalizes `node:*` as
// unresolved browser stubs) and so the algorithm is portable to any JS
// runtime.
// ============================================================================

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

  const messageLengthBits = message.length * 8;
  let paddedLength = message.length + 1;
  while (paddedLength % 64 !== 56) paddedLength++;
  paddedLength += 8;

  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;

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
