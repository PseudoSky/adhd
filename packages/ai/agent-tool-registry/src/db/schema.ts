import {
    index,
    integer,
    primaryKey,
    sqliteTable,
    text
} from "drizzle-orm/sqlite-core";

// ──────────────────────────────────────────────
// tool_types — seeded text-PK lookup table
//
// [inv:lookup-not-enum]: this MUST remain a sqliteTable with a text PK.
// Never use a SQL enum or a drizzle enum() here — a new tool type is
// added by seeding a row, no migration required.
// Seeded slugs: io | compute | network | memory | ui | meta | lsp | notebook
// ──────────────────────────────────────────────
export const toolTypesTable = sqliteTable("tool_types", {
    slug: text("slug").primaryKey(),
    description: text("description").notNull(),
});

// ──────────────────────────────────────────────
// tools — canonical, platform-independent agent capabilities
//
// Keyed by canonical name (e.g. file_read, shell_exec, web_fetch).
// type FK → tool_types.slug (within-package FK; no cross-package FK).
// [inv:version-retained]: bumping version never deletes the prior row.
// ──────────────────────────────────────────────
export const toolsTable = sqliteTable(
    "tools",
    {
        name: text("name").primaryKey(),
        type: text("type")
            .notNull()
            .references(() => toolTypesTable.slug),
        description: text("description").notNull(),
        version: integer("version").notNull().default(1),
        // Boolean flags stored as SQLite integers (mode:'boolean')
        requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
        isDestructive: integer("is_destructive", { mode: "boolean" }).notNull().default(false),
        // JSON arrays stored as text (mode:'json')
        dependencyToolIds: text("dependency_tool_ids", { mode: "json" })
            .$type<string[]>()
            .notNull()
            .default([]),
        capabilities: text("capabilities", { mode: "json" })
            .$type<string[]>()
            .notNull()
            .default([]),
    },
    (table) => [
        index("idx_tools_type").on(table.type),
    ]
);

// ──────────────────────────────────────────────
// platforms — runtime environments an agent deploys to
//
// [def:platform]: keyed by id (e.g. claude_code, claude_api, openai, bedrock,
// cursor, vscode). header_format is a plain text column seeded with one of:
// yaml_frontmatter | json_object | none  — [inv:lookup-not-enum] applies here
// too: never a SQL enum. supports_tool_selection stored as SQLite integer
// with mode:'boolean'.
// ──────────────────────────────────────────────
export const platformsTable = sqliteTable("platforms", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // plain text column: yaml_frontmatter | json_object | none
    headerFormat: text("header_format").notNull(),
    supportsToolSelection: integer("supports_tool_selection", { mode: "boolean" }).notNull().default(false),
});

// ──────────────────────────────────────────────
// tool_platform_bindings — per-platform alias for each canonical tool
//
// [def:binding]: PK is (tool_name, platform_id). Both FKs are within-package
// ([inv:no-cross-pkg-fk]). availability is a plain text column:
// available | restricted | unavailable | requires_permission.
// invocation_note is nullable (e.g. "requires --chrome").
// ──────────────────────────────────────────────
export const toolPlatformBindingsTable = sqliteTable(
    "tool_platform_bindings",
    {
        toolName: text("tool_name")
            .notNull()
            .references(() => toolsTable.name),
        platformId: text("platform_id")
            .notNull()
            .references(() => platformsTable.id),
        // The name this tool is known by on this platform (e.g. "Bash", "bash_tool")
        platformToolName: text("platform_tool_name").notNull(),
        // plain text column: available | restricted | unavailable | requires_permission
        availability: text("availability").notNull(),
        requiresMcp: integer("requires_mcp", { mode: "boolean" }).notNull().default(false),
        // nullable: e.g. "requires --chrome"
        invocationNote: text("invocation_note"),
    },
    (table) => [
        primaryKey({ columns: [table.toolName, table.platformId] }),
        index("idx_bindings_platform").on(table.platformId),
    ]
);
