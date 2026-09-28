/**
 * service-config.ts — the `service.*` config contract (D-A, Segment A).
 *
 * D-A does NOT reinvent the `@adhd/environment` cascade; it VALIDATES the
 * resolved result. Two things the cascade cannot express are added here:
 *
 *  1. An UNKNOWN key under `service.*` is a HARD ERROR. The environment
 *     schema silently drops keys it does not declare — which is exactly how
 *     a mistyped key (the recorded `environment` vs `env` no-op) yields a
 *     server that "looks configured" and never starts.
 *  2. A PATH-valued field must be absolute (or a PATH-resolvable bin). A
 *     relative path resolves against an unpredictable cwd.
 *
 * The stated TOTAL precedence (highest first) is:
 *   1. explicit StartOpts fields,
 *   2. `ADHD_BACKLOG_*` env vars (read directly, via the declared `env` name),
 *   3. the `service.*` subtree of the scope config layer files
 *      (`backlogConfigLayerFiles` reused, never re-derived),
 *   4. the code defaults below.
 */
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, delimiter, dirname } from 'node:path';
import type { Scope } from '@adhd/environment-base-spec';
import type { Environment } from '@adhd/environment';
import { readLayerFile } from '@adhd/environment-builder';
import { suggestClosestCatalogNames } from './query/resolve.js';
import {
  UnknownConfigKeyError,
  NonAbsolutePathError,
  UnknownMcpConfigKeyError,
  ArtifactDriftError,
} from './service-errors.js';
import { backlogConfigLayerFiles } from './write/embedding-config.js';
import {
  backlogEnvironmentSpec,
  resolveBacklogDbPath,
  resolveBacklogScope,
} from './env.js';
import type { BacklogConfig } from './env.js';
import type { StartOpts } from './server.js';

export type IServiceTransport = 'mcp' | 'http' | 'both';

export interface IArtifactIdentity {
  kind: 'path' | 'package';
  /** kind:'path' — sha256 hex of the resolved entry file. */
  sha256?: string;
  /** kind:'package' — the published name + version to match. */
  name?: string;
  version?: string;
}

export interface IServiceConfig {
  transport: IServiceTransport;
  port: number;
  host: string;
  scope: Scope;
  /** MUST be absolute (or the literal ':memory:' test path). */
  dbPath: string;
  busyTimeoutMs: number;
  server: {
    /** Absolute path, or a PATH-resolvable bin (`npx`/`node`). `''` = unset. */
    command: string;
    identity: IArtifactIdentity;
  };
  readiness: { timeoutMs: number };
  connect: {
    /** Pre-connect deadline extension — the cold-start grace window. */
    graceMs: number;
    /** Total wall-clock budget across all attempts (bounded, never unbounded). */
    budgetMs: number;
    maxAttempts: number;
    baseMs: number;
    maxMs: number;
    breakerFailureThreshold: number;
    breakerResetMs: number;
  };
}

/**
 * The schema owner for the `service.*` subtree — the allow-list unknown keys
 * are checked against. The keys are FULL dot-paths; `env.ts`'s spec declares
 * exactly this set and a unit test asserts the two cannot drift.
 *
 * D-A apply-fix (2026-09-27): four keys that were RESOLVED but consumed by
 * nothing were REMOVED rather than shipped as silent no-ops (the finding's
 * "wire it, or stop declaring it" rule):
 *   - `service.namespace` — directly contradicts `env.ts`'s own contract that
 *     namespace selection is explicit-parameter-only
 *     (`BuildBacklogEnvOptions.namespace`), never resolved from an env var or
 *     config file; a key that can never be honored only misleads.
 *   - `service.serverArgs` — this process IS the server; nothing ever LAUNCHES
 *     `server.command` (its sole consumer is the load-time artifact-drift
 *     check, which ignores args), so args had no role.
 *   - `service.readinessIntervalMs` / `service.readinessMaxMissedTicks` — they
 *     describe a serving-loop watchdog TICK, but no such tick exists here and
 *     a same-process watchdog cannot observe its own frozen event loop;
 *     genuinely a later (external-supervisor) slice.
 * The remaining keys are all APPLIED: transport/port/host mount the server,
 * `serverCommand` drives `assertServerArtifact`, `connect*` drives
 * `withResilience` around the serving-path readiness probe, and
 * `readinessTimeoutMs` caps one probe.
 */
export const SERVICE_CONFIG_KEYS: readonly string[] = Object.freeze([
  'service.transport',
  'service.port',
  'service.host',
  'service.serverCommand',
  'service.connectGraceMs',
  'service.connectBudgetMs',
  'service.readinessTimeoutMs',
]);

