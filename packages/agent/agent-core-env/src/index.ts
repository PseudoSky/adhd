// @adhd/agent-core-env — public barrel.
//
// Shared @adhd/environment-backed resolver for the agent-registry package
// family's one shared SQLite file. See
// docs/environment/agent-base-env/DESIGN.md and
// packages/agent/agent-generator-plugin/REGISTRY-PACKAGE-RULES.md §2.

export { resolveRegistryDbPath } from './resolve-registry-db-path.js';
export type { ResolveRegistryDbPathOpts } from './resolve-registry-db-path.js';

// ADR-0001: the adapter-backed registry store is the sanctioned open path.
// `openRegistryDb` (better-sqlite3) remains only for the not-yet-migrated
// Drizzle-based consumers and is retired as the D4 sequence reaches them.
export { openRegistryStore } from './open-registry-store.js';
export type { OpenRegistryStoreOpts } from './open-registry-store.js';

export {
  withImmediateRetry,
  isBusyContention,
  DEFAULT_BUSY_MAX_ATTEMPTS,
  DEFAULT_BUSY_RETRY_BASE_DELAY_MS,
  DEFAULT_BUSY_RETRY_MAX_DELAY_MS,
  DEFAULT_REGISTRY_BUSY_TIMEOUT_MS,
} from './store-transaction.js';
export type { BusyRetryConfig } from './store-transaction.js';

export { openRegistryDb } from './open-registry-db.js';
export type { OpenRegistryDbOpts, RegistryDbHandle } from './open-registry-db.js';

export {
  applyLockingPragmas,
  DEFAULT_BUSY_TIMEOUT_MS,
} from './sqlite-locking.js';
export type { ISqliteConn, LockingPragmaOpts } from './sqlite-locking.js';

export { agentRegistryEnvironmentSpec, AGENT_REGISTRY_PROJECT_ID } from './spec.js';
export type { AgentRegistryEnvConfig } from './spec.js';
