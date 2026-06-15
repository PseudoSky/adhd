/**
 * schema.integration.test.ts
 *
 * Verifies that migration 0004 actually applied to the real SQLite DB,
 * and that TaskStore.create/read correctly round-trips the new DAG + HITL columns.
 *
 * Real components: TaskStore, SessionStore, AgentStore, drizzle DB, migrations.
 * No LLM provider calls in this file.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildHarness, createSessionAndAgent } from "./harness.js";
import type { Harness } from "./harness.js";
import { ScriptedProvider } from "./scripted-provider.js";
import { generateId } from "../../utils/ids.js";

describe("schema.integration – migration 0004 + column round-trip", () => {
    let h: Harness;

    beforeEach(async () => {
        h = await buildHarness();
    });

    afterEach(async () => {
        await h.teardown();
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 1. Migration 0004: four new columns actually exist in the live DB
    // ──────────────────────────────────────────────────────────────────────────
    it("migration 0004: depends_on, on_upstream_failure, inputs, resume_token columns exist", () => {
        // Query the live SQLite PRAGMA directly
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cols = (h.rawSqlite as any)
            .prepare("PRAGMA table_info(tasks)")
            .all() as Array<{ name: string; type: string }>;

        const colNames = cols.map((c) => c.name);

        expect(colNames).toContain("depends_on");
        expect(colNames).toContain("on_upstream_failure");
        expect(colNames).toContain("inputs");
        expect(colNames).toContain("resume_token");
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 2. Migration 0004: "waiting" and "awaiting_input" status values are valid
    //    (The schema enum in Drizzle gates inserts — prove by inserting them.)
    // ──────────────────────────────────────────────────────────────────────────
    it("migration 0004: waiting and awaiting_input are insertable statuses", () => {
        const { sessionId } = (() => {
            const agentName = "status-test-agent";
            h.agentStore.create({
                name: agentName,
                provider: { type: "openai", model: "gpt-test" },
                systemPrompt: "test",
                mcpServers: {},
                permissions: {},
            });
            const agentDef = h.agentStore.read(agentName);
            const session = h.sessionStore.create({ agentName, agentDefinition: agentDef });
            return { sessionId: session.id };
        })();

        // 'waiting' status: created via dependsOn (upstream is a real UUID but doesn't need to exist in DB)
        const fakeUpstreamId = generateId();
        const waitingTask = h.taskStore.create({
            sessionId,
            prompt: "waiting task",
            dependsOn: [fakeUpstreamId],
        });
        expect(waitingTask.status).toBe("waiting");

        // 'awaiting_input' status: via updateStatus
        const pendingTask = h.taskStore.create({ sessionId, prompt: "pending task" });
        const awaitingTask = h.taskStore.updateStatus(pendingTask.id, "awaiting_input", {
            resumeToken: generateId(), // must be a valid UUID (Zod validates)
        });
        expect(awaitingTask.status).toBe("awaiting_input");
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 3. TaskStore.create with depends_on → task.status === "waiting"
    //    TaskStore.read correctly round-trips dependsOn, inputs, resumeToken
    // ──────────────────────────────────────────────────────────────────────────
    it("task with depends_on=[X] lands in 'waiting' status; round-trips from DB", () => {
        const agentName = "roundtrip-agent";
        h.agentStore.create({
            name: agentName,
            provider: { type: "openai", model: "gpt-test" },
            systemPrompt: "test",
            mcpServers: {},
            permissions: {},
        });
        const agentDef = h.agentStore.read(agentName);
        const session = h.sessionStore.create({ agentName, agentDefinition: agentDef });

        const upstreamId = generateId(); // real UUID (does not need to exist as a task row)

        const task = h.taskStore.create({
            sessionId: session.id,
            prompt: "downstream task",
            dependsOn: [upstreamId],
            onUpstreamFailure: "skip",
        });

        expect(task.status).toBe("waiting");

        // Round-trip from DB
        const fromDb = h.taskStore.read(task.id);
        expect(fromDb.status).toBe("waiting");
        expect(fromDb.dependsOn).toEqual([upstreamId]);
        expect(fromDb.onUpstreamFailure).toBe("skip");
        expect(fromDb.inputs).toBeNull();
        expect(fromDb.resumeToken).toBeNull();
    });

    it("task without depends_on lands in 'pending' status", () => {
        const agentName = "pending-agent";
        h.agentStore.create({
            name: agentName,
            provider: { type: "openai", model: "gpt-test" },
            systemPrompt: "test",
            mcpServers: {},
            permissions: {},
        });
        const agentDef = h.agentStore.read(agentName);
        const session = h.sessionStore.create({ agentName, agentDefinition: agentDef });

        const task = h.taskStore.create({ sessionId: session.id, prompt: "no deps" });

        // NEG: no-deps task must be "pending", not "waiting"
        expect(task.status).toBe("pending");
        expect(task.dependsOn).toBeNull();
    });

    it("resume_token round-trips via updateStatus", () => {
        const agentName = "resume-token-agent";
        h.agentStore.create({
            name: agentName,
            provider: { type: "openai", model: "gpt-test" },
            systemPrompt: "test",
            mcpServers: {},
            permissions: {},
        });
        const agentDef = h.agentStore.read(agentName);
        const session = h.sessionStore.create({ agentName, agentDefinition: agentDef });
        const task = h.taskStore.create({ sessionId: session.id, prompt: "hitl" });

        const token = generateId(); // valid UUID
        h.taskStore.updateStatus(task.id, "awaiting_input", { resumeToken: token });

        const fromDb = h.taskStore.read(task.id);
        expect(fromDb.status).toBe("awaiting_input");
        expect(fromDb.resumeToken).toBe(token);
    });

    it("inputs column round-trips via DB update", () => {
        const agentName = "inputs-agent";
        h.agentStore.create({
            name: agentName,
            provider: { type: "openai", model: "gpt-test" },
            systemPrompt: "test",
            mcpServers: {},
            permissions: {},
        });
        const agentDef = h.agentStore.read(agentName);
        const session = h.sessionStore.create({ agentName, agentDefinition: agentDef });

        const upId = generateId(); // valid UUID
        const inputs = { [upId]: "upstream-result" };

        const task = h.taskStore.create({
            sessionId: session.id,
            prompt: "with inputs",
            inputs,
        });

        const fromDb = h.taskStore.read(task.id);
        expect(fromDb.inputs).toEqual(inputs);
    });
});
