/**
 * Canonical tool-type seed data.
 *
 * Source of truth: docs/plan/agent-registry/SEED_DATA.md §2
 *
 * tool_types uses a text PK (never a SQL enum) so new types are added by
 * seeding a row, not by migrating a schema. [inv:lookup-not-enum]
 */

export interface ToolTypeSeedRow {
    slug: string;
    description: string;
}

/** All 8 canonical tool types shipped with the registry. */
export const TOOL_TYPE_SEEDS: ToolTypeSeedRow[] = [
    { slug: "io",       description: "File system read, write, edit, search operations" },
    { slug: "compute",  description: "Shell execution, script running, process management" },
    { slug: "network",  description: "Web fetch, HTTP requests, web search" },
    { slug: "memory",   description: "MCP resource access, cross-agent recall, tag operations" },
    { slug: "ui",       description: "Human input requests, interactive prompts" },
    { slug: "meta",     description: "MCP server lifecycle, server waiting, platform utilities" },
    { slug: "lsp",      description: "Language server protocol: go-to-definition, diagnostics, hover" },
    { slug: "notebook", description: "Jupyter notebook cell operations" },
];
