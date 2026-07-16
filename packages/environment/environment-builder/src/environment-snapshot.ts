/**
 * `environment-snapshot.ts` — the builder-side `EnvironmentSnapshot<T>` class
 * and its `build()` factory (`builder-snapshot-api`).
 *
 * This module is the orchestrator referenced by every other pipeline file's
 * header comment ("a later state") — it wires the 7 pure/side-effecting
 * `builder-engine` modules (`yaml-parser`, `field-merge`, `config-resolver`,
 * `json-schema-gen`, `provenance`, `validation`, `snapshot-writer`) into the
 * full build pipeline and wraps the result (`SnapshotData`) in a typed,
 * mutable, atomically-persistable `EnvironmentSnapshot<T>` instance.
 *
 * `build()` accepts either:
 *   - a `ParsedYamlSpec` (as produced by `yaml-parser.ts#parseYamlSpec`) —
 *     runs the full 17-step pipeline from scratch, or
 *   - an existing `EnvironmentSnapshot` instance — re-runs the same pipeline
 *     against the spec it was originally built from (picking up fresh env
 *     vars / `adhd-env set` store values), then replays every `.set()`
 *     override that had been applied in-memory on the prior instance, so a
 *     rebuild never silently drops uncommitted `.set()` calls.
 *
 * `[inv:atomic-write]`: `.write()` validates the in-memory config against its
 * generated JSON Schema *before* ever touching the filesystem, then delegates
 * to `snapshot-writer.ts#atomicWrite` (tmp file + `renameSync`) — a reader
 * can never observe a partially-written or invalid snapshot on disk.
 *
 * NOTE on cross-package imports: as with every other file in this package,
 * only *types* are imported from `@adhd/environment-base-spec` at runtime
 * (see the header note in `config-resolver.ts`) — any value this module needs
 * from that contract is duplicated locally so it resolves identically
 * whether loaded via the Nx/Vite path-aliased build or a bare `node -e
 * require(...)` of the built package (no workspace `node_modules/@adhd/*`
 * symlinks exist for the latter).
 */

import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type {
  BuildOptions,
  DeepPath,
  ParsedYamlSpec,
  ProjectConfig,
  ProjectIdentity,
  SnapshotData,
} from '@adhd/environment-base-spec';

import { mergeFieldDefinitions } from './field-merge';
import { coerceConfig, interpolateConfig, readStore, redactSecrets, resolveConfig, unflatten } from './config-resolver';
import { trackProvenance } from './provenance';
import { generateFieldSchema } from './json-schema-gen';
import { validateConfig } from './validation';
import {
  assertNoNamespaceConflict,
  atomicWrite,
  detectDrift,
  DriftError,
  readExistingSnapshot,
  resolveConfigPath,
  resolveDirs,
} from './snapshot-writer';
import { projectEnvPrefix } from './yaml-parser';

// ============================================================================
// Constants (duplicated locally rather than imported at runtime — see the
// module-level note above / in `config-resolver.ts`).
// ============================================================================

const DEFAULT_ORG_NAMESPACE = 'adhd';
const DEFAULT_NAMESPACE = 'default';

/** `SnapshotData.version` — the on-disk snapshot format's own version, distinct from the library's package version. */
const SNAPSHOT_FORMAT_VERSION = '1.0.0';
/** `SnapshotData.libraryVersion` — mirrors this package's `package.json#version`. Duplicated as a literal (not `require()`d) so this module resolves identically under the built package and under raw-source test runs. */
const LIBRARY_VERSION = '0.0.1';

// ============================================================================
// Path-safe dot-path get/set helpers.
//
// Deliberately local (not imported from `@adhd/data`/`@adhd/transform`):
// this package's established convention (every sibling pipeline file) is to
// never take a *runtime* dependency on another `@adhd/*` package, because a
// bare `node -e require(...)` of the built package has no workspace
// `node_modules/@adhd/*` symlinks to resolve them.
// ============================================================================

