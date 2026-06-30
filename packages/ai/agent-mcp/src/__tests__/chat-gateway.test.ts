/**
 * chat-gateway.test.ts
 *
 * Real-seam integration tests for the P0 Chat Gateway.
 * (Per CLAUDE.md §6: real HTTP client, real in-process stores, mock only the
 * LLM provider at the boundary.)
 *
 * Scenarios covered:
 *  1. GET /v1/models lists seeded agents
 *  2. POST /v1/chat/completions (non-stream): returns assistant content;
 *     session persists the turn (verified by reopening SessionStore)
 *  3. POST /v1/chat/completions (stream): SSE chunks arrive; content correct
 *  4. Multi-turn with X-AgentMcp-Session: same session, history accumulates;
 *     delta-forward verified (second request's resent history not double-appended)
 *  5. Fingerprint fallback: same prefix → same session; different prefix → new
 *  6. HITL round-trip: agent suspends → question returned → resume → completes
 *  7. NEGATIVE CONTROL: forwarding full history as delta causes extra session
 *     messages — proves the multi-turn assertion has teeth
 */

import http from "node:http";
import { describe, it, expect, beforeEach } from "vitest";
import { buildHarness, drainQueue, Latch } from "./integration/harness.js";
import type { Harness } from "./integration/harness.js";
import { startSseServer } from "../streaming/sse-server.js";
import type { GatewayDepsRef } from "../streaming/chat-gateway.js";
import { resetFingerprintMap } from "../streaming/chat-gateway.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { TaskDeps } from "../tools/task.js";
import { taskTool } from "../tools/task.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import type { AgentCreateInput } from "../validation/index.js";

// ── Test harness builder ──────────────────────────────────────────────────────

interface GatewayHarness {
    harness: Harness;
    port: number;
    sseServer: http.Server;
    /** taskDeps with the scripted provider injected */
    patchedDeps: TaskDeps;
    teardown: () => Promise<void>;
}

interface ScriptedTurn {
    content?: string;
    hitlPrompt?: string;
}

/** Build a provider that returns scripted responses per chat() call. */
function makeScriptedProvider(turns: ScriptedTurn[]) {
    let idx = 0;
    return {
        chat: async () => {
            const turn = turns[idx++] ?? { content: "done" };
            const sessionId = generateId();
            if (turn.hitlPrompt) {
                return {
                    message: {
                        id: generateId(), sessionId, role: "assistant" as const,
                        content: undefined,
                        toolCalls: [{
                            id: generateId(), server: "builtin", tool: "request_human_input",
                            arguments: { prompt: turn.hitlPrompt },
                        }],
                        createdAt: nowIso(),
                    },
                    stopReason: "tool_calls" as const,
                };
            }
            return {
                message: {
                    id: generateId(), sessionId, role: "assistant" as const,
                    content: turn.content ?? "done", createdAt: nowIso(),
                },
                stopReason: "completed" as const,
            };
        },
    };
}

async function buildGatewayHarness(turns: ScriptedTurn[]): Promise<GatewayHarness> {
    const provider = makeScriptedProvider(turns);
    const harness = await buildHarness({ defaultProvider: provider });

    // Wrap orchestrator to inject the scripted provider for all dispatches
    const patchedDeps: TaskDeps = {
        ...harness.taskDeps,
        orchestrator: {
            run: (input: Parameters<Orchestrator["run"]>[0]) =>
                harness.orchestrator.run({ ...input, provider }),
        } as Orchestrator,
    };

    const gatewayDepsRef: GatewayDepsRef = {
        value: {
            agentStore: harness.agentStore,
            sessionStore: harness.sessionStore,
            taskStore: harness.taskStore,
            taskDeps: patchedDeps,
        },
    };

    const sseServer = startSseServer(harness.taskStore, 0, "127.0.0.1", gatewayDepsRef);
    const port = await new Promise<number>((resolve) => {
        if (sseServer.listening) {
            resolve((sseServer.address() as { port: number }).port);
        } else {
            sseServer.once("listening", () => {
                resolve((sseServer.address() as { port: number }).port);
            });
        }
    });

    const teardown = async () => {
        await new Promise<void>((r) => sseServer.close(() => r()));
        await harness.teardown();
    };

    return { harness, port, sseServer, patchedDeps, teardown };
}

