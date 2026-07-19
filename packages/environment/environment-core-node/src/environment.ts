/**
 * `environment.ts` — the `Environment<T>` runtime client
 * (`@adhd/environment`), per `ARCHITECTURE.md` §3.
 *
 * PRIMARY mode — code-first, live resolve: `new Environment(project, spec,
 * options?)` wraps `@adhd/environment-builder#buildSnapshot`, which resolves
 * the WHOLE cascade (code defaults → system/global/project/local files →
 * env vars) synchronously, in memory, at construction — no disk read is
 * ever a prerequisite (`ARCHITECTURE.md` §2.1). A `secret`/`at:'runtime'`
 * field's leaf in `config` is replaced, here, with a live getter that
 * re-reads `process.env` on every access (see `installLiveGetters`).
 *
 * SECONDARY mode — snapshot-only: `Environment.fromSnapshot(path)` reads a
 * previously-`.write()`-persisted JSON snapshot (cross-process handoff /
 * inspection) and exposes the identical accessor surface, without running
 * the builder pipeline at all.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type {
  DeepPath,
  EnvironmentOptions,
  EnvironmentSpec,
  LiveFieldMeta,
  ProvenanceEntry,
  ResolvedDirEntry,
  Scope,
  SnapshotData,
} from '@adhd/environment-base-spec';
import {
  ValidationError,
  atomicWrite,
  buildSnapshot,
  coerceValue,
  resolveEnvironmentContext,
  resolveSnapshotPath,
} from '@adhd/environment-builder';

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

/** Raised by `Environment.fromSnapshot` when the snapshot JSON file does
 *  not exist on disk. Never raised by the primary (spec-driven)
 *  constructor — that path has no disk-read prerequisite. */
export class SnapshotNotFoundError extends EnvironmentError {
  constructor(readonly snapshotPath: string) {
    super(`adhd-environment snapshot not found: ${snapshotPath}`);
    this.name = 'SnapshotNotFoundError';
  }
}

/** Raised by `Environment#lock()` when the named lock is already held. */
export class LockHeldError extends EnvironmentError {
  constructor(
    readonly lockName: string,
    readonly lockPath: string,
  ) {
    super(`lock "${lockName}" is already held (${lockPath})`);
    this.name = 'LockHeldError';
  }
}

// ============================================================================
// Small local helpers
// ============================================================================

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

/** Deep-clones a JSON-safe value (every leaf `Environment#config` can ever
 *  hold is a `FieldType` value or a plain nested object of them — never a
 *  function/class instance), so `installLiveGetters` can freely
 *  `Object.defineProperty` on the clone without mutating the builder's
 *  original `SnapshotData.config`. */
function deepCloneJson<V>(value: V): V {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => deepCloneJson(v)) as unknown as V;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepCloneJson(v);
  }
  return out as V;
}

/**
 * Clones `config` and replaces every declared `liveFields` leaf with a
 * getter that re-reads `process.env[meta.env]` on EVERY access — never
 * baking in a value at construction time (ARCHITECTURE.md §7.5
 * runtime-vs-build proof). Falls back to `meta.fallback` (already
 * secret-redacted to `undefined` by the builder — see
 * `LiveFieldMeta.fallback`'s doc comment) when the live env var is unset.
 */
function installLiveGetters<T>(config: T, liveFields: Record<string, LiveFieldMeta>): T {
  const cloned = deepCloneJson(config) as unknown as Record<string, unknown>;
  for (const key of Object.keys(liveFields)) {
    const meta = liveFields[key];
    const segments = key.split('.');
    let node: Record<string, unknown> = cloned;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      const existing = node[segment];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        node[segment] = {};
      }
      node = node[segment] as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1];
    Object.defineProperty(node, leaf, {
      enumerable: true,
      configurable: true,
      get(): unknown {
        const liveValue = process.env[meta.env];
        return liveValue !== undefined ? coerceValue(liveValue, meta.type) : meta.fallback;
      },
    });
  }
  return cloned as unknown as T;
}

/** Rejects a lock `name` that could escape the run directory when joined
 *  into a filesystem path. */
function validateLockName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new EnvironmentError(`lock name must be a non-empty path segment with no path separators: ${JSON.stringify(name)}`);
  }
}

// ============================================================================
// Environment<T> — the runtime client
// ============================================================================

/**
 * The `@adhd/environment` runtime client. See `ARCHITECTURE.md` §3 for the
 * full public contract.
 *
 * @example
 * ```ts
 * const env = new Environment<AgentMcpConfig>('agent-mcp', spec);
 * const port: number = env.config.transport.port; // zero-config default, unless overridden
 * ```
 */
