import {
    index,
    integer,
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
