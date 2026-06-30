/**
 * chat-gateway.ts
 *
 * OpenAI Chat Completions-compatible gateway routes for agent-mcp.
 *
 * Core principle (§1 of SPEC): agent-mcp's SessionStore is the system of
 * record.  The gateway is a thin translator — it forwards only the trailing
 * new user message (delta) into the bound session and streams the orchestrator's
 * final answer.  History reconstruction and tool-loop execution happen
 * server-side; the chat UI never receives tool_calls.
 *
 * Session binding (§6 of SPEC), resolution order:
 *  1. X-AgentMcp-Session request header (explicit id — PRIMARY)
 *  2. model#sessionId suffix in the model field
 *  3. Conversation-prefix fingerprint (stable SHA-256 of system + first user msg + user field)
 *  4. Create a new session (cold start); store fingerprint for future requests
 *
 * HITL routing (§7 of SPEC): if the session has a task in "awaiting_input",
 * route the new user turn through taskResume() instead of a new task().
 *
 * Streaming note (§8 of SPEC): the orchestrator currently emits final-result-only
 * (no per-token events) — the full result is emitted as a single content chunk
 * then [DONE].  Per-token streaming is FEAT-001, out of P0 scope.
 */

import crypto from "node:crypto";
import type http from "node:http";

import { subscribeToTask } from "./event-bus.js";
import type { AgentStore } from "../store/agent-store.js";
import type { SessionStore } from "../store/session-store.js";
import type { TaskStore } from "../store/task-store.js";
import type { TaskDeps } from "../tools/task.js";
import { taskTool, taskResume } from "../tools/task.js";
import { agentTool } from "../tools/session.js";
import type { SessionDeps } from "../tools/session.js";
import { logger } from "../logger.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface GatewayDeps {
    agentStore: AgentStore;
    sessionStore: SessionStore;
    taskStore: TaskStore;
    /**
     * Full task-dispatch deps.  Wired after server startup via a ref-box
     * (same late-binding pattern as taskDepsRef in index.ts) to avoid the
     * circular/early-init problem.
     */
    taskDeps: TaskDeps;
}

/**
 * Late-binding ref-box for GatewayDeps.
 *
 * startSseServer receives this box at startup; index.ts populates
 * `value` after startServer resolves — the same pattern used for taskDepsRef.
 * Gateway routes return 503 when `value` is undefined (server still booting).
 */
export interface GatewayDepsRef {
    value: GatewayDeps | undefined;
}

// ── Module-scope session binding state ───────────────────────────────────────
//
// Conversation-prefix fingerprint → sessionId map.  Process-lifetime scope;
// survives across requests so a restarted client re-binds to its session.
// Not serialized: a gateway restart loses fingerprint associations (the session
// still exists in the DB; the next request cold-starts a sibling session).

const fingerprintMap = new Map<string, string>();

/** Test helper: clear the fingerprint map between test runs. */
export function resetFingerprintMap(): void {
    fingerprintMap.clear();
}

// ── Local types ───────────────────────────────────────────────────────────────

interface ChatRequestMessage {
    role: "system" | "user" | "assistant";
    content: string | null;
}

interface ChatCompletionRequest {
    model: string;
    messages: ChatRequestMessage[];
    stream?: boolean;
    user?: string;
}

interface TaskOutcome {
    content: string;
    /** true when the task suspended for HITL (question is the content). */
    isHitl: boolean;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Parse the model field: bare "agentName" or "agentName#sessionId" convention
 * (§5 of SPEC — session-in-model for UIs that cannot send custom headers).
 */
function parseModel(model: string): { agentName: string; explicitSessionId?: string } {
    const idx = model.indexOf("#");
    return idx === -1
        ? { agentName: model }
        : { agentName: model.slice(0, idx), explicitSessionId: model.slice(idx + 1) };
}

/**
 * Stable SHA-256 fingerprint of a conversation's immutable prefix.
 * Namespaced by the `user` field for multi-user isolation.
 */
function computeFingerprint(messages: ChatRequestMessage[], user?: string): string {
    const systemContent = messages.find(m => m.role === "system")?.content ?? "";
    const firstUser = messages.find(m => m.role === "user")?.content ?? "";
    return crypto
        .createHash("sha256")
        .update(JSON.stringify([systemContent, firstUser, user ?? ""]))
        .digest("hex")
        .slice(0, 32);
}

/**
 * Extract the last user message — the one new turn to forward as the delta.
 * Everything before it (the history the UI resent) is intentionally ignored.
 */
function extractDelta(messages: ChatRequestMessage[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            return messages[i].content ?? "";
        }
    }
    return "";
}

function parseJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => { raw += chunk; });
        req.on("end", () => {
            try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
        });
        req.on("error", reject);
    });
}

// ── OpenAI response builders ──────────────────────────────────────────────────

function makeChunk(
    taskId: string,
    agentName: string,
    content: string,
    finishReason: string | null = null
): string {
    return JSON.stringify({
        id: `chatcmpl-${taskId.replace(/-/g, "").slice(0, 20)}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: agentName,
        choices: [{
            index: 0,
            delta: finishReason !== null ? {} : { role: "assistant", content },
            finish_reason: finishReason,
        }],
    });
}

function makeCompletion(
    taskId: string,
    agentName: string,
    content: string,
    promptTokens = 0,
    completionTokens = 0
): string {
    return JSON.stringify({
        id: `chatcmpl-${taskId.replace(/-/g, "").slice(0, 20)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: agentName,
        choices: [{
            index: 0,
            message: { role: "assistant", content },
            finish_reason: "stop",
        }],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
    });
}

// ── Session binding ───────────────────────────────────────────────────────────

/**
 * Resolve which agent-mcp session to bind this request to, following the
 * priority order from §6 of the SPEC.
 */
async function resolveSession(
    agentName: string,
    messages: ChatRequestMessage[],
    headerSessionId: string | undefined,
    explicitSessionId: string | undefined,
    userField: string | undefined,
    deps: GatewayDeps
): Promise<string> {
    // 1. model#sessionId override
    if (explicitSessionId) {
        try {
            const s = deps.sessionStore.read(explicitSessionId);
            if (s.status === "active") return explicitSessionId;
        } catch { /* not found or closed — fall through */ }
    }

    // 2. X-AgentMcp-Session header (PRIMARY per SPEC)
    if (headerSessionId) {
        try {
            const s = deps.sessionStore.read(headerSessionId);
            if (s.status === "active") return headerSessionId;
        } catch { /* not found — fall through */ }
    }

    // 3. Conversation-prefix fingerprint
    const fp = computeFingerprint(messages, userField);
    const cached = fingerprintMap.get(fp);
    if (cached) {
        try {
            const s = deps.sessionStore.read(cached);
            if (s.status === "active") return cached;
        } catch { /* session gone */ }
        fingerprintMap.delete(fp);
    }

    // 4. Cold start: create a new session for this agent
    const sessionDeps: SessionDeps = {
        agentStore: deps.agentStore,
        sessionStore: deps.sessionStore,
        policy: deps.taskDeps.policy,
    };
    const out = await agentTool({ name: agentName }, sessionDeps);
    const newSessionId = out.session_id;
    fingerprintMap.set(fp, newSessionId);
    return newSessionId;
}

// ── HITL helpers ──────────────────────────────────────────────────────────────

/**
 * Walk session message history backwards to find the HITL question that the
 * agent emitted before suspending (the request_human_input tool call's prompt
 * argument is stored in the assistant message persisted by the orchestrator).
 */
function readHitlQuestion(sessionId: string, deps: GatewayDeps): string {
    try {
        const msgs = deps.sessionStore.getMessages(sessionId);
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
                for (const tc of msg.toolCalls) {
                    if (tc.tool === "request_human_input") {
                        const args = tc.arguments as { prompt?: string } | null;
                        return args?.prompt ?? "Please provide input:";
                    }
                }
            }
        }
    } catch { /* best-effort */ }
    return "Please provide input:";
}

// ── Task-outcome awaiter ──────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Subscribe to the task event-bus and resolve once the task produces a
 * final answer (`done`) or suspends for HITL (`status_change: awaiting_input`).
 *
 * Performs a terminal-on-subscribe check after registering the listener to
 * handle the race where the task completes between dispatch and subscription.
 */
/**
 * @param afterResume  When true (called immediately after taskResume()), the
 *   terminal-on-subscribe check skips the `awaiting_input` case.  The task DB
 *   row may still read `awaiting_input` at the moment of subscription — before
 *   the orchestrator's microtask has had a chance to transition it to `running`.
 *   Settling on that stale status would return the HITL question a second time
 *   instead of waiting for the `done` event.  The bus subscription still handles
 *   any *future* `awaiting_input` emission correctly.
 */