function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  let node: unknown = obj;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function setAtPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let node = obj;
  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      node[segment] = value;
      return;
    }
    const existing = node[segment];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  });
}

// ============================================================================
// Deterministic hashing (SHA-256, sorted-key JSON) for `configHash` /
// `structureHash`. Not the pinned cross-language `contentHash` algorithm
// (`@adhd/environment-base-spec#contentHash`, `runtime-py`/`runtime-rs`
// states) — those two hashes are builder-local drift/change fingerprints,
// not a cross-language-conformance-gated value.
// ============================================================================

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function sha256Hex(value: unknown): string {
  return `sha256-${createHash('sha256').update(JSON.stringify(sortKeysDeep(value)), 'utf8').digest('hex')}`;
}

// ============================================================================
// normalizeSpec — defensive `ParsedYamlSpec` completion.
//
// `parseYamlSpec` (yaml-parser.ts) always produces a fully-populated
// `ParsedYamlSpec`. `build()`, however, is also a public, programmatic
// entrypoint (CLI + tests) that may be handed a hand-built, partially-typed
// spec object; every field is defensively defaulted here so `build()` never
// throws on a merely-incomplete-but-well-intentioned input.
// ============================================================================

function normalizeSpec(input: ParsedYamlSpec): ParsedYamlSpec {
  const project = (input?.project ?? {}) as ProjectConfig;
  const name = project.name ?? 'unnamed-project';
  const orgNamespace = input?.orgNamespace ?? project.orgNamespace ?? DEFAULT_ORG_NAMESPACE;
  const envPrefix = input?.envPrefix ?? project.envPrefixOverride ?? projectEnvPrefix(name);
  const namespaces =
    Array.isArray(input?.namespaces) && input.namespaces.length > 0 ? input.namespaces : [DEFAULT_NAMESPACE];
  const dirs = Array.isArray(input?.dirs) ? input.dirs : [];
  const config = input?.config ?? ({} as ParsedYamlSpec['config']);

  return {
    project: {
      name,
      orgNamespace,
      envPrefixOverride: project.envPrefixOverride,
      description: project.description,
      namespaces: project.namespaces,
      dirs: project.dirs,
    },
    namespaces,
    dirs,
    config: {
      system: config.system ?? {},
      global: config.global ?? {},
      project: config.project ?? {},
    },
    orgNamespace,
    envPrefix,
  };
}

// ============================================================================
// EnvironmentSnapshot<T>
// ============================================================================

/**
 * Builder-side instance produced by `build()`. Wraps a resolved `SnapshotData`
 * with typed dot-path `.get()`/`.set()` accessors, the on-disk `.configPath`,
 * and an atomic `.write()`.
 *
 * `T` is the *shape of the resolved, nested config* (`SnapshotData.config`),
 * e.g. `EnvironmentSnapshot<{ data: { db: { path: string } } }>` makes
 * `.get("data.db.path")` return `string` and `.set("data.db.path", v)` require
 * `v: string`.
 */
export class EnvironmentSnapshot<T extends Record<string, unknown> = Record<string, unknown>> {
  private constructor(
    private data: SnapshotData,
    private readonly spec: ParsedYamlSpec,
    private readonly namespace: string,
    private readonly adhdRoot: string,
    private readonly _configPath: string,
    private readonly overrides: Record<string, unknown> = {},
  ) {}

  /** The on-disk path this snapshot is (or will be) written to: `<adhdRoot>/<orgNamespace>/<project>/<namespace>/adhd-environment.json`. */
  configPath(): string {
    return this._configPath;
  }

  /** Reads a value out of the resolved, nested config by dot path. `undefined` if the path is not present. */
  get<K extends string>(path: K): DeepPath<T, K> | undefined {
    return getAtPath(this.data.config, path) as DeepPath<T, K> | undefined;
  }