/** Seed a test agent and return its name. */
function seedAgent(harness: Harness, overrides: Partial<AgentCreateInput> = {}): string {
    const name = `gw-agent-${generateId()}`;
    harness.agentStore.create({
        name,
        provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
        systemPrompt: "You are a gateway test agent.",
        mcpServers: {},
        permissions: {},
        ...overrides,
    });
    return name;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
            let body = "";
            res.on("data", (c: Buffer) => { body += c.toString(); });
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            res.on("error", reject);
        });
        req.on("error", reject);
    });
}

function httpPost(
    port: number,
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const options: http.RequestOptions = {
            hostname: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                ...headers,
            },
        };
        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (c: Buffer) => { data += c.toString(); });
            res.on("end", () => resolve({
                status: res.statusCode ?? 0,
                body: data,
                headers: res.headers,
            }));
            res.on("error", reject);
        });
        req.on("error", reject);
        req.write(payload);
        req.end();
    });
}

/**
 * Collect SSE frames from a streaming POST response.
 * Returns all frames received before [DONE] or timeout.
 */
function collectStreamFrames(
    port: number,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    timeoutMs = 10_000
): Promise<Array<{ event?: string; data: string }>> {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(body);
        const options: http.RequestOptions = {
            hostname: "127.0.0.1",
            port,
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
                ...headers,
            },
        };

        const frames: Array<{ event?: string; data: string }> = [];
        const timer = setTimeout(() => {
            req.destroy();
            resolve(frames);
        }, timeoutMs);

        const req = http.request(options, (res) => {
            let buf = "";
            let currentEvent: string | undefined;

            res.on("data", (chunk: Buffer) => {
                buf += chunk.toString();
                const lines = buf.split("\n");
                buf = lines.pop() ?? "";

                for (const line of lines) {
                    if (line.startsWith("event: ")) {
                        currentEvent = line.slice(7).trim();
                    } else if (line.startsWith("data: ")) {
                        const raw = line.slice(6).trim();
                        if (raw === "[DONE]") {
                            clearTimeout(timer);
                            req.destroy();
                            resolve(frames);
                            return;
                        }
                        frames.push({ event: currentEvent, data: raw });
                    }
                    if (line === "") {
                        currentEvent = undefined;
                    }
                }
            });

            res.on("end", () => {
                clearTimeout(timer);
                resolve(frames);
            });
            res.on("error", () => {
                clearTimeout(timer);
                resolve(frames);
            });
        });

        req.on("error", (err) => {
            clearTimeout(timer);
            // destroyed after [DONE] is fine
            if (frames.length > 0) resolve(frames);
            else reject(err);
        });

        req.write(payload);
        req.end();
    });
}

// ── Reset state between tests ─────────────────────────────────────────────────

beforeEach(() => {
    resetFingerprintMap();
});

// ── Scenario 1: GET /v1/models ────────────────────────────────────────────────

describe("chat-gateway — GET /v1/models", () => {
    it("lists seeded agents as OpenAI model entries", async () => {
        const gw = await buildGatewayHarness([]);
        try {
            const agentName = seedAgent(gw.harness);

            const { status, body } = await httpGet(gw.port, "/v1/models");
            expect(status).toBe(200);

            const parsed = JSON.parse(body) as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
            expect(parsed.object).toBe("list");
            expect(Array.isArray(parsed.data)).toBe(true);

            const entry = parsed.data.find(m => m.id === agentName);
            expect(entry).toBeDefined();
            expect(entry?.object).toBe("model");
            expect(entry?.owned_by).toBe("agent-mcp");
        } finally {
            await gw.teardown();
        }
    });
});

// ── Scenario 2: POST /v1/chat/completions (non-stream) ───────────────────────

