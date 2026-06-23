/**
 * Idempotent seeder for the full tool catalog.
 *
 * seed(db) inserts tool types → platforms → tools → bindings in FK order.
 * Every insert uses onConflictDoNothing() so running twice is a safe no-op
 * and never bumps row versions. [inv:version-retained]
 *
 * Usage:
 *   import Database from 'better-sqlite3';
 *   import { drizzle } from 'drizzle-orm/better-sqlite3';
 *   import { runMigrationsOn } from '@adhd/agent-tool-registry';
 *   import { seed } from '@adhd/agent-tool-registry/seed';
 *
 *   const sqlite = new Database('/path/to/registry.db');
 *   const db = drizzle(sqlite);
 *   runMigrationsOn(sqlite, db);
 *   seed(db);
 */

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { toolPlatformBindingsTable, toolsTable } from "../db/schema.js";
import { BindingStore } from "../store/binding-store.js";
import { ToolStore } from "../store/tool-store.js";
import { BINDING_SEEDS } from "./bindings.js";
import { PLATFORM_SEEDS } from "./platforms.js";
import { TOOL_SEEDS } from "./tools.js";
import { TOOL_TYPE_SEEDS } from "./tool-types.js";

/**
 * Populate the tool catalog from canonical seed data.
 *
 * Idempotent: safe to call on a DB that already has the seed rows.
 * Re-running produces zero new rows and zero errors.
 *
 * FK insertion order: tool_types → platforms → tools → tool_platform_bindings
 */
export function seed(db: BetterSQLite3Database<Record<string, never>>): void {
    const toolStore = new ToolStore(db);
    const bindingStore = new BindingStore(db);

    // 1. tool_types (no FK dependencies)
    //    ToolStore.seedToolType already uses onConflictDoNothing.
    for (const tt of TOOL_TYPE_SEEDS) {
        toolStore.seedToolType(tt);
    }

    // 2. platforms (no FK dependencies)
    //    BindingStore.seedPlatform already uses onConflictDoNothing.
    for (const p of PLATFORM_SEEDS) {
        bindingStore.seedPlatform(p);
    }

    // 3. tools (FK → tool_types)
    //    Use onConflictDoNothing for idempotent upsert semantics.
    for (const t of TOOL_SEEDS) {
        db.insert(toolsTable)
            .values({
                name: t.name,
                type: t.type,
                description: t.description,
                version: 1,
                requiresApproval: t.requiresApproval,
                isDestructive: t.isDestructive,
                dependencyToolIds: [],
                capabilities: [],
            })
            .onConflictDoNothing()
            .run();
    }

    // 4. tool_platform_bindings (FK → tools + platforms)
    //    onConflictDoNothing ignores any (tool_name, platform_id) that already exists.
    for (const b of BINDING_SEEDS) {
        db.insert(toolPlatformBindingsTable)
            .values({
                toolName: b.toolName,
                platformId: b.platformId,
                platformToolName: b.platformToolName,
                availability: b.availability,
                requiresMcp: b.requiresMcp ?? false,
                invocationNote: b.invocationNote ?? null,
            })
            .onConflictDoNothing()
            .run();
    }
}
