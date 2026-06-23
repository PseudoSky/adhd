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

// Agent↔policy junction store + domain types (including category inheritance)
export {
    AgentPolicyStore,
    AgentPolicyError,
    resolveEffectiveRules,
} from "./store/agent-policy-store.js";
export type {
    AgentPolicyRow,
    AgentPolicyAttachInput,
    AgentPolicyErrorCode,
    CategoryPolicyAttachInput,
    CategoryPolicyRow,
    AgentCategoryInput,
} from "./store/agent-policy-store.js";
