/**
 * agent-store.test.ts
 *
 * Drives AgentStore and TaxonomyStore against a REAL on-disk SQLite file
 * (never :memory:). Proves:
 *   [agent-and-taxonomy-schema.1] agents table with slug PK, status,
 *     model_hint, taxonomy_category
 *   [agent-and-taxonomy-schema.2] taxonomy_categories table with ordering
 *   [agent-and-taxonomy-schema.3] agent-store test passes
 *
 * Key invariants exercised:
 *   - create agent in a category; reopen and read back (persistence)
 *     [inv:reopen-proves-persistence] (contexts/_shared.md)
 *   - listCategories() returns position-ordered results
 *   - list(category) filters correctly
 *
 * Gate on the vitest EXIT CODE, not stdout — per project memory
 * feedback_plan_execution_pitfalls.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import * as schema from "../db/schema.js";
import { AgentStore, TaxonomyStore, AgentError } from "../store/agent-store.js";

// ── helpers ───────────────────────────────────────────────────────────────────

const MIGRATIONS_FOLDER = path.resolve(
    new URL("../../drizzle", import.meta.url).pathname
);

interface OpenResult {
    conn: Database.Database;
    agentStore: AgentStore;
    taxonomyStore: TaxonomyStore;
}

/** Open a fresh DB handle, run ALL migrations, return stores. */
function openDb(dbPath: string): OpenResult {
    const conn = new Database(dbPath);
    conn.pragma("journal_mode = WAL");
    conn.pragma("foreign_keys = OFF"); // FK-safe migration runner pattern
    const db = drizzle(conn, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    conn.pragma("foreign_keys = ON");
    return {
        conn,
        agentStore: new AgentStore(db),
        taxonomyStore: new TaxonomyStore(db),
    };
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe("AgentStore + TaxonomyStore", () => {
    let dbPath: string;
    let conn: Database.Database;
    let agentStore: AgentStore;
    let taxonomyStore: TaxonomyStore;

    beforeAll(() => {
        // Real on-disk temp file — never :memory: [inv:real-db-tests]
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-agent-test-"));
        dbPath = path.join(tmpDir, "test-agents.db");

        const opened = openDb(dbPath);
        conn = opened.conn;
        agentStore = opened.agentStore;
        taxonomyStore = opened.taxonomyStore;
    });

    afterAll(() => {
        // Close before unlinking — avoids WAL teardown race
        conn.close();
        try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-wal"); } catch { /* ignore */ }
        try { fs.unlinkSync(dbPath + "-shm"); } catch { /* ignore */ }
    });

    // ── [agent-and-taxonomy-schema.2] taxonomy_categories table + ordering ────

    describe("TaxonomyStore — taxonomy_categories table with ordering", () => {
        it("creates a top-level category and reads it back via listCategories", () => {
            const cat = taxonomyStore.createCategory({
                slug: "infrastructure",
                name: "Infrastructure",
                description: "Infrastructure and ops agents",
                position: 10,
            });

            expect(cat.slug).toBe("infrastructure");
            expect(cat.name).toBe("Infrastructure");
            expect(cat.position).toBe(10);
            expect(cat.parentSlug).toBeNull();

            const list = taxonomyStore.listCategories();
            const found = list.find((c) => c.slug === "infrastructure");
            expect(found).toBeDefined();
            expect(found!.position).toBe(10);
        });

        it("creates a subcategory with a parent_slug self-FK", () => {
            // Parent must exist before inserting child (FK is ON)
            taxonomyStore.createCategory({
                slug: "product",
                name: "Product",
                description: "Product management agents",
                position: 5,
            });

            const sub = taxonomyStore.createCategory({
                slug: "product-growth",
                name: "Product / Growth",
                description: "Growth-focused product agents",
                position: 6,
                parentSlug: "product",
            });

            expect(sub.parentSlug).toBe("product");
        });

        // [agent-and-taxonomy-schema.2] — ordering guard: FAIL if position ordering regresses
        it("listCategories() returns categories ordered by position ASC then slug ASC", () => {
            // Seed additional categories at known positions
            taxonomyStore.createCategory({
                slug: "cto-system",
                name: "CTO System",
                description: "High-level engineering leadership agents",
                position: 1,
            });

            taxonomyStore.createCategory({
                slug: "security",
                name: "Security",
                description: "Security and compliance agents",
                position: 20,
            });

            const ordered = taxonomyStore.listCategories();

            // Extract just the position sequence — must be non-decreasing
            const positions = ordered.map((c) => c.position);
            for (let i = 1; i < positions.length; i++) {
                // position[i] >= position[i-1] (ASC)
                expect(positions[i]).toBeGreaterThanOrEqual(positions[i - 1]!);
            }

            // Explicitly verify the lowest-position category appears first
            expect(ordered[0]!.position).toBeLessThanOrEqual(ordered[ordered.length - 1]!.position);

            // The cto-system (position 1) must come before product (position 5)
            const ctoIdx = ordered.findIndex((c) => c.slug === "cto-system");
            const prodIdx = ordered.findIndex((c) => c.slug === "product");
            expect(ctoIdx).toBeLessThan(prodIdx);

            // product (position 5) must come before infrastructure (position 10)
            const infraIdx = ordered.findIndex((c) => c.slug === "infrastructure");
            expect(prodIdx).toBeLessThan(infraIdx);
        });
    });

    // ── [agent-and-taxonomy-schema.1] agents table: slug PK, status, model_hint, taxonomy_category

    describe("AgentStore — agents table columns", () => {
        it("creates an agent with all fields and reads it back", () => {
            const agent = agentStore.create({
                slug: "infra-sentinel",
                displayName: "Infra Sentinel",
                description: "Monitors infrastructure health",
                status: "active",
                modelHint: "claude-opus-4-8",
                taxonomyCategory: "infrastructure",
                defaultPosture: "approve",
            });

            expect(agent.slug).toBe("infra-sentinel");
            expect(agent.displayName).toBe("Infra Sentinel");
            expect(agent.status).toBe("active");
            // model_hint is a plain string, NOT an FK [inv:model_hint_text]
            expect(agent.modelHint).toBe("claude-opus-4-8");
            expect(agent.taxonomyCategory).toBe("infrastructure");
            expect(agent.defaultPosture).toBe("approve");
            expect(typeof agent.createdAt).toBe("string");
            expect(typeof agent.updatedAt).toBe("string");
        });

        it("creates an agent with minimal fields (defaults applied)", () => {
            const agent = agentStore.create({
                slug: "minimal-agent",
                displayName: "Minimal Agent",
            });

            expect(agent.slug).toBe("minimal-agent");
            expect(agent.status).toBe("draft");
            expect(agent.modelHint).toBeNull();
            expect(agent.taxonomyCategory).toBeNull();
            expect(agent.defaultPosture).toBe("needs_work");
        });

        it("read() throws AGENT_NOT_FOUND for unknown slug", () => {
            expect(() => agentStore.read("no-such-agent")).toThrowError(AgentError);
            expect(() => agentStore.read("no-such-agent")).toThrowError("not found");
        });

        it("update() mutates mutable fields and returns the updated row", () => {
            agentStore.create({
                slug: "mutable-agent",
                displayName: "Before",
                status: "draft",
            });

            const updated = agentStore.update("mutable-agent", {
                displayName: "After",
                status: "active",
                modelHint: "claude-sonnet-4-6",
            });

            expect(updated.displayName).toBe("After");
            expect(updated.status).toBe("active");
            expect(updated.modelHint).toBe("claude-sonnet-4-6");
        });

        it("delete() removes the agent row", () => {
            agentStore.create({ slug: "to-delete", displayName: "Delete Me" });
            agentStore.delete("to-delete");
            expect(() => agentStore.read("to-delete")).toThrowError(AgentError);
        });

        it("delete() throws AGENT_NOT_FOUND if slug absent", () => {
            expect(() => agentStore.delete("ghost-agent")).toThrowError(AgentError);
        });
    });

    // ── list() filtering ──────────────────────────────────────────────────────

    describe("AgentStore.list() — category and status filters", () => {
        beforeAll(() => {
            // Seed a second category and agents in both
            taxonomyStore.createCategory({
                slug: "analytics",
                name: "Analytics",
                position: 30,
            });

            agentStore.create({
                slug: "analytics-alpha",
                displayName: "Analytics Alpha",
                status: "draft",
                taxonomyCategory: "analytics",
            });

            agentStore.create({
                slug: "analytics-beta",
                displayName: "Analytics Beta",
                status: "active",
                taxonomyCategory: "analytics",
            });
        });

        it("list() with no filter returns all agents", () => {
            const all = agentStore.list();
            expect(all.length).toBeGreaterThan(0);
        });

        it("list({ category }) returns only agents in that category", () => {
            const infraAgents = agentStore.list({ category: "infrastructure" });
            expect(infraAgents.length).toBeGreaterThan(0);
            expect(infraAgents.every((a) => a.taxonomyCategory === "infrastructure")).toBe(true);

            const analyticsAgents = agentStore.list({ category: "analytics" });
            expect(analyticsAgents.length).toBe(2);
            expect(analyticsAgents.every((a) => a.taxonomyCategory === "analytics")).toBe(true);
        });

        it("list({ status }) returns only agents with that status", () => {
            const draftAgents = agentStore.list({ status: "draft" });
            expect(draftAgents.every((a) => a.status === "draft")).toBe(true);

            const activeAgents = agentStore.list({ status: "active" });
            expect(activeAgents.every((a) => a.status === "active")).toBe(true);
        });

        it("list({ category, status }) combines both filters", () => {
            const result = agentStore.list({ category: "analytics", status: "active" });
            expect(result.length).toBe(1);
            expect(result[0]!.slug).toBe("analytics-beta");
        });
    });

    // ── [inv:reopen-proves-persistence] — the regression guard ────────────────

    describe("persistence across DB reopen", () => {
        it("agent created before close is readable after reopening the DB handle", () => {
            // Create an agent with a known slug
            agentStore.create({
                slug: "persist-agent",
                displayName: "Persistence Test",
                status: "active",
                modelHint: "claude-fable-5",
                taxonomyCategory: "infrastructure",
            });

            // CLOSE the handle — flush WAL, release locks [inv:reopen-proves-persistence]
            conn.close();

            // REOPEN from the SAME file path — no in-memory cheat
            const reopened = openDb(dbPath);
            conn = reopened.conn;
            agentStore = reopened.agentStore;
            taxonomyStore = reopened.taxonomyStore;

            const retrieved = agentStore.read("persist-agent");
            expect(retrieved.slug).toBe("persist-agent");
            expect(retrieved.displayName).toBe("Persistence Test");
            expect(retrieved.status).toBe("active");
            expect(retrieved.modelHint).toBe("claude-fable-5");
            expect(retrieved.taxonomyCategory).toBe("infrastructure");
        });

        it("taxonomy categories from before reopen are still present and ordered", () => {
            // cto-system (pos 1) and infrastructure (pos 10) were created before reopen
            const ordered = taxonomyStore.listCategories();
            const ctoIdx = ordered.findIndex((c) => c.slug === "cto-system");
            const infraIdx = ordered.findIndex((c) => c.slug === "infrastructure");

            // Both must survive the reopen
            expect(ctoIdx).toBeGreaterThanOrEqual(0);
            expect(infraIdx).toBeGreaterThanOrEqual(0);

            // Position ordering must hold after reopen — regression guard
            expect(ctoIdx).toBeLessThan(infraIdx);
        });
    });
});
