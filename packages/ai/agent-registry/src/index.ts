// @adhd/agent-registry — public barrel
// Each subsequent plan state adds exports here as tables and stores are added.

export { sqlite, db } from "./db/client.js";
export { runMigrations } from "./db/migrate.js";
export { runMigrationsOn, MIGRATIONS_FOLDER } from "./db/migrate-runner.js";
export * from "./db/schema.js";

// lookup-and-component-schema state: prompt types + components store
export { ComponentStore } from "./store/component-store.js";
export type {
    PromptType,
    PromptComponent,
    ComponentCreateInput,
    ComponentListFilter,
} from "./store/component-store.js";
export { ComponentError } from "./store/component-store.js";

// agent-and-taxonomy-schema state: agents + taxonomy_categories store
export { AgentStore, TaxonomyStore } from "./store/agent-store.js";
export type {
    Agent,
    AgentCreateInput,
    AgentUpdateInput,
    AgentListFilter,
    AgentStatus,
    AgentPosture,
    TaxonomyCategory,
    TaxonomyCategoryCreateInput,
} from "./store/agent-store.js";
export { AgentError } from "./store/agent-store.js";