/** The `service.*` subgroup an unknown key's suffix is checked within. */
const SERVICE_PREFIX = 'service.';

const DEFAULT_SERVICE: Readonly<Record<string, unknown>> = {
  'service.transport': 'mcp',
  'service.port': 3300,
  'service.host': '127.0.0.1',
  'service.serverCommand': '',
  'service.connectGraceMs': 20000,
  'service.connectBudgetMs': 60000,
  'service.readinessTimeoutMs': 30000,
};

/**
 * True when `candidate` is an executable bin reachable on `PATH`. An absolute
 * path is NOT automatically accepted here — the drift check owns absolute
 * existence; this helper only answers "can the shell find this bare name".
 */
export function isPathResolvableBin(candidate: string): boolean {
  const pathEnv = process.env['PATH'];
  if (!pathEnv) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, candidate), constants.X_OK);
      return true;
    } catch {
      // not executable here — keep looking
    }
  }
  return false;
}

/** A path is acceptable when absolute, the literal `:memory:`, or a PATH bin. */
function assertAcceptablePath(field: string, value: string): void {
  if (value === '' || value === ':memory:') return;
  if (isAbsolute(value)) return;
  if (isPathResolvableBin(value)) return;
  throw new NonAbsolutePathError(field, value);
}

function coerce(key: string, raw: unknown): unknown {
  const spec = backlogEnvironmentSpec.config[key];
  const type = spec?.type;
  if (raw === undefined) return undefined;
  if (type === 'integer' || type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    return raw === 'true' || raw === '1';
  }
  return raw;
}

/**
 * Resolves, validates and freezes the `service.*` configuration for one
 * process. Throws {@link UnknownConfigKeyError} on an unknown key in ANY
 * layer file and {@link NonAbsolutePathError} on a relative path field.
 */
export function resolveServiceConfig(
  opts: StartOpts,
  env: Environment<BacklogConfig>
): IServiceConfig {
  const serviceOpts = {
    scope: opts.scope,
    adhdRoot: opts.adhdRoot,
    cwd: opts.cwd,
    namespace: opts.namespace,
  };

  const resolved: Record<string, unknown> = { ...DEFAULT_SERVICE };

  // 3. layer files, lowest → highest priority (later wins).
  for (const file of backlogConfigLayerFiles(serviceOpts)) {
    const layer = readLayerFile(file);
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (!key.startsWith(SERVICE_PREFIX)) continue;
      if (!SERVICE_CONFIG_KEYS.includes(key)) {
        throw new UnknownConfigKeyError(key.slice(SERVICE_PREFIX.length), file);
      }
      const coerced = coerce(key, value);
      if (coerced !== undefined) resolved[key] = coerced;
    }
  }

  // 2. env vars (highest config layer before explicit opts).
  for (const key of SERVICE_CONFIG_KEYS) {
    const envName = backlogEnvironmentSpec.config[key]?.env;
    if (!envName) continue;
    const raw = process.env[envName];
    if (raw === undefined) continue;
    const coerced = coerce(key, raw);
    if (coerced !== undefined) resolved[key] = coerced;
  }

  // 1. explicit StartOpts fields (highest).
  if (opts.transport !== undefined) resolved['service.transport'] = opts.transport;
  if (opts.port !== undefined) resolved['service.port'] = opts.port;
  if (opts.host !== undefined) resolved['service.host'] = opts.host;

  const dbPath = resolveBacklogDbPath(env);
  assertAcceptablePath('service.dbPath', dbPath);

  const command = String(resolved['service.serverCommand'] ?? '');
  assertAcceptablePath('server.command', command);

  const transport = resolved['service.transport'] as IServiceTransport;
  if (transport !== 'mcp' && transport !== 'http' && transport !== 'both') {
    throw new NonAbsolutePathError(
      'service.transport',
      String(resolved['service.transport'])
    );
  }

  return {
    transport,
    port: Number(resolved['service.port']),
    host: String(resolved['service.host']),
    scope: resolveBacklogScope(opts.scope),
    dbPath,
    busyTimeoutMs: env.config.db.busyTimeoutMs,
    server: { command, identity: { kind: 'path' } },
    readiness: {
      timeoutMs: Number(resolved['service.readinessTimeoutMs']),
    },
    connect: {
      graceMs: Number(resolved['service.connectGraceMs']),
      budgetMs: Number(resolved['service.connectBudgetMs']),
      maxAttempts: 4,
      baseMs: 250,
      maxMs: 5000,
      breakerFailureThreshold: 3,
      breakerResetMs: 30000,
    },
  };
}

