/**
 * Canonical platform seed data.
 *
 * Source of truth: docs/plan/agent-registry/SEED_DATA.md §5
 *
 * header_format is one of: yaml_frontmatter | json_object | none
 * supports_tool_selection controls whether the compiler emits a tools: header.
 */

export interface PlatformSeedRow {
    id: string;
    name: string;
    headerFormat: string;
    supportsToolSelection: boolean;
}

/** All 6 canonical platforms shipped with the registry. */
export const PLATFORM_SEEDS: PlatformSeedRow[] = [
    {
        id: "claude_code",
        name: "Claude Code CLI",
        headerFormat: "yaml_frontmatter",
        supportsToolSelection: true,
    },
    {
        id: "claude_api",
        name: "Anthropic Claude API",
        headerFormat: "json_object",
        supportsToolSelection: true,
    },
    {
        id: "openai",
        name: "OpenAI API",
        headerFormat: "json_object",
        supportsToolSelection: true,
    },
    {
        id: "bedrock",
        name: "AWS Bedrock",
        headerFormat: "json_object",
        supportsToolSelection: true,
    },
    {
        id: "cursor",
        name: "Cursor IDE",
        headerFormat: "none",
        supportsToolSelection: false,
    },
    {
        id: "vscode",
        name: "VS Code Extension",
        headerFormat: "none",
        supportsToolSelection: false,
    },
];
