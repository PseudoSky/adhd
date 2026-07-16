/**
 * `environment.ts` — the TypeScript (`@adhd/environment`) runtime client.
 *
 * Thin runtime client (`[inv:thin-runtime]`): reads a pre-built
 * `adhd-environment.json` snapshot from disk and exposes typed accessors for
 * config values, resolved directory paths, recorded env vars, and field
 * provenance. It performs **no** builder logic: no YAML parsing, no field
 * merging, no fieldSchema generation, no validation, no directory creation,
 * and no `.env` file loading. The snapshot is produced by the (TypeScript)
 * `@adhd/environment-builder` pipeline; this module only ever reads it.
 *
 * Mirrors the Python (`environment-core-py/src/adhd_environment/environment.py`)
 * and Rust (`environment-core-rs/src/lib.rs`) runtime clients field-for-field
 * and behavior-for-behavior, per `docs/plan/adhd-environment/interfaces-architect.md`
 * §4.2 (authoritative interface contract for this package).
 *
 * NOTE on cross-package imports: as with `@adhd/environment-builder` (see the
 * header note in its `config-resolver.ts`), only **types** are imported from
 * `@adhd/environment-base-spec` at runtime — the handful of small pure
 * primitives/constants this module needs from that contract are duplicated
 * locally (matching the Python/Rust ports, which have no base-spec
 * counterpart to import from at all) so this package resolves identically
 * whether loaded via the Nx/Vite path-aliased workspace build or a bare
 * `node -e require(...)` of the published `dist` package (no workspace
 * `node_modules/@adhd/*` symlinks exist for the latter).
 */

import { homedir } from 'node:os';
import { readFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type {
  ConfigScope,
  DeepPath,
  EnvironmentParams,
  ProvenanceEntry,
  ResolvedDirectoryEntry,
  SnapshotData,
} from '@adhd/environment-base-spec';

// ============================================================================
// Constants — duplicated from `@adhd/environment-base-spec` (see header note).
// ============================================================================

/** Mirrors `DEFAULT_ORG_NAMESPACE` in `environment-base-spec/src/index.ts`. */
const DEFAULT_ORG_NAMESPACE = 'adhd';

/** Mirrors `DEFAULT_NAMESPACE` in `environment-base-spec/src/index.ts`. */
const DEFAULT_NAMESPACE = 'default';

/** Mirrors `SNAPSHOT_FILENAME` in `environment-base-spec/src/index.ts`. */
const SNAPSHOT_FILENAME = 'adhd-environment.json';

/**
 * Reserved prefix marking a redacted secret reference (mirrors
 * `SECRET_REF_PREFIX` in `@adhd/environment-base-spec`). A resolved config
 * value of `"adhd-secret-ref:ADHD_FOO_SECRET"` means "read the secret from
 * env var `ADHD_FOO_SECRET` at runtime"; the plaintext is never persisted
 * (ENV-CORE-009).
 */
const SECRET_REF_PREFIX = 'adhd-secret-ref:';

// ============================================================================
// Errors
// ============================================================================

/** Base error for all `@adhd/environment` runtime-client errors. */
export class EnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentError';
  }
}

/**
 * Raised when the snapshot JSON file does not exist on disk. Mirrors
 * `SnapshotNotFoundError` in the Python port and
 * `EnvironmentError::SnapshotNotFound` in the Rust port.
 */
export class SnapshotNotFoundError extends EnvironmentError {
  constructor(readonly snapshotPath: string) {
    super(`adhd-environment snapshot not found: ${snapshotPath}`);
    this.name = 'SnapshotNotFoundError';
  }
}

// ============================================================================
// Secret-reference resolution (ENV-CORE-009 / ENV-CORE-014)
//
// Mirrors `isSecretRef` / `resolveSecretRef` in `@adhd/environment-base-spec`
// (duplicated locally — see the module header note) and the equivalent
// inline resolution in the Python port's `_get_config_value` and the Rust
// port's `get_config`.
// ============================================================================

/** True if `value` is a secret reference string (see `SECRET_REF_PREFIX`). */
function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SECRET_REF_PREFIX);
}

/**
 * Resolves a secret reference against a supplied environment map, returning
 * the live secret value (or `undefined` if the env var is unset). Non-secret
 * values are returned unchanged. This is the read-time counterpart to
 * `@adhd/environment-builder`'s `redactSecrets` (write side) — every runtime
 * client (TS/Python/Rust) applies the equivalent resolution in its
 * `Environment.get`.
 */
