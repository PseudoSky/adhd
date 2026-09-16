/**
 * env.ts — `@adhd/environment` wiring (DESIGN.md §6). Deliberately defaults to
 * `global` scope (NOT the generic Environment auto-detect default of
 * project-marker-found ⇒ `project`) — SPEC.md §3 requirement #3/#4: one shared
 * graph spanning every repo on the machine, by default.
 */
import { join } from 'node:path';
import { Environment } from '@adhd/environment';
import type { EnvironmentOptions, EnvironmentSpec, Scope } from '@adhd/environment-base-spec';

export interface BacklogConfig {
  readonly db: { readonly path: string | undefined; readonly busyTimeoutMs: number };
  readonly logging: { readonly level: string };
  /**
   * RAG-SPEC.md §1.6 — the opt-in embedding/vector stack. `enabled` defaults
   * to FALSE: an unconfigured build must behave exactly as it did before RAG
   * existed (every semantic input answers `RagNotConfiguredError`, AC-12), so
   * a host opts IN deliberately and nothing is ever switched on implicitly.
   */
  readonly embedding: { readonly enabled: boolean; readonly provider: string; readonly model: string };
}

export const backlogEnvironmentSpec: EnvironmentSpec<BacklogConfig> = {
  envPrefixOverride: 'ADHD_BACKLOG',
  namespaces: ['production'],
  dirs: {
    data: { kind: 'data' },
    // BUG-CACHE-CWD-001: the apigen extract-stage IR-cache root. `kind:
    // 'cache'` resolves under the same `${HOME}/.adhd/backlog/...` scope
    // root `data` does (`DEFAULT_SHARE_BY_KIND['cache'] === 'shared'`) —
    // NEVER `process.cwd()`. Consumed only via `resolveIrCacheFile` below,
    // always forcing `scope: 'global'` regardless of the caller's own
    // `ADHD_BACKLOG_SCOPE`/`opts.scope` — the IR cache caches backlog's own
    // generated client, not per-repo data, so it must stay at one stable
    // machine-wide location no matter which scope a given invocation
    // resolved its backlog *data* to. See `server.ts`'s `irCacheFile()`.
    cache: { kind: 'cache' },
  },
  files: {
    // Deliberately a DIFFERENT file/dir than agent-mcp's operational db or
    // memory-server's store (~/.memory/memory.db) — no shared database file
    // between unrelated servers, ever (DESIGN.md §12).
    db: { in: 'data', name: 'backlog.db' },
  },
  config: {
    'db.path': {
      type: 'string',
      env: 'ADHD_BACKLOG_DATABASE_PATH',
      description: 'Backlog graph DB path. Unset ⇒ falls back to env.files.db under the resolved scope root.',
    },
    'db.busyTimeoutMs': {
      type: 'integer',
      env: 'ADHD_BACKLOG_DATABASE_BUSY_TIMEOUT_MS',
      default: 5000,
      description:
        'The store adapter\'s `busy_timeout` (ms) each write waits for a contended lock before retrying (DEBT-BACKLOG-CONCURRENCY-BUSY-RETRY-001). ' +
        'Raise this when scaling toward more concurrent agents writing the same global-scope store.',
    },
    'logging.level': {
      type: 'string',
      env: 'ADHD_BACKLOG_LOG_LEVEL',
      default: 'info',
      enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
    },
    'embedding.enabled': {
      type: 'boolean',
      env: 'ADHD_BACKLOG_EMBEDDING_ENABLED',
      default: false,
      description:
        'RAG-SPEC.md §1.6 — opt IN to the semantic/RAG stack. Default FALSE: semantic inputs (filter.semantic, filter.anchor, ' +
        'view:"similar", sort:"relevance", fields:["_vector"]) answer RagNotConfiguredError (AC-12) until this is set. ' +
        'Requires the optionalDependencies @adhd/sox-embedding-provider + @adhd/sox-vector-store to be installed, and a ' +
        'store whose adapter reports capabilities.nativeVectors (turso). Enabling it with any of those missing logs a ' +
        'typed reason and leaves RAG unconfigured — it never crashes startup.',
    },
    'embedding.provider': {
      type: 'string',
      env: 'ADHD_BACKLOG_EMBEDDING_PROVIDER',
      default: 'fastembed',
      description: "Embedding provider type, forwarded verbatim to @adhd/sox-embedding-provider's createEmbeddingProvider ('fastembed' | 'remote').",
    },
    'embedding.model': {
      type: 'string',
      env: 'ADHD_BACKLOG_EMBEDDING_MODEL',
      default: 'bge-base-en-v1.5',
      description:
        'Embedding model id (768-dim bge-base-en-v1.5 by default). RAG-SPEC.md §2.5: the dimensional contract is STRUCTURAL — ' +
        'changing this after items are embedded orphans existing vectors under the old model id rather than silently truncating; ' +
        're-embed via admin(embedding_backfill).',
    },
  },
};

/**
 * Resolves scope per SPEC.md §3 (highest precedence first): explicit option →
 * `ADHD_BACKLOG_SCOPE` → generic `ADHD_ENV_SCOPE` → default `'global'`.
 */
export function resolveBacklogScope(explicit?: Scope): Scope {
  if (explicit) return explicit;
  const fromBacklogVar = process.env['ADHD_BACKLOG_SCOPE'] as Scope | undefined;
  if (fromBacklogVar) return fromBacklogVar;
  const fromGenericVar = process.env['ADHD_ENV_SCOPE'] as Scope | undefined;
  if (fromGenericVar) return fromGenericVar;
  return 'global';
}

