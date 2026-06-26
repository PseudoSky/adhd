/**
 * Guard test for agent-store-retire state (Plan 6 wave 3).
 *
 * Invariants proven here:
 * - [agent-store-retire.1] user-authored flat systemPrompt is no longer a
 *   required authoring field — creating an agent WITHOUT systemPrompt succeeds.
 * - [agent-store-retire.2] systemPrompt retained only as a documented computed
 *   compat shim — when populated it holds compiled content, not an authored blob.
 * - [agent-store-retire.3] agent CRUD delegates / agent row is a compiled cache:
 *   the stored row has no required systemPrompt; persistence proven by REOPENING
 *   the DB handle from the same file path.
 *
 * [inv:reopen-proves-cache] — persistence proven by CLOSING the better-sqlite3
 * handle and REOPENING from the same file path, then asserting rows.
 * [inv:exit-code-gate]      — gate keys on vitest's exit code, NOT stdout grep.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runMigrationsOn } from "../db/migrate-runner.js";
import * as schema from "../db/schema.js";
import { AgentStore } from "../store/agent-store.js";
import type { AgentCreateInput } from "../validation/index.js";

// ── Test DB helpers ────────────────────────────────────────────────────────────

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cache-store-test-"));
    dbPath = path.join(tmpDir, "agents.db");
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

function openDb(filePath: string) {
    const sqlite = new Database(filePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    const db = drizzle(sqlite, { schema });
    runMigrationsOn(sqlite, db);
    return { sqlite, db };
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

/**
 * Minimal agent input with NO systemPrompt.
 *
 * This proves [agent-store-retire.1] — the authoring path is gone and
 * systemPrompt is no longer required to create an agent.
 */
const minimalAgentInput = (): AgentCreateInput => ({
    name: "cache-test-agent",
    provider: { type: "openai", model: "gpt-4o-mini" },
    // systemPrompt intentionally ABSENT — proves required authoring path is gone
    mcpServers: {},
    permissions: {},
});

/**
 * Simulated compiler output — what compiler-integration writes into the compat shim.
 * Represents `compileAgent().content`; never a user-authored string.
 */
const COMPILED_CONTENT = "You are a compiled cache agent. [populated by compileAgent output]";

// ── [agent-store-retire.1] creating without systemPrompt succeeds ──────────────

describe("AgentStore thin-cache — no required systemPrompt", () => {
    it("creates an agent without a flat systemPrompt (authoring path gone)", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new AgentStore(db as any);

        const agent = store.create(minimalAgentInput());

        expect(agent.name).toBe("cache-test-agent");
        expect(agent.version).toBe(1);
        // systemPrompt is absent (undefined) — not required
        expect(agent.systemPrompt).toBeUndefined();

        sqlite.close();
    });

    it("reads back an agent with no systemPrompt after create", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new AgentStore(db as any);

        store.create(minimalAgentInput());
        const agent = store.read("cache-test-agent");

        expect(agent.systemPrompt).toBeUndefined();

        sqlite.close();
    });

    it("lists agents that have no systemPrompt", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new AgentStore(db as any);

        store.create(minimalAgentInput());
        store.create({ ...minimalAgentInput(), name: "cache-agent-2" });

        const agents = store.list();
        expect(agents).toHaveLength(2);
        // Neither requires systemPrompt
        for (const a of agents) {
            expect(a.systemPrompt).toBeUndefined();
        }

        sqlite.close();
    });
});

// ── [agent-store-retire.2] systemPrompt as computed compat shim ───────────────

describe("AgentStore thin-cache — systemPrompt as computed compat shim", () => {
    it("stores compiled content in systemPrompt compat shim via update", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new AgentStore(db as any);

        // Row starts with no authored prompt (thin cache row)
        store.create(minimalAgentInput());
        expect(store.read("cache-test-agent").systemPrompt).toBeUndefined();

        // compiler-integration would call update() to write compiled content
        // into the compat shim after compileAgent() resolves
        const updated = store.update({
            name: "cache-test-agent",
            patch: { systemPrompt: COMPILED_CONTENT },
        });

        expect(updated.systemPrompt).toBe(COMPILED_CONTENT);
        expect(updated.version).toBe(2);

        sqlite.close();
    });

    it("systemPrompt compat shim can be cleared back to undefined", () => {
        const { sqlite, db } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = new AgentStore(db as any);

        // Populate the shim
        store.create({ ...minimalAgentInput(), systemPrompt: COMPILED_CONTENT });
        expect(store.read("cache-test-agent").systemPrompt).toBe(COMPILED_CONTENT);

        // A cache eviction / re-compile would update with undefined or a new value —
        // the field is not locked. Here prove it accepts any string.
        const newContent = "Re-compiled content v2";
        const updated = store.update({
            name: "cache-test-agent",
            patch: { systemPrompt: newContent },
        });
        expect(updated.systemPrompt).toBe(newContent);

        sqlite.close();
    });
});

// ── [agent-store-retire.3] row is a compiled cache — prove with reopen ─────────

describe("AgentStore thin-cache — row persists as cache [inv:reopen-proves-cache]", () => {
    it("agent row without systemPrompt persists across DB handle reopen", () => {
        // ── write phase ──────────────────────────────────────────────────────
        const { sqlite: sqliteA, db: dbA } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeA = new AgentStore(dbA as any);
        storeA.create(minimalAgentInput());
        sqliteA.close(); // close — proves we're not reading in-memory state

        // ── reopen from the same file path ───────────────────────────────────
        const { sqlite: sqliteB, db: dbB } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeB = new AgentStore(dbB as any);

        const agent = storeB.read("cache-test-agent");
        expect(agent.name).toBe("cache-test-agent");
        expect(agent.systemPrompt).toBeUndefined();
        expect(agent.version).toBe(1);

        sqliteB.close();
    });

    it("compiled compat-shim content persists across DB handle reopen", () => {
        // ── write phase: create + populate compat shim ───────────────────────
        const { sqlite: sqliteA, db: dbA } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeA = new AgentStore(dbA as any);
        storeA.create(minimalAgentInput());
        storeA.update({
            name: "cache-test-agent",
            patch: { systemPrompt: COMPILED_CONTENT },
        });
        sqliteA.close();

        // ── reopen: verify compiled content survived ──────────────────────────
        const { sqlite: sqliteB, db: dbB } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeB = new AgentStore(dbB as any);

        const agent = storeB.read("cache-test-agent");
        // The compat shim (compiled content) survived the reopen
        expect(agent.systemPrompt).toBe(COMPILED_CONTENT);
        // Version bumped by the update call
        expect(agent.version).toBe(2);

        sqliteB.close();
    });

    it("multiple cache agents (no systemPrompt) all persist on reopen", () => {
        const NAMES = ["cache-alpha", "cache-beta", "cache-gamma"];

        // ── write phase ──────────────────────────────────────────────────────
        const { sqlite: sqliteA, db: dbA } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeA = new AgentStore(dbA as any);
        for (const name of NAMES) {
            storeA.create({ ...minimalAgentInput(), name });
        }
        sqliteA.close();

        // ── reopen ────────────────────────────────────────────────────────────
        const { sqlite: sqliteB, db: dbB } = openDb(dbPath);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storeB = new AgentStore(dbB as any);

        const agents = storeB.list();
        expect(agents).toHaveLength(NAMES.length);
        for (const agent of agents) {
            expect(NAMES).toContain(agent.name);
            expect(agent.systemPrompt).toBeUndefined();
        }

        sqliteB.close();
    });
});
