// @adhd/agent-core-env — public barrel.
//
// Shared @adhd/environment-backed resolver for the agent-registry package
// family's one shared SQLite file. See
// docs/environment/agent-base-env/DESIGN.md and
// packages/agent/agent-generator-plugin/REGISTRY-PACKAGE-RULES.md §2.

export { resolveRegistryDbPath } from './resolve-registry-db-path.js';
export type { ResolveRegistryDbPathOpts } from './resolve-registry-db-path.js';

export { openRegistryDb } from './open-registry-db.js';
export type { OpenRegistryDbOpts, RegistryDbHandle } from './open-registry-db.js';

export { agentRegistryEnvironmentSpec, AGENT_REGISTRY_PROJECT_ID } from './spec.js';
export type { AgentRegistryEnvConfig } from './spec.js';
