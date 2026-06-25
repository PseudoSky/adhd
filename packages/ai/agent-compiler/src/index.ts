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
