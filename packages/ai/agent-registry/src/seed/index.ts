/**
 * seed/index.ts
 *
 * Idempotent seed function for @adhd/agent-registry.
 *
 * Inserts all system prompt types and shared components into the given DB.
 * Running `seed(db)` twice is a NO-OP: both inserts use ON CONFLICT DO NOTHING
 * (via ComponentStore.upsertType and direct INSERT OR IGNORE for components),
 * so row counts and versions are never bumped on re-seed.
 *
 * [inv:version-retained] — seed never calls ComponentStore.version(); it only
 * calls create() for new slugs. ON CONFLICT DO NOTHING prevents duplicate writes.
 *
 * Usage:
 *   import { seed } from '@adhd/agent-registry/seed';
 *   seed(db);  // safe to call on every startup
 */

import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { ComponentStore } from "../store/component-store.js";
import { PROMPT_TYPES } from "./prompt-types.js";
import { SEED_COMPONENTS } from "./components.js";

import { componentsTable, componentVersionsTable } from "../db/schema.js";

/**
 * Seed all system prompt types and shared components.
 *
 * Idempotent: safe to call on every application startup.
 * Second and subsequent calls are no-ops for all rows already present.
 *
 * @param db - An open Drizzle BetterSQLite3 database with migrations already run.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function seed(db: BetterSQLite3Database<any>): void {
    const store = new ComponentStore(db);

    // ── 1. Prompt types ────────────────────────────────────────────────────────
    //
    // ComponentStore.upsertType uses ON CONFLICT DO NOTHING on the TEXT PRIMARY KEY
    // of registry_prompt_types.slug, so this is genuinely idempotent.
    for (const type of PROMPT_TYPES) {
        store.upsertType(type);
    }

    // ── 2. Prompt components (head/version split, Decision 5) ───────────────────
    //
    // Each seed entry materializes as a registry_components head identity row plus a
    // registry_component_versions history row at the canonical seed version.
    //
    // Idempotency without overwriting (read-before-write per table):
    //   - head row: insert only if the slug has no registry_components row yet.
    //   - version row: insert only if that exact (slug, version) is absent. The real
    //     UNIQUE(slug, version) index would otherwise reject a duplicate, but we skip
    //     proactively so re-seed is a clean no-op (never bumps version).
    //
    // [inv:version-retained] — seed never calls ComponentStore.version(); it only
    // inserts rows that are absent.
    const now = new Date().toISOString();

    for (const component of SEED_COMPONENTS) {
        // Head identity row — insert once per slug.
        const head = db
            .select({ slug: componentsTable.slug })
            .from(componentsTable)
            .where(eq(componentsTable.slug, component.slug))
            .get();

        if (!head) {
            db
                .insert(componentsTable)
                .values({
                    slug: component.slug,
                    type: component.type,
                    isShared: component.isShared,
                    createdAt: now,
                })
                .run();
        }

        // Version history row — insert only if this exact (slug, version) is absent.
        const existingVersion = db
            .select({ versionId: componentVersionsTable.versionId })
            .from(componentVersionsTable)
            .where(
                and(
                    eq(componentVersionsTable.slug, component.slug),
                    eq(componentVersionsTable.version, component.version)
                )
            )
            .get();

        if (existingVersion) {
            // Row already seeded — skip; never overwrite content on re-seed.
            continue;
        }

        db
            .insert(componentVersionsTable)
            .values({
                slug: component.slug,
                version: component.version,
                content: component.content,
                createdAt: now,
                updatedAt: now,
            })
            .run();
    }
}