export interface IMcpServerEntry {
  type?: string;
  command?: string | string[];
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

const MCP_ENTRY_KEYS: readonly string[] = ['type', 'command', 'args', 'env', 'url'];

/**
 * Validates ONE host MCP server entry the tool writes or reads. Unknown keys
 * are a HARD ERROR (the recorded `environment` vs `env` silent no-op is the
 * exact failure): a key outside the entry's own schema
 * (`type/command/args/env/url`) throws {@link UnknownMcpConfigKeyError}; a
 * relative `command` path that is not a PATH-resolvable bin throws
 * {@link NonAbsolutePathError}.
 */
export function assertMcpEntryValid(
  entry: unknown,
  hostPath: string
): asserts entry is IMcpServerEntry {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new UnknownMcpConfigKeyError(hostPath, '<non-object entry>');
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (MCP_ENTRY_KEYS.includes(key)) continue;
    const suggestions = suggestClosestCatalogNames(key, [...MCP_ENTRY_KEYS]);
    throw new UnknownMcpConfigKeyError(hostPath, key, suggestions[0]);
  }
  const command = record['command'];
  if (typeof command === 'string') {
    assertAcceptablePath('server.command', command);
  } else if (Array.isArray(command) && typeof command[0] === 'string') {
    assertAcceptablePath('server.command', command[0]);
  } else if (command !== undefined) {
    throw new NonAbsolutePathError(
      'server.command',
      JSON.stringify(command)
    );
  }
}

/** Resolves a bare bin name to its first executable on `PATH`, or `undefined`. */
function resolveOnPath(bin: string): string | undefined {
  const pathEnv = process.env['PATH'];
  if (!pathEnv) return undefined;
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, bin);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Resolves the running bin's installed `package.json` by walking up from the
 * bin's directory looking for `node_modules/<name>/package.json`.
 */
function resolveInstalledPackageVersion(
  binPath: string,
  name: string
): string | undefined {
  let dir = dirname(binPath);
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as {
          version?: string;
        };
        return pkg.version;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Load-time drift check. Resolves `server.command` to an absolute path (or a
 * PATH-resolvable bin recorded with its resolved path), asserts it EXISTS, is
 * EXECUTABLE, and that its content identity matches `server.identity`:
 *
 *   - `kind:'path'`    → sha256(resolved file) === identity.sha256
 *   - `kind:'package'` → the resolved package's package.json version === identity.version
 *
 * On missing/drift → {@link ArtifactDriftError} naming the resolved absolute
 * path — it refuses to start rather than launch a phantom. A PURE read: it
 * mutates nothing. A `command` that is unset (`''`) is a no-op, so a process
 * that is not configured to launch an external artifact is never blocked.
 */
export function assertServerArtifact(
  server: IServiceConfig['server']
): void {
  const { command, identity } = server;
  if (command === '') return;

  const resolvedPath = isAbsolute(command)
    ? command
    : resolveOnPath(command) ?? command;

  const expected =
    identity.kind === 'package'
      ? `package ${identity.name ?? ''}@${identity.version ?? ''}`
      : `sha256 ${identity.sha256 ?? '(unspecified)'}`;

  if (!existsSync(resolvedPath)) {
    throw new ArtifactDriftError(expected, 'missing', resolvedPath);
  }
  try {
    accessSync(resolvedPath, constants.X_OK);
  } catch {
    throw new ArtifactDriftError(expected, 'not executable', resolvedPath);
  }
  // A bare PATH bin could not be located — the resolvedPath stayed relative.
  if (!isAbsolute(resolvedPath)) {
    throw new ArtifactDriftError(expected, 'not found on PATH', resolvedPath);
  }

  if (identity.kind === 'path' && identity.sha256) {
    const actual = sha256File(resolvedPath);
    if (actual !== identity.sha256) {
      throw new ArtifactDriftError(
        `sha256:${identity.sha256}`,
        `sha256:${actual}`,
        resolvedPath
      );
    }
  } else if (identity.kind === 'package' && identity.name && identity.version) {
    const actualVersion =
      resolveInstalledPackageVersion(resolvedPath, identity.name) ?? '(unknown)';
    if (actualVersion !== identity.version) {
      throw new ArtifactDriftError(
        `version ${identity.version}`,
        `version ${actualVersion}`,
        resolvedPath
      );
    }
  }
}