export class Environment<T = Record<string, unknown>> {
  /** Project name (kebab-case). */
  declare readonly project: string;
  /** Effective namespace. */
  declare readonly namespace: string;
  /** Effective org namespace. */
  declare readonly orgNamespace: string;
  /** The resolved active scope (ARCHITECTURE.md §2.3). */
  declare readonly scope: Scope;
  /** Effective env var prefix (explicit or inferred from `project`). */
  declare readonly prefix: string;
  /** Unique per constructed instance (`pid + short random`, or an explicit
   *  `EnvironmentOptions.instanceId` override). */
  declare readonly instanceId: string;
  /** Content hash of the resolved config (`SnapshotData.configHash`). */
  declare readonly hash: string;
  /** Snapshot metadata: config hash, structure hash, generation timestamp,
   *  and library version — computed live. */
  declare readonly version: {
    configHash: string;
    structureHash: string;
    generatedAt: string;
    libraryVersion: string;
  };
  /** Field-level provenance records. */
  declare readonly provenance: Record<string, ProvenanceEntry>;
  /** Resolved directory catalog entries (see also `paths`, the name→path convenience map). */
  declare readonly dirs: ResolvedDirEntry[];
  /** Where `.write()` persists (or `Environment.fromSnapshot` read from). */
  declare readonly snapshotPath: string;

  /**
   * Typed, fully-resolved nested config object — the PRIMARY accessor.
   * A `secret`/`at:'runtime'` field is a live getter here: it re-reads
   * `process.env` on every access (ARCHITECTURE.md §7.5). Every other field
   * is resolved once, at construction.
   *
   * @example env.config.transport.port   // number
   * @example env.config.db.path          // string
   */
  declare readonly config: T;

  /** Resolved absolute directory path per declared `dirs` key. Directories
   *  are NOT created eagerly — call `ensureDirs()` to create them on disk. */
  declare readonly paths: Record<string, string>;

  /** Resolved absolute file path per declared `files` key. */
  declare readonly files: Record<string, string>;

  /** The full resolved snapshot (private — internal representation). */
  declare private readonly _data: SnapshotData<T>;

  /** Bracket-access shorthand: `env["config.x"]` === `env.get("config.x")`. */
  [key: string]: unknown;

  /**
   * @param project — Required. Project name (kebab-case).
   * @param spec — Required. The code-defined `EnvironmentSpec<T>`.
   * @param options — Optional. See `EnvironmentOptions`.
   *
   * Resolves the ENTIRE cascade synchronously, in memory, right here — no
   * disk read is ever a prerequisite (ARCHITECTURE.md §2.1). Throws
   * `ValidationError` (from `@adhd/environment-builder`) if the resolved
   * config violates the generated JSON Schema.
   */
  constructor(project: string, spec: EnvironmentSpec<T>, options: EnvironmentOptions = {}) {
    let data: SnapshotData<T>;
    let snapshotPath: string;
    try {
      data = buildSnapshot<T>(project, spec, options);
      const ctx = resolveEnvironmentContext(project, spec, options);
      snapshotPath = resolveSnapshotPath(ctx.roots, data.scope);
    } catch (err) {
      // `ValidationError` (schema violation) is a distinct, documented public
      // error type — propagate it verbatim. Everything else raised by the
      // builder (bad project/namespace name, undeclared namespace, ...) is
      // wrapped into `EnvironmentError`, this package's single error base,
      // so a consumer of `@adhd/environment` never needs to import
      // `@adhd/environment-builder` just to catch its errors.
      if (err instanceof ValidationError || err instanceof EnvironmentError) throw err;
      throw new EnvironmentError(err instanceof Error ? err.message : String(err));
    }
    return populateEnvironment(this, data, snapshotPath);
  }

  /**
   * SECONDARY mode: reads a previously-`.write()`-persisted snapshot JSON
   * file and exposes the identical accessor surface, WITHOUT running the
   * builder pipeline (no spec required) — for cross-process handoff or
   * inspection by another consumer. Throws `SnapshotNotFoundError` if the
   * file does not exist.
   */
  static fromSnapshot<T = Record<string, unknown>>(snapshotPath: string): Environment<T> {
    if (!existsSync(snapshotPath)) {
      throw new SnapshotNotFoundError(snapshotPath);
    }
    const data = JSON.parse(readFileSync(snapshotPath, 'utf8')) as SnapshotData<T>;
    const instance = Object.create(Environment.prototype) as Environment<T>;
    return populateEnvironment(instance, data, snapshotPath);
  }

  /**
   * Dynamic dot-path accessor.
   *
   * Path prefixes:
   *   - `"config.*"` — reads from `config` (live getters apply).
   *   - `"path.*"` — reads from `paths` by declared `dirs` key.
   *   - `"env.*"` — reads a live env var THROUGH `resolveEnvName` (the
   *     project-prefix allowlist always applies — this can never be used to
   *     bypass it).
   *   - `"provenance.*"` — reads from `provenance`.
   *
   * @example env.get("config.transport.port") // number
   * @example env.get("path.data")             // string
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
        return getAtPath(this.config, rest);
      case 'path':
        return this.paths[rest];
      case 'env':
        return this.resolveEnvName(rest);
      case 'provenance':
        return this._data.provenance[rest];
      default:
        return undefined;
    }
  }

  /**
   * True iff `name` is within this project's env-prefix scope (security
   * guard) — e.g. `"ADHD_AGENT_MCP_DB_PATH"` when `prefix === "ADHD_AGENT_MCP"`.
   */
  isEnvNameAllowed(name: string): boolean {
    return name.startsWith(this.prefix);
  }

