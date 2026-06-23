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

import { promptComponentsTable } from "../db/schema.js";

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

    // ── 2. Prompt components ───────────────────────────────────────────────────
    //
    // registry_prompt_components has no UNIQUE constraint on (slug, version) —
    // only a regular index — so ON CONFLICT DO NOTHING would not fire.  Instead
    // we read-before-write: if a row with (slug, version) already exists we skip
    // the insert entirely.  This is safe for the seed use-case: seed data carries
    // the exact canonical version from SEED_DATA.md, so we only need to check
    // whether that precise row is already present.
    //
    // [inv:version-retained] — seed never calls ComponentStore.version(); it only
    // inserts if the (slug, version) pair is absent.
    const now = new Date().toISOString();

    for (const component of SEED_COMPONENTS) {
        const existing = db
            .select({ slug: promptComponentsTable.slug })
            .from(promptComponentsTable)
            .where(
                and(
                    eq(promptComponentsTable.slug, component.slug),
                    eq(promptComponentsTable.version, component.version)
                )
            )
            .get();

        if (existing) {
            // Row already seeded — skip; never overwrite content on re-seed.
            continue;
        }

        db
            .insert(promptComponentsTable)
            .values({
                slug: component.slug,
                type: component.type,
                version: component.version,
                content: component.content,
                isShared: component.isShared,
                createdAt: now,
                updatedAt: now,
            })
            .run();
    }
}