/**
 * Options accepted by `buildBacklogEnv`, beyond scope — `adhdRoot`/`cwd`/
 * `instanceId` exist purely for test isolation (constructing an `Environment`
 * rooted at a temp directory instead of the real machine's `~/.adhd`), mirror
 * `EnvironmentOptions`'s own test-isolation fields.
 */
export interface BuildBacklogEnvOptions {
  scope?: Scope;
  adhdRoot?: string;
  cwd?: string;
  instanceId?: string;
}

export function buildBacklogEnv(options: BuildBacklogEnvOptions = {}): Environment<BacklogConfig> {
  const envOptions: EnvironmentOptions = {
    namespace: 'production',
    scope: resolveBacklogScope(options.scope),
  };
  if (options.adhdRoot !== undefined) envOptions.adhdRoot = options.adhdRoot;
  if (options.cwd !== undefined) envOptions.cwd = options.cwd;
  if (options.instanceId !== undefined) envOptions.instanceId = options.instanceId;
  return new Environment<BacklogConfig>('backlog', backlogEnvironmentSpec, envOptions);
}

/**
 * BUG-002: the effective backlog graph DB path. Every store-open site
 * (`cli.ts`'s `runBacklogCli`, `server.ts`'s `startBacklogServer`) must
 * resolve the path through THIS helper — never `env.files.db` directly —
 * or a consumer setting `ADHD_BACKLOG_DATABASE_PATH` silently hits the
 * scope-root file instead of the path they asked for (the env var was
 * declared on `db.path` in `backlogEnvironmentSpec` but nothing consumed
 * it, so a controlled scratch experiment redirected nowhere and opened the
 * production store). Resolution order, matching the FieldSpec cascade the
 * `@adhd/environment` builder implements (config-resolver.ts §2.2):
 *
 *   1. `ADHD_BACKLOG_DATABASE_PATH` (env var → `config.db.path`) — wins;
 *   2. `db.path` from a config file (system/global/project/local layers);
 *   3. fallback: `files.db` — the namespaced `backlog.db` under the resolved
 *      scope root (the declaration's own "Unset ⇒ falls back to env.files.db").
 *
 * Mirrors `agent-mcp`'s `db/client.ts` precedent
 * (`config.db.path ?? files['db']`), with one deliberate divergence: no
 * `path.resolve` wrap here, because `openGraphBacklogStore` treats the
 * literal `':memory:'` as a special in-memory path and `resolve()` would
 * corrupt it into `<cwd>/':memory:'`.
 */
export function resolveBacklogDbPath(env: Environment<BacklogConfig>): string {
  return env.config.db.path ?? env.files.db;
}

/**
 * DESIGN.md §4.4 — the recommended (not enforced) claimant identity shape:
 * `${agentName}:${instanceId}`. Exposed as a plain helper, never baked into
 * `claimItem` itself.
 */
export function suggestClaimantIdentity(agentName: string, instanceId: string): string {
  return `${agentName}:${instanceId}`;
}

/**
 * BUG-CACHE-CWD-001: the effective apigen extract-stage IR-cache file path.
 * Prior to this fix, `server.ts`'s `irCacheFile()` defaulted to
 * `join(process.cwd(), 'tmp', 'apigen', 'ir-cache', 'backlog-client.ir.json')`
 * — a NEW cache (and a NEW `tmp/apigen/ir-cache/` directory) was created in
 * every distinct directory `backlog` was ever invoked from: every repo, every
 * git worktree, and — because `startBacklogServer`'s `opts.cwd` test-override
 * plumbing was sometimes used unintentionally as a live cwd — even
 * `~/.adhd/backlog/production/data/tmp/apigen/ir-cache/`, nested one level
 * inside the live store's own data directory. None of these scattered copies
 * ever saw a cache HIT from any other copy, so every distinct invocation
 * directory paid a full re-extraction — a correctness-neutral but pure
 * performance and disk-hygiene regression (FEAT-002's entire point, undone).
 *
 * Resolution order (highest precedence first), matching `resolveBacklogDbPath`'s
 * own precedence-comment convention:
 *
 *   1. `APIGEN_IR_CACHE_FILE` (explicit escape hatch — tests point this at a
 *      throwaway file; see `ir-cache.integration.spec.ts`) — wins outright.
 *   2. The `cache` dir's resolved path (`kind: 'cache'` → shared, scope
 *      forced to `'global'` — see the `dirs.cache` doc comment above) +
 *      `apigen/ir-cache/backlog-client.ir.json`. Absolute, `process.cwd()`-
 *      independent, and identical across every scope/repo/worktree on this
 *      machine — exactly the fast-path guarantee FEAT-002 designed for.
 *
 * `adhdRoot`/`instanceId` are accepted purely for test isolation (mirrors
 * `buildBacklogEnv`'s own test-isolation fields) — production callers never
 * pass them.
 */
export function resolveIrCacheFile(options: { adhdRoot?: string; instanceId?: string } = {}): string {
  const fromEnv = process.env['APIGEN_IR_CACHE_FILE'];
  if (fromEnv) return fromEnv;
  const envOptions: EnvironmentOptions = { namespace: 'production', scope: 'global' };
  if (options.adhdRoot !== undefined) envOptions.adhdRoot = options.adhdRoot;
  if (options.instanceId !== undefined) envOptions.instanceId = options.instanceId;
  const env = new Environment<BacklogConfig>('backlog', backlogEnvironmentSpec, envOptions);
  return join(env.paths['cache'] as string, 'apigen', 'ir-cache', 'backlog-client.ir.json');
}
