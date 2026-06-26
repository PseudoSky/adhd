/**
 * Canonical tool seed data.
 *
 * Source of truth: docs/plan/agent-registry/SEED_DATA.md §6 — Tool Registry table.
 *
 * Each row is a canonical, platform-independent agent capability.
 * The type FK references tool_types.slug — all types must be seeded first.
 */

export interface ToolSeedRow {
    name: string;
    type: string;
    description: string;
    requiresApproval: boolean;
    isDestructive: boolean;
}

/** All 15 canonical tools shipped with the registry. */
export const TOOL_SEEDS: ToolSeedRow[] = [
    {
        name: "file_read",
        type: "io",
        description: "Read file contents from the filesystem",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "file_write",
        type: "io",
        description: "Write or overwrite a file",
        requiresApproval: false,
        isDestructive: true,
    },
    {
        name: "file_edit",
        type: "io",
        description: "Apply targeted string replacements to a file",
        requiresApproval: false,
        isDestructive: true,
    },
    {
        name: "file_glob",
        type: "io",
        description: "Find files matching a glob pattern",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "file_grep",
        type: "io",
        description: "Search file contents with regex",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "shell_exec",
        type: "compute",
        description: "Execute a shell command",
        requiresApproval: true,
        isDestructive: true,
    },
    {
        name: "web_fetch",
        type: "network",
        description: "Fetch content from a URL",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "web_search",
        type: "network",
        description: "Run a web search query",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "mcp_list_resources",
        type: "memory",
        description: "List available MCP server resources",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "mcp_read_resource",
        type: "memory",
        description: "Read a specific MCP resource by URI",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "mcp_wait",
        type: "meta",
        description: "Block until MCP servers are ready",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "human_input",
        type: "ui",
        description: "Request input from the human operator",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "process_monitor",
        type: "compute",
        description: "Monitor a background process for output",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "code_analysis",
        type: "lsp",
        description: "LSP diagnostics, definitions, hover info",
        requiresApproval: false,
        isDestructive: false,
    },
    {
        name: "notebook_edit",
        type: "notebook",
        description: "Edit a Jupyter notebook cell",
        requiresApproval: false,
        isDestructive: true,
    },
];