function awaitTaskOutcome(
    taskId: string,
    sessionId: string,
    deps: GatewayDeps,
    timeoutMs: number,
    afterResume = false
): Promise<TaskOutcome> {
    return new Promise<TaskOutcome>((resolve) => {
        let settled = false;

        const settle = (outcome: TaskOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            resolve(outcome);
        };

        const timer = setTimeout(() => {
            settle({ content: "Agent response timed out", isHitl: false });
        }, timeoutMs);

        const unsubscribe = subscribeToTask(taskId, (event) => {
            if (event.type === "done") {
                settle({ content: event.result ?? event.error ?? "", isHitl: false });
            } else if (event.type === "status_change" && event.status === "awaiting_input") {
                settle({ content: readHitlQuestion(sessionId, deps), isHitl: true });
            }
        });

        // Terminal-on-subscribe: handle task that completed before we subscribed.
        // Guarded by `settled` so a concurrent bus event doesn't double-settle.
        // Skip awaiting_input when afterResume=true — the orchestrator microtask
        // may not yet have transitioned the DB to "running".
        try {
            const task = deps.taskStore.read(taskId);
            if (TERMINAL_STATUSES.has(task.status)) {
                settle({ content: task.result ?? task.error ?? "", isHitl: false });
            } else if (!afterResume && task.status === "awaiting_input") {
                settle({ content: readHitlQuestion(sessionId, deps), isHitl: true });
            }
        } catch { /* task may not be readable yet — the subscription will catch it */ }
    });
}

// ── Route: GET /v1/models ─────────────────────────────────────────────────────

/** List all registered agents as OpenAI-style model entries. */
export function handleGetModels(res: http.ServerResponse, deps: GatewayDeps): void {
    const agents = deps.agentStore.list();
    const data = agents.map(agent => ({
        id: agent.name,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "agent-mcp",
    }));
    const body = JSON.stringify({ object: "list", data });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
}

// ── Route: POST /v1/chat/completions ─────────────────────────────────────────

/**
 * Translate a Chat Completions request into an agent-mcp session + task.
 *
 * Handles both stream:true (SSE) and stream:false (buffered JSON).
 * Only the delta (trailing new user message) is forwarded — the resent history
 * is used only for fingerprinting and is otherwise ignored (§1 of SPEC).
 */