  /**
   * Resolves a live env-var value from `process.env`, applying the
   * `isEnvNameAllowed` guard. Returns `undefined` if the name is disallowed
   * or the env var is unset. This is the single sanctioned way for
   * consumers to read from `process.env` (e.g. agent-mcp's
   * `getProviderConfig`).
   */
  resolveEnvName(name: string): string | undefined {
    if (!this.isEnvNameAllowed(name)) return undefined;
    return process.env[name];
  }

  /**
   * Acquires an advisory, exclusive, filesystem-based lock under a declared
   * `kind: 'run'` directory (or, absent one, `<dirname(snapshotPath)>/run` —
   * zero-config: locking never requires declaring a `run` dir). Returns a
   * release function. Throws `LockHeldError` (deterministically — no
   * polling/timing) if the lock is already held by another instance.
   */
  lock(name = 'singleton'): () => void {
    validateLockName(name);
    const runDir = this.paths.run ?? this._runDirFallback();
    mkdirSync(runDir, { recursive: true });
    const lockPath = join(runDir, `${name}.lock`);

    let fd: number;
    try {
      // 'wx': exclusive create — atomically fails with EEXIST if the file
      // already exists. No polling/timing required for a deterministic proof.
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        throw new LockHeldError(name, lockPath);
      }
      throw err;
    }
    writeSync(fd, `${process.pid}\n${this.instanceId}\n`);
    closeSync(fd);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        unlinkSync(lockPath);
      } catch {
        /* best-effort — already gone is fine */
      }
    };
  }

  private _runDirFallback(): string {
    return join(dirname(this.snapshotPath), 'run');
  }

  /** Creates every declared directory in `paths` on disk (recursive
   *  `mkdir`), if it does not already exist. `paths` are resolved lazily as
   *  strings at construction; this is the opt-in step that actually touches
   *  the filesystem. */
  ensureDirs(): void {
    for (const path of Object.values(this.paths)) {
      mkdirSync(path, { recursive: true });
    }
  }

  /**
   * Atomically persists the resolved snapshot to `snapshotPath`. Optional —
   * never a prerequisite for any other `Environment` instance
   * (ARCHITECTURE.md §2.1). Returns the path written to.
   */
  write(): string {
    atomicWrite(this.snapshotPath, this._data);
    return this.snapshotPath;
  }

  /** Returns a deep-frozen copy of the full resolved snapshot. Debugging/inspection only. */
  toJSON(): Readonly<SnapshotData<T>> {
    return Object.freeze(JSON.parse(JSON.stringify(this._data))) as Readonly<SnapshotData<T>>;
  }
}

/**
 * Shared population step for both construction paths (live-resolve and
 * `fromSnapshot`): assigns every public member from `data`, installs live
 * getters for `secret`/`at:'runtime'` fields, and wraps the result in a
 * `Proxy` so bracket-access (`env["config.x"]`) dispatches through `get()`
 * for any string key that isn't already a real member.
 */
function populateEnvironment<T>(
  target: Environment<T>,
  data: SnapshotData<T>,
  snapshotPath: string,
): Environment<T> {
  const paths: Record<string, string> = {};
  for (const dir of data.dirs) paths[dir.name] = dir.path;

  const files: Record<string, string> = {};
  for (const file of data.files) files[file.name] = file.path;

  const config = installLiveGetters(data.config, data.liveFields ?? {});

  Object.defineProperties(target, {
    project: { value: data.project, enumerable: true },
    namespace: { value: data.namespace, enumerable: true },
    orgNamespace: { value: data.orgNamespace, enumerable: true },
    scope: { value: data.scope, enumerable: true },
    prefix: { value: data.envPrefix, enumerable: true },
    instanceId: { value: data.instanceId, enumerable: true },
    hash: { value: data.configHash, enumerable: true },
    version: {
      value: {
        configHash: data.configHash,
        structureHash: data.structureHash,
        generatedAt: data.generatedAt,
        libraryVersion: data.libraryVersion,
      },
      enumerable: true,
    },
    provenance: { value: data.provenance, enumerable: true },
    dirs: { value: data.dirs, enumerable: true },
    snapshotPath: { value: snapshotPath, enumerable: true },
    config: { value: config, enumerable: true },
    paths: { value: paths, enumerable: true },
    files: { value: files, enumerable: true },
    _data: { value: data, enumerable: false },
  });

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (typeof prop === 'string' && !(prop in t)) {
        return (t as Environment<T>).get(prop);
      }
      return Reflect.get(t, prop, receiver);
    },
  });
}
