// @adhd/agent-policy — public barrel
// Policy engine with SQLite/Drizzle persistence.
// Tables, stores, and the enforcement plugin are exported here as they are
// added by subsequent plan states (policy-design, policy-store, etc.).

export { db, sqlite } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export * from "./db/schema.js";

// Policy template store + domain types
export {
    PolicyTemplateStore,
    PolicyError,
} from "./store/policy-template-store.js";
export type {
    PolicyTemplate,
    PolicyTemplateCreateInput,
    PolicyErrorCode,
} from "./store/policy-template-store.js";
