/**
 * env.ts — `@adhd/environment` wiring (DESIGN.md §6). Deliberately defaults to
 * `global` scope (NOT the generic Environment auto-detect default of
 * project-marker-found ⇒ `project`) — SPEC.md §3 requirement #3/#4: one shared
 * graph spanning every repo on the machine, by default.
 */
import { Environment } from '@adhd/environment';
import type { EnvironmentOptions, EnvironmentSpec, Scope } from '@adhd/environment-base-spec';

export interface BacklogConfig {
  readonly db: { readonly path: string | undefined };
  readonly logging: { readonly level: string };
}

export const backlogEnvironmentSpec: EnvironmentSpec<BacklogConfig> = {
  envPrefixOverride: 'ADHD_BACKLOG',
  namespaces: ['production'],
  dirs: {
    data: { kind: 'data' },
  },
  files: {
    // Deliberately a DIFFERENT file/dir than agent-mcp's operational db or
    // memory-server's store (~/.memory/memory.db) — no shared SQLite file
    // between unrelated servers, ever (DESIGN.md §12).
    db: { in: 'data', name: 'backlog.db' },
  },
  config: {
    'db.path': {
      type: 'string',
      env: 'ADHD_BACKLOG_DATABASE_PATH',
      description: 'SQLite backlog-graph DB path. Unset ⇒ falls back to env.files.db under the resolved scope root.',
    },
    'logging.level': {
      type: 'string',
      env: 'ADHD_BACKLOG_LOG_LEVEL',
      default: 'info',
      enum: ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'],
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
 * DESIGN.md §4.4 — the recommended (not enforced) claimant identity shape:
 * `${agentName}:${instanceId}`. Exposed as a plain helper, never baked into
 * `claimItem` itself.
 */
export function suggestClaimantIdentity(agentName: string, instanceId: string): string {
  return `${agentName}:${instanceId}`;
}
