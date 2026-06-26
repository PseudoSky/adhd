/**
 * Canonical tool-platform binding seed data.
 *
 * Source of truth: docs/plan/agent-registry/SEED_DATA.md §6
 * — Platform Bindings (claude_code) and Platform Bindings (claude_api).
 *
 * Each row maps (tool_name, platform_id) → platform_tool_name.
 * availability is one of: available | restricted | unavailable | requires_permission
 * Tools absent from a platform are seeded as availability: "unavailable".
 */

export interface BindingSeedRow {
    toolName: string;
    platformId: string;
    platformToolName: string;
    availability: string;
    requiresMcp?: boolean;
    invocationNote?: string | null;
}

/** Platform bindings for claude_code (PascalCase built-in tool names). */
const CLAUDE_CODE_BINDINGS: BindingSeedRow[] = [
    { toolName: "file_read",          platformId: "claude_code", platformToolName: "Read",                 availability: "available" },
    { toolName: "file_write",         platformId: "claude_code", platformToolName: "Write",                availability: "available" },
    { toolName: "file_edit",          platformId: "claude_code", platformToolName: "Edit",                 availability: "available" },
    { toolName: "file_glob",          platformId: "claude_code", platformToolName: "Glob",                 availability: "available" },
    { toolName: "file_grep",          platformId: "claude_code", platformToolName: "Grep",                 availability: "available" },
    { toolName: "shell_exec",         platformId: "claude_code", platformToolName: "Bash",                 availability: "available" },
    { toolName: "web_fetch",          platformId: "claude_code", platformToolName: "WebFetch",             availability: "available" },
    { toolName: "web_search",         platformId: "claude_code", platformToolName: "WebSearch",            availability: "available" },
    { toolName: "mcp_list_resources", platformId: "claude_code", platformToolName: "ListMcpResourcesTool", availability: "available" },
    { toolName: "mcp_read_resource",  platformId: "claude_code", platformToolName: "ReadMcpResourceTool",  availability: "available" },
    { toolName: "mcp_wait",           platformId: "claude_code", platformToolName: "WaitForMcpServers",    availability: "available" },
    { toolName: "human_input",        platformId: "claude_code", platformToolName: "AskUserQuestion",      availability: "available" },
    { toolName: "process_monitor",    platformId: "claude_code", platformToolName: "Monitor",              availability: "available" },
    { toolName: "code_analysis",      platformId: "claude_code", platformToolName: "LSP",                  availability: "available" },
    { toolName: "notebook_edit",      platformId: "claude_code", platformToolName: "NotebookEdit",         availability: "available" },
];

/**
 * Platform bindings for claude_api (structured API tool definitions).
 * Tools without a built-in equivalent are seeded as unavailable.
 */
const CLAUDE_API_BINDINGS: BindingSeedRow[] = [
    { toolName: "file_read",   platformId: "claude_api", platformToolName: "read_file",   availability: "available",   invocationNote: "computer-use or custom tool" },
    { toolName: "file_write",  platformId: "claude_api", platformToolName: "write_file",  availability: "available" },
    { toolName: "shell_exec",  platformId: "claude_api", platformToolName: "bash",        availability: "available" },
    { toolName: "web_fetch",   platformId: "claude_api", platformToolName: "web_fetch",   availability: "available" },
    { toolName: "web_search",  platformId: "claude_api", platformToolName: "web_search",  availability: "available" },
    { toolName: "human_input", platformId: "claude_api", platformToolName: "",            availability: "unavailable", invocationNote: "No built-in HITL on raw API" },
    { toolName: "code_analysis", platformId: "claude_api", platformToolName: "",          availability: "unavailable", invocationNote: "No built-in LSP on raw API" },
    { toolName: "mcp_wait",    platformId: "claude_api", platformToolName: "",            availability: "unavailable", invocationNote: "Not applicable" },
];

/** All canonical platform bindings shipped with the registry. */
export const BINDING_SEEDS: BindingSeedRow[] = [
    ...CLAUDE_CODE_BINDINGS,
    ...CLAUDE_API_BINDINGS,
];