  /**
   * Sets a value in the resolved, nested config by dot path (creating
   * intermediate objects as needed). Also mirrors the value into the flat
   * `raw` map and records it as an "override" so a subsequent `build(this)`
   * rebuild replays it on top of freshly-resolved values (never silently
   * dropped). In-memory only — `.write()` (or a later `build()`) is required
   * to persist it; per `[inv:cli-sole-writer]` this class never writes any
   * other store/file as a side effect of `.set()`.
   */
  set<K extends string>(path: K, value: DeepPath<T, K>): this {
    setAtPath(this.data.config, path, value);
    this.data.raw[path] = value;
    this.overrides[path] = value;
    return this;
  }

  /**
   * Atomically persists this snapshot to `.configPath`. Validates the
   * resolved config against its generated `fieldSchema` *first* — a `.set()`
   * call made after `build()` can invalidate a previously-valid snapshot, and
   * an invalid config must never reach the filesystem, not even partially
   * (`[inv:atomic-write]`). Throws `ValidationError` (from `./validation`) and
   * writes nothing on failure.
   */
  write(): void {
    validateConfig(this.data.config, this.data.fieldSchema);
    atomicWrite(this._configPath, this.data);
  }

  // ==========================================================================
  // build() — the full pipeline, exposed as a static method so it (and only
  // it) may reach into another `EnvironmentSnapshot` instance's private
  // fields (`spec`/`overrides`/`namespace`/`adhdRoot`) for the rebuild path.
  // ==========================================================================

  static build<T extends Record<string, unknown> = Record<string, unknown>>(
    input: ParsedYamlSpec | EnvironmentSnapshot<any>,
    options: BuildOptions = {},
  ): EnvironmentSnapshot<T> {
    if (input instanceof EnvironmentSnapshot) {
      return EnvironmentSnapshot.rebuild<T>(input, options);
    }
    return EnvironmentSnapshot.fromSpec<T>(normalizeSpec(input), options);
  }

  private static rebuild<T extends Record<string, unknown>>(
    existing: EnvironmentSnapshot<any>,
    options: BuildOptions,
  ): EnvironmentSnapshot<T> {
    const rebuilt = EnvironmentSnapshot.fromSpec<T>(existing.spec, {
      ...options,
      namespace: options.namespace ?? existing.namespace,
      adhdRoot: options.adhdRoot ?? existing.adhdRoot,
    });
    // Replay every in-memory `.set()` override from the prior instance so a
    // rebuild never silently drops uncommitted values.
    for (const path of Object.keys(existing.overrides)) {
      rebuilt.setAtPathRaw(path, existing.overrides[path]);
    }
    return rebuilt;
  }

  /** Internal, untyped `set()` used by `rebuild()` to replay dot-path overrides recorded before their concrete `K` was known. */
  private setAtPathRaw(path: string, value: unknown): void {
    setAtPath(this.data.config, path, value);
    this.data.raw[path] = value;
    this.overrides[path] = value;
  }

