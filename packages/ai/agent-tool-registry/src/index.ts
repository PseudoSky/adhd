// Public barrel — every store and schema table added by subsequent plan states
// should be re-exported here.

export { db, sqlite } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export type { SchemaTable } from "./db/schema.js";
