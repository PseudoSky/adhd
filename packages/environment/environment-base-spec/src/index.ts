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

/**
 * `sha256-` hash of a flat config record, computed as SHA-256 over its
 * entries sorted lexicographically by key and serialized one per line as
 * `key=value\n` (each line — including the last — terminated with `\n`).
 *
 * This is the cross-language content-addressing primitive: TS, Python, and
 * Rust MUST all produce the identical hex digest for the identical input.
 *
 * Algorithm (canonical, per `contexts/_shared.md` `[def:contentHash]`):
 *   1. Take `Object.keys(config)`, sort ascending (code-point order).
 *   2. For each key `k` in that order, emit the line `` `${k}=${config[k]}\n` ``.
 *   3. Concatenate all lines (no additional separator — each line already
 *      carries its own trailing `\n`).
 *   4. SHA-256 the resulting UTF-8 string; hex-encode the digest.
 *   5. Prefix with `"sha256-"`.
 *
 * @example
 * contentHash({ b: "2", a: "1" })
 * // → "sha256-4a73850fde34aad40ff8649b93a66523a5fe744357a3931caea0f10609d0d930"
 * // (sorted serialization is "a=1\nb=2\n")
 */
export function contentHash(config: Record<string, string>): string {
  const sortedKeys = Object.keys(config).sort();
  let serialized = '';
  for (const key of sortedKeys) {
    serialized += `${key}=${config[key]}\n`;
  }
  const hex = sha256Hex(serialized);
  return `sha256-${hex}`;
}

/**
 * Infers a project's env var prefix from its (kebab-case) name.
 *
 * Algorithm: uppercase the project name, replace every `-` with `_`,
 * prepend `"ADHD_"`.
 *
 * @example projectEnvPrefix("agent-mcp") // → "ADHD_AGENT_MCP"
 * @example projectEnvPrefix("decompile-cli") // → "ADHD_DECOMPILE_CLI"
 */
export function projectEnvPrefix(projectName: string): string {
  return `ADHD_${projectName.toUpperCase().replace(/-/g, '_')}`;
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