describe("chat-gateway — POST /v1/chat/completions (non-stream)", () => {
    it("returns assistant content and the session persists the turn", async () => {
        const gw = await buildGatewayHarness([{ content: "Hello from agent" }]);
        try {
            const agentName = seedAgent(gw.harness);

            const resp = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Hello" }],
                stream: false,
            });

            expect(resp.status).toBe(200);
            const parsed = JSON.parse(resp.body) as {
                object: string;
                choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
            };
            expect(parsed.object).toBe("chat.completion");
            expect(parsed.choices[0]?.message.role).toBe("assistant");
            expect(parsed.choices[0]?.message.content).toBe("Hello from agent");
            expect(parsed.choices[0]?.finish_reason).toBe("stop");

            // Persistence proof: open the SessionStore and find the session + messages
            const sessions = gw.harness.sessionStore.list({ agentName });
            expect(sessions.length).toBeGreaterThanOrEqual(1);
            const sessionId = sessions[0]!.id;

            const msgs = gw.harness.sessionStore.getMessages(sessionId);
            const userMsgs = msgs.filter(m => m.role === "user");
            const assistantMsgs = msgs.filter(m => m.role === "assistant");

            expect(userMsgs.length).toBe(1);
            expect(userMsgs[0]!.content).toBe("Hello");
            expect(assistantMsgs.length).toBe(1);
            expect(assistantMsgs[0]!.content).toBe("Hello from agent");
        } finally {
            await gw.teardown();
        }
    });

    it("returns 404 for an unknown agent", async () => {
        const gw = await buildGatewayHarness([]);
        try {
            const resp = await httpPost(gw.port, "/v1/chat/completions", {
                model: "no-such-agent",
                messages: [{ role: "user", content: "hi" }],
            });
            expect(resp.status).toBe(404);
            const body = JSON.parse(resp.body) as { error: { type: string } };
            expect(body.error.type).toBe("invalid_request_error");
        } finally {
            await gw.teardown();
        }
    });
});

// ── Scenario 3: POST /v1/chat/completions (stream) ───────────────────────────

describe("chat-gateway — POST /v1/chat/completions (stream)", () => {
    it("returns SSE chunks with assistant content and [DONE]", async () => {
        const gw = await buildGatewayHarness([{ content: "Streaming reply" }]);
        try {
            const agentName = seedAgent(gw.harness);

            const frames = await collectStreamFrames(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Hello" }],
                stream: true,
            }, {}, 10_000);

            expect(frames.length).toBeGreaterThan(0);

            // Find the content chunk (has role+content)
            const contentChunks = frames.filter(f => {
                try {
                    const p = JSON.parse(f.data) as { choices: Array<{ delta: { content?: string } }> };
                    return typeof p.choices[0]?.delta.content === "string";
                } catch { return false; }
            });
            expect(contentChunks.length).toBeGreaterThan(0);

            // Aggregate content
            const content = contentChunks.map(f => {
                const p = JSON.parse(f.data) as { choices: Array<{ delta: { content: string } }> };
                return p.choices[0]!.delta.content;
            }).join("");
            expect(content).toBe("Streaming reply");

            // Finish-reason chunk must be present
            const finishChunks = frames.filter(f => {
                try {
                    const p = JSON.parse(f.data) as { choices: Array<{ finish_reason: string | null }> };
                    return p.choices[0]?.finish_reason === "stop";
                } catch { return false; }
            });
            expect(finishChunks.length).toBe(1);

            // Persistence: session was created and messages stored
            const sessions = gw.harness.sessionStore.list({ agentName });
            expect(sessions.length).toBeGreaterThanOrEqual(1);
            const msgs = gw.harness.sessionStore.getMessages(sessions[0]!.id);
            expect(msgs.filter(m => m.role === "user").length).toBe(1);
            expect(msgs.filter(m => m.role === "assistant").length).toBe(1);
        } finally {
            await gw.teardown();
        }
    });
});

// ── Scenario 4: Multi-turn with X-AgentMcp-Session ───────────────────────────

