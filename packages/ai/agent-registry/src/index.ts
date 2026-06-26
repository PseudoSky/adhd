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

// composition-junction state: agent_components junction + CompositionStore
export { CompositionStore, CompositionError, evaluateCondition } from "./store/composition-store.js";
export type {
    CompositionContext,
    ResolvedComponent,
} from "./store/composition-store.js";

// usecase-and-context-rules state: use_cases, component_usage, context_rules + UseCaseStore
export { UseCaseStore, UseCaseError } from "./store/usecase-store.js";
export type {
    UseCase,
    UseCaseCreateInput,
    ComponentUsageRow,
    ContextRule,
    ContextRuleCreateInput,
} from "./store/usecase-store.js";

// composed-prompt-cache state: composed_prompts table + ComposedPromptStore + contextHash helper
export { ComposedPromptStore, ComposedPromptError, contextHash } from "./store/composed-prompt-store.js";
export type {
    ComposedPrompt,
    ComposedPromptWriteInput,
} from "./store/composed-prompt-store.js";

// seed-and-roundtrip state: idempotent DB seed function + seed data arrays
export { seed } from "./seed/index.js";
export { PROMPT_TYPES } from "./seed/prompt-types.js";
export { SEED_COMPONENTS } from "./seed/components.js";
export type { SeedComponent } from "./seed/components.js";
