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

// Policy library seeder — idempotent population of policy_types + policy_templates.
export { seed, POLICY_TYPES, POLICY_TEMPLATES } from "./seed/index.js";

// Rate-policy enforcement plugin — mirrors @adhd/agent-mcp-budget plugin shape.
// Registers a throws-propagating handler on "pre:model_request" to enforce
// rate (model-call count) limits from policy template rules + override_config.
export { createPlugin, configSchema } from "./plugin/index.js";
export type { RatePolicyConfig } from "./plugin/index.js";
export { evaluateRatePolicy, makeRatePolicyError } from "./plugin/rate-policy.js";
export type { RatePolicyRules } from "./plugin/rate-policy.js";
export { createPlugin as default } from "./plugin/index.js";
