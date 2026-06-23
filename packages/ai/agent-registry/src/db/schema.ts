// eslint-disable-next-line @typescript-eslint/no-unused-vars
import {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    index,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    integer,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sqliteTable,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    text
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// @adhd/agent-registry — table prefix: registry_
//
// Decision 1 (decisions.md): all tables in this package use the `registry_`
// prefix. Cross-package FKs are logical only (plain text columns, no
// .references() across prefixes). In-package FKs use .references() normally.
//
// Tables are added by later plan states:
//   - prompt-types-and-components  → registry_prompt_types, registry_prompt_components
//   - agents-table                 → registry_agents
//   - composition-junction         → registry_agent_components
//   - usecase-and-context-rules    → registry_context_rules
//   - composed-prompts             → registry_composed_prompts
// ──────────────────────────────────────────────
