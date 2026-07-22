/**
 * `resolve-registry-db-path.ts` — resolves the ONE canonical, shared
 * SQLite file path for the agent-registry package family
 * (`agent-store-prompts`/`-tools`, `agent-core-policy`/`-provider`,
 * `agent-engine-compiler`).
 *
 * Synchronous, live in-memory resolve — no I/O prerequisite (matches
 * `@adhd/environment`'s "live in-memory resolve" contract, `ARCHITECTURE.md`
 * §2.1) — so it's safely callable from `drizzle.config.ts`, which cannot
 * `await`. It MUST NOT auto-migrate/copy any file; it only computes a path.
 */
import type { Scope } from '@adhd/environment';
import { Environment } from '@adhd/environment';

import { agentRegistryEnvironmentSpec } from './spec.js';

export interface ResolveRegistryDbPathOpts {
  /** Explicit override — highest precedence. Callers (e.g. tests) that know
   *  exactly which file they want should pass this instead of relying on
   *  env vars. */
  registryDbPath?: string;
  /** Forces the active `Environment` scope, bypassing the pinned `'global'`
   *  default on `dirs.data` (see `spec.ts`) — equivalent to setting
   *  `ADHD_ENV_SCOPE` for just this call. */
  scope?: Scope;
}

/**
 * Resolves the registry database path with the following precedence
 * (highest → lowest), exactly as specified in
 * `docs/environment/agent-base-env/DESIGN.md` Decision 4:
 *
 *   1. `opts.registryDbPath` — explicit caller-supplied override.
 *   2. `ADHD_AGENT_REGISTRY_DB_PATH` — agent-mcp's current,
 *      `ADHD_AGENT_*`-prefixed convention.
 *   3. `REGISTRY_DATABASE_PATH` — the more specific of the two legacy
 *      family env-var names (`agent-store-prompts`/`agent-engine-compiler`
 *      `db/client.ts`).
 *   4. `DATABASE_PATH` — the generic legacy name (all 5 clients accepted it
 *      as a fallback).
 *   5. The `@adhd/environment`-resolved canonical default —
 *      `~/.adhd/agent-registry/production/data/registry.db` (or under
 *      `ADHD_ENV_SCOPE=project`'s project root, or `opts.scope`).
 *
 * This precedence lives as explicit code (not a single `FieldSpec.env`
 * mapping) because 3 independent legacy env-var names must all keep
 * resolving — `FieldSpec` only carries one explicit env name per field.
 *
 * Never auto-migrates or copies any file that happens to already exist at
 * a legacy path — it only computes where the canonical file should live.
 */
export function resolveRegistryDbPath(opts: ResolveRegistryDbPathOpts = {}): string {
  if (opts.registryDbPath) {
    return opts.registryDbPath;
  }

  const fromAdhdAgentEnv = process.env['ADHD_AGENT_REGISTRY_DB_PATH'];
  if (fromAdhdAgentEnv) {
    return fromAdhdAgentEnv;
  }

  const fromRegistryDatabasePath = process.env['REGISTRY_DATABASE_PATH'];
  if (fromRegistryDatabasePath) {
    return fromRegistryDatabasePath;
  }

  const fromDatabasePath = process.env['DATABASE_PATH'];
  if (fromDatabasePath) {
    return fromDatabasePath;
  }

  const env = new Environment(
    'agent-registry',
    agentRegistryEnvironmentSpec,
    opts.scope ? { scope: opts.scope } : {},
  );
  return env.files['registry'];
}