describe("chat-gateway — multi-turn with X-AgentMcp-Session", () => {
    it("two POSTs with the same header land in the same session; delta-forward prevents double-append", async () => {
        const gw = await buildGatewayHarness([
            { content: "Reply to hello" },
            { content: "Reply to follow-up" },
        ]);
        try {
            const agentName = seedAgent(gw.harness);

            // Create a session manually to bind both requests to
            const agentDef = gw.harness.agentStore.read(agentName);
            const session = gw.harness.sessionStore.create({ agentName, agentDefinition: agentDef });
            const sessionId = session.id;

            // Turn 1: user sends "Hello"
            const resp1 = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Hello" }],
                stream: false,
            }, { "x-agentmcp-session": sessionId });

            expect(resp1.status).toBe(200);
            const r1 = JSON.parse(resp1.body) as { choices: Array<{ message: { content: string } }> };
            expect(r1.choices[0]!.message.content).toBe("Reply to hello");

            // Turn 2: chat UI resends full history [user:"Hello", assistant:"Reply to hello"] + new turn
            const resp2 = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [
                    { role: "user", content: "Hello" },             // resent — must be ignored
                    { role: "assistant", content: "Reply to hello" }, // resent — must be ignored
                    { role: "user", content: "Tell me more" },       // delta
                ],
                stream: false,
            }, { "x-agentmcp-session": sessionId });

            expect(resp2.status).toBe(200);
            const r2 = JSON.parse(resp2.body) as { choices: Array<{ message: { content: string } }> };
            expect(r2.choices[0]!.message.content).toBe("Reply to follow-up");

            // Delta-forward verification: the session must have exactly 2 user messages
            // (one per turn), not 3 (which would happen if "Hello" was forwarded again).
            const msgs = gw.harness.sessionStore.getMessages(sessionId);
            const userMsgs = msgs.filter(m => m.role === "user");
            const assistantMsgs = msgs.filter(m => m.role === "assistant");

            expect(userMsgs.length).toBe(2);
            expect(assistantMsgs.length).toBe(2);

            // The deltas must be ONLY the new turns (not the full resent history)
            expect(userMsgs[0]!.content).toBe("Hello");
            expect(userMsgs[1]!.content).toBe("Tell me more");
        } finally {
            await gw.teardown();
        }
    });
});

// ── Scenario 5: Fingerprint fallback ─────────────────────────────────────────

describe("chat-gateway — fingerprint fallback", () => {
    it("same system+first-user prefix routes to the same session", async () => {
        const gw = await buildGatewayHarness([
            { content: "Turn 1" },
            { content: "Turn 2" },
        ]);
        try {
            const agentName = seedAgent(gw.harness);

            // Turn 1 — no header (fingerprint cold-start)
            const resp1 = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [
                    { role: "system", content: "You are helpful." },
                    { role: "user", content: "First message" },
                ],
                stream: false,
            });
            expect(resp1.status).toBe(200);

            // Turn 2 — same prefix + new user message; no header (fingerprint hit)
            const resp2 = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [
                    { role: "system", content: "You are helpful." },
                    { role: "user", content: "First message" },    // same first-user → same fingerprint
                    { role: "assistant", content: "Turn 1" },
                    { role: "user", content: "Second message" },
                ],
                stream: false,
            });
            expect(resp2.status).toBe(200);

            // Same session: only one session should exist for this agent
            const sessions = gw.harness.sessionStore.list({ agentName });
            expect(sessions.length).toBe(1);

            // And that session has both turns
            const msgs = gw.harness.sessionStore.getMessages(sessions[0]!.id);
            expect(msgs.filter(m => m.role === "user").length).toBe(2);
        } finally {
            await gw.teardown();
        }
    });

    it("different first-user message creates a different session", async () => {
        const gw = await buildGatewayHarness([
            { content: "Reply A" },
            { content: "Reply B" },
        ]);
        try {
            const agentName = seedAgent(gw.harness);

            await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Conversation A" }],
                stream: false,
            });

            await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Conversation B" }], // different first-user
                stream: false,
            });

            // Two distinct sessions should exist
            const sessions = gw.harness.sessionStore.list({ agentName });
            expect(sessions.length).toBe(2);
            expect(sessions[0]!.id).not.toBe(sessions[1]!.id);
        } finally {
            await gw.teardown();
        }
    });
});

// ── Scenario 6: HITL round-trip ───────────────────────────────────────────────

