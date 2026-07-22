/**
 * `spec.ts` — the shared `EnvironmentSpec` for the agent-registry package
 * family's ONE shared SQLite file (`registry.db`).
 *
 * See `docs/environment/agent-base-env/DESIGN.md` Decision 4:
 *   - Logical project id `'agent-registry'` (NOT `'agent-mcp'` — this is a
 *     different, shared catalog, not agent-mcp's own operational store).
 *   - `namespaces: ['production']` + `dirs.data`/`files.registry` resolve the
 *     zero-config canonical default to
 *     `~/.adhd/agent-registry/production/data/registry.db`.
 *   - `dirs.data.scope` is PINNED to `'global'` (not left to auto-detect
 *     project vs. global from the invoking cwd's `.git`/`.adhd` marker) —
 *     this is a single shared catalog that the server, CLIs, seed scripts,
 *     and drizzle-kit must all agree on regardless of the invoking cwd. An
 *     explicit `ADHD_ENV_SCOPE=project` (or `EnvironmentOptions.scope`)
 *     still overrides it when real isolation (dev/CI/tests) is wanted.
 *
 * `config` is empty — this package has no typed config fields of its own.
 * The 3 legacy env-var names (`ADHD_AGENT_REGISTRY_DB_PATH`,
 * `REGISTRY_DATABASE_PATH`, `DATABASE_PATH`) are NOT declared as `FieldSpec`s
 * here because `FieldSpec` carries exactly one explicit env name and all 3
 * independent legacy names must keep working — that precedence is
 * implemented as explicit code in `resolveRegistryDbPath()` instead (see
 * `resolve-registry-db-path.ts`).
 */
import type { EnvironmentSpec } from '@adhd/environment';

/** The resolved, nested `env.config` shape for the `'agent-registry'`
 *  `Environment` instance. Empty — see module doc above. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface AgentRegistryEnvConfig {}

/** Logical `Environment` project id shared by every registry-family package. */
export const AGENT_REGISTRY_PROJECT_ID = 'agent-registry';

export const agentRegistryEnvironmentSpec: EnvironmentSpec<AgentRegistryEnvConfig> = {
  namespaces: ['production'],
  dirs: {
    data: { kind: 'data', scope: 'global' },
  },
  files: {
    registry: { in: 'data', name: 'registry.db' },
  },
  config: {},
};