export async function handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: GatewayDeps
): Promise<void> {
    // ── Parse + validate body ─────────────────────────────────────────────
    let body: ChatCompletionRequest;
    try {
        body = await parseJsonBody(req) as ChatCompletionRequest;
    } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
        return;
    }

    const { model, messages, stream = false, user } = body;
    if (!model || !Array.isArray(messages) || messages.length === 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model and messages are required", type: "invalid_request_error" } }));
        return;
    }

    // ── Resolve agent ─────────────────────────────────────────────────────
    const { agentName, explicitSessionId } = parseModel(model);
    try {
        deps.agentStore.read(agentName);
    } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Agent '${agentName}' not found`, type: "invalid_request_error" } }));
        return;
    }

    // ── Resolve session ───────────────────────────────────────────────────
    const headerSessionId = req.headers["x-agentmcp-session"] as string | undefined;
    let sessionId: string;
    try {
        sessionId = await resolveSession(
            agentName, messages, headerSessionId, explicitSessionId, user, deps
        );
    } catch (err) {
        logger.error({ err, agentName }, "chat-gateway: session resolution failed");
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Failed to bind session", type: "server_error" } }));
        return;
    }

    // ── Delta extraction (§1 + §6 of SPEC) ───────────────────────────────
    // Only the LAST user message is the new turn.  Everything before it is
    // history the UI resent; agent-mcp already has it in the session store.
    const delta = extractDelta(messages);

    // ── Supplementary system context (§7 of SPEC) ─────────────────────────
    // Agent's own systemPrompt (snapshotted in the session) is authoritative.
    // The UI-supplied system message is appended as supplementary context so
    // custom instructions from the chat client reach the model without
    // overriding the agent's compiled prompt.
    const systemMsg = messages.find(m => m.role === "system");
    const prompt = (systemMsg?.content)
        ? `${delta}\n\n[Supplementary context: ${systemMsg.content}]`
        : delta;

    // ── HITL routing (§7 of SPEC) ─────────────────────────────────────────
    // If the session has a suspended awaiting_input task, the incoming user
    // message is the human's answer — route it through taskResume() and stream
    // the orchestrator's continuation on the SAME task ID.
    const awaitingTasks = deps.taskStore.list({ session_id: sessionId, status: "awaiting_input" });
    const hitlTask = awaitingTasks[0];

    let taskId: string;

    if (hitlTask) {
        if (!hitlTask.resumeToken) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "HITL task has no resume token", type: "server_error" } }));
            return;
        }
        try {
            await taskResume(
                { taskId: hitlTask.id, resumeToken: hitlTask.resumeToken, userInput: delta },
                { taskStore: deps.taskStore }
            );
        } catch (err) {
            logger.error({ err, taskId: hitlTask.id }, "chat-gateway: taskResume failed");
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: err instanceof Error ? err.message : "Resume failed", type: "server_error" } }));
            return;
        }
        taskId = hitlTask.id;
    } else {
        // Normal turn: create a new background task
        try {
            const out = await taskTool(
                { session_id: sessionId, prompt, background: true },
                deps.taskDeps
            );
            taskId = out.task_id;
        } catch (err) {
            logger.error({ err, sessionId }, "chat-gateway: task dispatch failed");
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Task dispatch failed", type: "server_error" } }));
            return;
        }
    }

    // ── Deliver response ──────────────────────────────────────────────────
    // afterResume=true skips the awaiting_input terminal-on-subscribe check:
    // the task DB row may still read awaiting_input at subscription time because
    // the orchestrator microtask has not yet transitioned it to "running".
    const afterResume = hitlTask !== undefined;
    if (stream) {
        await serveStreaming(taskId, agentName, sessionId, req, res, deps, afterResume);
    } else {
        await serveNonStreaming(taskId, agentName, sessionId, res, deps, afterResume);
    }
}

// ── Streaming response ────────────────────────────────────────────────────────

async function serveStreaming(
    taskId: string,
    agentName: string,
    sessionId: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: GatewayDeps,
    afterResume = false
): Promise<void> {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders?.();

    // Keep-alive pings while the orchestrator runs (mirrors /tasks/:id/stream)
    const pingTimer = setInterval(() => res.write(": ping\n\n"), 15_000);

    let finished = false;

    const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(pingTimer);
        res.end();
    };

    const emitContent = (content: string) => {
        res.write(`data: ${makeChunk(taskId, agentName, content)}\n\n`);
    };

    // Emit content chunk + finish-reason sentinel + [DONE]
    const emitFinal = (content: string) => {
        emitContent(content);
        res.write(`data: ${makeChunk(taskId, agentName, "", "stop")}\n\n`);
        res.write("data: [DONE]\n\n");
    };

    let settled = false;

    const settle = (outcome: TaskOutcome) => {
        if (settled || finished) return;
        settled = true;
        emitFinal(outcome.content);
        finish();
    };

    const unsubscribe = subscribeToTask(taskId, (event) => {
        if (finished) return;
        if (event.type === "token") {
            // Per-token streaming — live when the orchestrator begins emitting
            // tokens (FEAT-001).  The handler is here so the gateway is
            // forward-compatible: enabling FEAT-001 upgrades streaming
            // automatically with no gateway changes.
            emitContent(event.chunk);
        } else if (event.type === "done") {
            unsubscribe();
            settle({ content: event.result ?? event.error ?? "", isHitl: false });
        } else if (event.type === "status_change" && event.status === "awaiting_input") {
            // HITL: emit the agent's question and close the stream.
            // The next request on this session will be routed through taskResume().
            unsubscribe();
            settle({ content: readHitlQuestion(sessionId, deps), isHitl: true });
        }
    });

    // Terminal-on-subscribe: guard against tasks that completed between
    // dispatch and our subscribeToTask call.
    // Skip awaiting_input when afterResume=true (same reasoning as awaitTaskOutcome).
    try {
        const task = deps.taskStore.read(taskId);
        if (TERMINAL_STATUSES.has(task.status) && !settled) {
            unsubscribe();
            settle({ content: task.result ?? task.error ?? "", isHitl: false });
        } else if (!afterResume && task.status === "awaiting_input" && !settled) {
            unsubscribe();
            settle({ content: readHitlQuestion(sessionId, deps), isHitl: true });
        }
    } catch { /* task may not be readable yet */ }

    // Client disconnect: clean up subscription and end response
    req.on("close", () => {
        unsubscribe();
        finish();
    });
}

// ── Non-streaming response ────────────────────────────────────────────────────

async function serveNonStreaming(
    taskId: string,
    agentName: string,
    sessionId: string,
    res: http.ServerResponse,
    deps: GatewayDeps,
    afterResume = false
): Promise<void> {
    const outcome = await awaitTaskOutcome(taskId, sessionId, deps, 300_000, afterResume);
    const body = makeCompletion(taskId, agentName, outcome.content);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
}