describe("chat-gateway — HITL round-trip", () => {
    it("agent suspends with question → question returned → second POST resumes and completes", async () => {
        const gw = await buildGatewayHarness([
            { hitlPrompt: "Please confirm your name:" }, // turn 1: HITL suspend
            { content: "Hello, confirmed user!" },        // turn 2: after resume, final reply
        ]);
        try {
            const agentName = seedAgent(gw.harness);

            // Create and bind session explicitly via header
            const agentDef = gw.harness.agentStore.read(agentName);
            const session = gw.harness.sessionStore.create({ agentName, agentDefinition: agentDef });
            const sessionId = session.id;

            // Turn 1: agent should suspend and return the HITL question
            const resp1 = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Start" }],
                stream: false,
            }, { "x-agentmcp-session": sessionId });

            expect(resp1.status).toBe(200);
            const r1 = JSON.parse(resp1.body) as { choices: Array<{ message: { content: string } }> };

            // The agent's HITL question should be returned as the assistant message
            expect(r1.choices[0]!.message.content).toContain("Please confirm your name:");

            // Task should be in awaiting_input state
            const awaitingTasks = gw.harness.taskStore.list({
                session_id: sessionId,
                status: "awaiting_input",
            });
            expect(awaitingTasks.length).toBe(1);
            expect(awaitingTasks[0]!.resumeToken).toBeTruthy();

            // Turn 2: user provides the answer → should route through taskResume
            const resp2 = await httpPost(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [
                    { role: "user", content: "Start" },
                    { role: "assistant", content: r1.choices[0]!.message.content },
                    { role: "user", content: "Alice" }, // user's answer
                ],
                stream: false,
            }, { "x-agentmcp-session": sessionId });

            expect(resp2.status).toBe(200);
            const r2 = JSON.parse(resp2.body) as { choices: Array<{ message: { content: string } }> };
            expect(r2.choices[0]!.message.content).toBe("Hello, confirmed user!");

            // Task should be completed
            await drainQueue(gw.harness.queue, 5_000);
            const awaitingAfter = gw.harness.taskStore.list({
                session_id: sessionId,
                status: "awaiting_input",
            });
            expect(awaitingAfter.length).toBe(0);
        } finally {
            await gw.teardown();
        }
    });

    it("HITL streaming: agent HITL question arrives as stream chunk, then second POST completes via stream", async () => {
        const gw = await buildGatewayHarness([
            { hitlPrompt: "What is your preference?" },
            { content: "Got it, preference applied." },
        ]);
        try {
            const agentName = seedAgent(gw.harness);
            const agentDef = gw.harness.agentStore.read(agentName);
            const session = gw.harness.sessionStore.create({ agentName, agentDefinition: agentDef });
            const sessionId = session.id;

            // Turn 1 (streaming): should receive the HITL question as a content chunk
            const frames1 = await collectStreamFrames(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [{ role: "user", content: "Configure me" }],
                stream: true,
            }, { "x-agentmcp-session": sessionId }, 10_000);

            const contentFrames1 = frames1.filter(f => {
                try {
                    const p = JSON.parse(f.data) as { choices: Array<{ delta: { content?: string } }> };
                    return typeof p.choices[0]?.delta.content === "string";
                } catch { return false; }
            });
            const streamContent1 = contentFrames1.map(f => {
                const p = JSON.parse(f.data) as { choices: Array<{ delta: { content: string } }> };
                return p.choices[0]!.delta.content;
            }).join("");
            expect(streamContent1).toContain("What is your preference?");

            // Turn 2 (streaming): answer the HITL question
            const frames2 = await collectStreamFrames(gw.port, "/v1/chat/completions", {
                model: agentName,
                messages: [
                    { role: "user", content: "Configure me" },
                    { role: "assistant", content: streamContent1 },
                    { role: "user", content: "Blue" },
                ],
                stream: true,
            }, { "x-agentmcp-session": sessionId }, 10_000);

            const contentFrames2 = frames2.filter(f => {
                try {
                    const p = JSON.parse(f.data) as { choices: Array<{ delta: { content?: string } }> };
                    return typeof p.choices[0]?.delta.content === "string";
                } catch { return false; }
            });
            const streamContent2 = contentFrames2.map(f => {
                const p = JSON.parse(f.data) as { choices: Array<{ delta: { content: string } }> };
                return p.choices[0]!.delta.content;
            }).join("");
            expect(streamContent2).toBe("Got it, preference applied.");
        } finally {
            await gw.teardown();
        }
    });
});

