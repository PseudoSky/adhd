// @adhd/agent-compiler — public barrel.
// Export each new store + schema table here as it is added (mirror the shipped
// registry packages: every state that adds a table also extends this barrel).

export { sqlite, db } from './db/client.js';
export { runMigrations } from './db/migrate.js';
export { runMigrationsOn, MIGRATIONS_FOLDER } from './db/migrate-runner.js';
export * from './db/schema.js';

// composition-resolve state: body assembly from agent-registry junction order
export { resolveBody } from './resolve/composition.js';
export type { ResolvedBody, ComponentVersionMap } from './resolve/composition.js';

// tool-header-emit state: platform tool alias resolution from tool_platform_bindings
export { resolveTools } from './resolve/tools.js';
export type { ResolvedTool } from './resolve/tools.js';

// model-and-policy-emit state: model alias + policy constraint resolution
export { resolveModel } from './resolve/model.js';
export { resolvePolicyConstraints } from './resolve/policy.js';
export type { Constraint } from './resolve/policy.js';

// platform-markdown-emit state: emit functions + top-level compileAgent orchestrator
export { emitYamlFrontmatter } from './emit/markdown.js';
export type { YamlFrontmatterInput } from './emit/markdown.js';
export { emitJsonObject } from './emit/json.js';
export type { JsonObjectInput, StructuredTool } from './emit/json.js';
export { compileAgent } from './compile.js';
export type { CompileInput, CompiledAgent } from './compile.js';