  private static fromSpec<T extends Record<string, unknown>>(
    rawSpec: ParsedYamlSpec,
    options: BuildOptions,
  ): EnvironmentSnapshot<T> {
    const spec = normalizeSpec(rawSpec);
    const namespace = options.namespace ?? DEFAULT_NAMESPACE;
    if (!spec.namespaces.includes(namespace)) {
      throw new Error(
        `Namespace "${namespace}" is not declared for project "${spec.project.name}" ` +
          `(declared: ${spec.namespaces.join(', ')})`,
      );
    }

    const project = spec.project;
    // `~/.<orgNamespace>` — see `resolveConfigPath`'s own test suite
    // (`__tests__/snapshot-writer.test.ts`): the root passed in already
    // contains the dotted org segment, and `orgNamespace` is then joined
    // again underneath it (`resolveConfigPath('/x/.adhd', 'adhd', ...)` →
    // `/x/.adhd/adhd/...`), so the default root for orgNamespace "adhd" is
    // exactly `os.homedir()/.adhd` — matching `BuildOptions.adhdRoot`'s doc.
    const adhdRoot = options.adhdRoot ?? `${homedir()}/.${spec.orgNamespace}`;

    // ---- steps 4-11: merge fields, load store, resolve, interpolate, coerce, redact ----
    const mergedFields = mergeFieldDefinitions(spec.config.system, spec.config.global, spec.config.project);
    const store = readStore(adhdRoot, spec.orgNamespace, project.name, namespace);
    const { raw, resolved, fields } = resolveConfig(mergedFields, {
      prefix: spec.envPrefix,
      store,
      scope: options.scope,
    });
    const interpolated = interpolateConfig(raw);
    const coerced = coerceConfig(interpolated, fields);
    const redacted = redactSecrets(coerced, fields);
    const config = unflatten(redacted);

    // ---- step 12: generate fieldSchema ----
    const fieldSchema = generateFieldSchema(fields);

    // ---- step 13: validate before anything is persisted ----
    validateConfig(config, fieldSchema);

    // ---- step 15: resolve directory catalog ----
    const resolvedDirs = resolveDirs(spec.dirs, {
      adhdRoot,
      orgNamespace: spec.orgNamespace,
      project: project.name,
      namespace,
    });

    // ---- step 16: drift / namespace-conflict check against any existing on-disk snapshot ----
    const configPath = options.configPath ?? resolveConfigPath(adhdRoot, spec.orgNamespace, project.name, namespace);
    if (!options.dryRun) {
      const existingOnDisk = readExistingSnapshot(configPath);
      if (existingOnDisk) {
        assertNoNamespaceConflict(existingOnDisk, project.name, configPath);
        const drift = detectDrift(existingOnDisk.dirs, resolvedDirs);
        if (drift.typeChanges.length > 0 || drift.scopeChanges.length > 0) {
          throw new DriftError(drift);
        }
        if (drift.added.length > 0 || drift.removed.length > 0) {
          // Additive/removed directories are a warning, never a hard failure.
          // eslint-disable-next-line no-console
          console.warn(
            `[environment-builder] directory catalog changed for "${project.name}/${namespace}": ` +
              `+${drift.added.length} added, -${drift.removed.length} removed`,
          );
        }
      }
    }

    // ---- step 14: provenance + recorded env var values ----
    const provenance = trackProvenance(resolved);
    const envVars: Record<string, string> = {};
    for (const key of Object.keys(resolved)) {
      const env = resolved[key].env;
      if (env !== undefined && process.env[env] !== undefined) {
        envVars[env] = process.env[env] as string;
      }
    }

    const identity: ProjectIdentity = {
      name: project.name,
      orgNamespace: spec.orgNamespace,
      envPrefix: spec.envPrefix,
      namespace,
      description: project.description,
    };

    const data: SnapshotData = {
      version: SNAPSHOT_FORMAT_VERSION,
      libraryVersion: LIBRARY_VERSION,
      generatedAt: new Date().toISOString(),
      project: identity,
      config,
      raw: redacted,
      fieldSchema,
      configHash: sha256Hex(redacted),
      structureHash: sha256Hex(resolvedDirs),
      dirs: resolvedDirs,
      provenance,
      envVars,
    };

    return new EnvironmentSnapshot<T>(data, spec, namespace, adhdRoot, configPath);
  }
}

/**
 * Factory entrypoint: builds a fresh `EnvironmentSnapshot<T>` from a
 * `ParsedYamlSpec`, or rebuilds one from an existing `EnvironmentSnapshot`
 * (re-resolving env/store values while preserving every `.set()` override
 * applied since it was last built). See `EnvironmentSnapshot.build`.
 */
export function build<T extends Record<string, unknown> = Record<string, unknown>>(
  input: ParsedYamlSpec | EnvironmentSnapshot<any>,
  options?: BuildOptions,
): EnvironmentSnapshot<T> {
  return EnvironmentSnapshot.build<T>(input, options);
}