function resolveSecretRef(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): unknown {
  if (!isSecretRef(value)) return value;
  return env[value.slice(SECRET_REF_PREFIX.length)];
}

// ============================================================================
// Small local helpers
// ============================================================================

/**
 * Fallback env-var prefix inference, used only when a snapshot's
 * `project.envPrefix` is somehow absent. Mirrors `projectEnvPrefix` in
 * `@adhd/environment-base-spec` (duplicated locally — see header note).
 */
function projectEnvPrefix(projectName: string): string {
  return `ADHD_${projectName.toUpperCase().replace(/[.-]/g, '_')}`;
}

/**
 * Rejects a `project`/`namespace` segment that could escape `adhdRoot` when
 * interpolated into a filesystem path (ENV-CORE-006). Mirrors
 * `_validate_path_segment` (Python) / `validate_path_segment` (Rust).
 */
function validatePathSegment(segment: string, label: string): void {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0') ||
    isAbsolute(segment)
  ) {
    throw new EnvironmentError(
      `${label} must be a non-empty path segment with no '.', '..', path separators, or NUL: ${JSON.stringify(segment)}`,
    );
  }
}

/** Resolves `dottedPath` against a nested object tree. `undefined` if any segment is missing. */
function getAtPath(node: unknown, dottedPath: string): unknown {
  let current: unknown = node;
  for (const segment of dottedPath.split('.')) {
    if (current !== null && typeof current === 'object' && segment in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

// ============================================================================
// Environment<T> — the runtime client
// ============================================================================

/**
 * Thin runtime client. Reads a pre-built snapshot JSON file and exposes
 * typed accessors. Does **not** do: YAML parsing, env var resolution
 * (beyond secret-reference lookup at read time), field merge, fieldSchema
 * generation, validation, or directory creation.
 *
 * @example
 * ```ts
 * const env = new Environment<AgentMcpConfig>({ project: "agent-mcp", namespace: "production" });
 * const port: number = env.get("config.transport.port");
 * ```
 *
 * @typeParam T — The config shape type. Defines what `get()` returns for a
 *   `"config.*"` path. When omitted, `get()` returns `unknown`.
 */
export class Environment<T = Record<string, unknown>> {
  /** The full snapshot data as read from disk. */
  private readonly _data: SnapshotData;

  /** Project name (kebab-case), as supplied to the constructor. */
  readonly project: string;

  /** Effective namespace (defaults to `"default"`). */
  readonly namespace: string;

  /** Effective org namespace, read from the snapshot's `project.orgNamespace`. */
  readonly orgNamespace: string;

  /** Scope filter (`undefined` = no filter). */
  readonly scope: ConfigScope | undefined;

  /** Absolute path to the snapshot JSON file that was read. */
  readonly snapshotPath: string;

  /** Effective env var prefix, read from the snapshot's `project.envPrefix`. */
  readonly prefix: string;

  /** Content hash from the snapshot (`configHash`). */
  readonly hash: string;

  /** Bracket-access shorthand: `env["config.x"]` === `env.get("config.x")`. */
  [key: string]: unknown;

  /**
   * @param params.project — Required. Project name (kebab-case).
   * @param params.scope — Optional. Filters returned config/dir values by scope.
   * @param params.namespace — Optional. Defaults to `"default"`.
   * @param params.adhdRoot — Optional. Defaults to `os.homedir() + "/.adhd"`.
   *
   * @throws {EnvironmentError} If `project` is empty, or `project`/`namespace`
   *   would escape `adhdRoot` when interpolated into a path (ENV-CORE-006).
   * @throws {SnapshotNotFoundError} If the snapshot file does not exist.
   */
  constructor(params: EnvironmentParams) {
    if (!params?.project) {
      throw new EnvironmentError("Environment requires a non-empty 'project' name");
    }

    this.project = params.project;
    this.namespace = params.namespace || DEFAULT_NAMESPACE;
    this.scope = params.scope;

    // ENV-CORE-006: guard against path traversal before interpolating
    // project/namespace into the snapshot path.
    validatePathSegment(this.project, 'project');
    validatePathSegment(this.namespace, 'namespace');

    const root = params.adhdRoot ?? join(homedir(), `.${DEFAULT_ORG_NAMESPACE}`);
    this.snapshotPath = join(root, this.project, this.namespace, SNAPSHOT_FILENAME);

    let raw: string;
    try {
      raw = readFileSync(this.snapshotPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new SnapshotNotFoundError(this.snapshotPath);
      }
      throw err;
    }
    this._data = JSON.parse(raw) as SnapshotData;

    const projectMeta = this._data.project;
    this.orgNamespace = projectMeta?.orgNamespace ?? DEFAULT_ORG_NAMESPACE;
    this.prefix = projectMeta?.envPrefix ?? projectEnvPrefix(this.project);
    this.hash = this._data.configHash ?? '';

    // Enables native bracket-access (`env["config.x"]`) to dispatch through
    // `.get()` for any string key that isn't already a real member of this
    // instance (`project`, `namespace`, `get`, `toJSON`, ...).
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && !(prop in target)) {
          return target.get(prop);
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /**
   * Typed config/dir/provenance/env accessor.
   *
   * Path prefixes:
   *   - `"config.*"` — reads from the snapshot's `config` (nested,
   *     dot-separated path). A value redacted at build time into an
   *     `"adhd-secret-ref:<ENV_VAR>"` reference (see `redactSecrets` in
   *     `@adhd/environment-builder`) is resolved from `process.env` here
   *     (ENV-CORE-009 / ENV-CORE-014) — never returned literally.
   *   - `"path.*"` — reads from the snapshot's `dirs` (by directory type, or
   *     `type.name`).
   *   - `"env.*"` — reads from the snapshot's `envVars`.
   *   - `"provenance.*"` — reads from the snapshot's `provenance`.
   *
   * Scope filtering: when `this.scope` is set, `"config.*"`/`"path.*"`
   * values whose provenance/directory scope does not match return
   * `undefined`.
   *
   * @example env.get("config.transport.port") // number
   * @example env.get("path.state.data") // string (first matching dir path)
   */
  get<K extends string>(key: K): DeepPath<T, K>;
  /** Untyped accessor — returns `unknown`. */
  get(key: string): unknown;
  get(key: string): unknown {
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) return undefined;

    const head = key.slice(0, dotIndex);
    const rest = key.slice(dotIndex + 1);

    switch (head) {
      case 'config':
        return this.getConfigValue(rest);
      case 'path':
        return this.getPathValue(rest);
      case 'env':
        return this._data.envVars?.[rest];
      case 'provenance':
        return this._data.provenance?.[rest];
      default:
        return undefined;
    }
  }

  /** Returns a deep-frozen copy of the full snapshot. Used for debugging. */
  toJSON(): Readonly<SnapshotData> {
    return Object.freeze(JSON.parse(JSON.stringify(this._data))) as Readonly<SnapshotData>;
  }

  // -- internal helpers ------------------------------------------------------

  /**
   * Resolves `dottedPath` against the nested `config` tree, applies scope
   * filtering via the matching provenance entry, then resolves any secret
   * reference (ENV-CORE-009 / ENV-CORE-014) before returning.
   */
  private getConfigValue(dottedPath: string): unknown {
    const node = getAtPath(this._data.config, dottedPath);

    if (this.scope !== undefined) {
      const provenance: ProvenanceEntry | undefined = this._data.provenance?.[dottedPath];
      if (!provenance || provenance.scope !== this.scope) return undefined;
    }

    return resolveSecretRef(node);
  }

  /**
   * Resolves a `path.*` lookup against `dirs` entries. Directory types
   * themselves contain a literal dot (e.g. `"state.data"`), so a bare
   * type-only lookup (`"path.state.data"`) is disambiguated from a
   * type+name lookup (`"path.state.data.registry"`) by first trying an
   * exact `"{type}.{name}"` match, then falling back to a bare `type` match.
   */
  private getPathValue(rest: string): string | undefined {
    const dirs: ResolvedDirectoryEntry[] = this._data.dirs ?? [];
    const matchesScope = (entry: ResolvedDirectoryEntry): boolean =>
      this.scope === undefined || entry.scope === this.scope;

    for (const entry of dirs) {
      if (!matchesScope(entry)) continue;
      if (entry.name && `${entry.type}.${entry.name}` === rest) return entry.path;
    }
    for (const entry of dirs) {
      if (!matchesScope(entry)) continue;
      if (entry.type === rest) return entry.path;
    }
    return undefined;
  }
}