// ── Scenario 7: Negative control — double-append ──────────────────────────────

describe("chat-gateway — NEGATIVE CONTROL: delta-forward has teeth", () => {
    it("forwarding full history as delta produces extra session content (proves the multi-turn assertion would fail)", async () => {
        // This test simulates the BROKEN behavior to prove that the correct
        // multi-turn assertion (user messages count === 2) would go RED if the
        // gateway forwarded the full history instead of just the delta.
        //
        // Broken behavior: call taskTool twice for the second "turn" — once with
        // the resent prior user message and once with the new delta.
        // This produces 3 user messages in the session instead of 2.

        const provider = makeScriptedProvider([
            { content: "Reply 1" },
            { content: "Reply 2 (broken re-send)" },
            { content: "Reply 3 (new turn)" },
        ]);
        const harness = await buildHarness({ defaultProvider: provider });

        try {
            const agentName = `neg-control-${generateId()}`;
            harness.agentStore.create({
                name: agentName,
                provider: { type: "openai", model: "test-model", baseURL: "http://localhost:1234/v1" },
                systemPrompt: "Test agent",
                mcpServers: {},
                permissions: {},
            });
            const agentDef = harness.agentStore.read(agentName);
            const session = harness.sessionStore.create({ agentName, agentDefinition: agentDef });
            const sessionId = session.id;

            const patchedDeps: TaskDeps = {
                ...harness.taskDeps,
                orchestrator: {
                    run: (input: Parameters<Orchestrator["run"]>[0]) =>
                        harness.orchestrator.run({ ...input, provider }),
                } as Orchestrator,
            };

            // Turn 1 (correct): send "Hello" → Reply 1
            await taskTool(
                { session_id: sessionId, prompt: "Hello", background: false },
                patchedDeps
            );

            // BROKEN behavior for turn 2:
            // A broken gateway would forward ALL user messages from the request body.
            // Request body: messages=[user:"Hello", assistant:"Reply 1", user:"Tell more"]
            // Broken gateway sends "Hello" AND "Tell more" as separate prompts:
            await taskTool(
                { session_id: sessionId, prompt: "Hello", background: false }, // wrongly resent
                patchedDeps
            );
            await taskTool(
                { session_id: sessionId, prompt: "Tell more", background: false },
                patchedDeps
            );

            const msgs = harness.sessionStore.getMessages(sessionId);
            const userMsgs = msgs.filter(m => m.role === "user");

            // Broken: 3 user messages (Hello + Hello + Tell more)
            // The correct multi-turn assertion expects 2 — this would GO RED if run
            // against the broken harness.
            expect(userMsgs.length).toBe(3); // broken behavior verified

            // Prove: if we asserted userMsgs.length === 2 here, it would FAIL
            // (this proves the Scenario 4 assertion has teeth)
            expect(userMsgs.length).not.toBe(2);
        } finally {
            await harness.teardown();
        }
    });
});

// ── Scenario 8: model#sessionId binding ──────────────────────────────────────

describe("chat-gateway — model#sessionId explicit binding", () => {
    it("model field with #sessionId suffix routes to that session", async () => {
        const gw = await buildGatewayHarness([{ content: "Explicit session reply" }]);
        try {
            const agentName = seedAgent(gw.harness);
            const agentDef = gw.harness.agentStore.read(agentName);
            const session = gw.harness.sessionStore.create({ agentName, agentDefinition: agentDef });

            const resp = await httpPost(gw.port, "/v1/chat/completions", {
                model: `${agentName}#${session.id}`,
                messages: [{ role: "user", content: "Hi" }],
                stream: false,
            });

            expect(resp.status).toBe(200);
            const parsed = JSON.parse(resp.body) as { choices: Array<{ message: { content: string } }> };
            expect(parsed.choices[0]!.message.content).toBe("Explicit session reply");

            // Message should be in the explicitly specified session
            const msgs = gw.harness.sessionStore.getMessages(session.id);
            expect(msgs.filter(m => m.role === "user").length).toBe(1);
        } finally {
            await gw.teardown();
        }
    });
});
