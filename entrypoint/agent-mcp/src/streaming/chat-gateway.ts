import crypto from "node:crypto";
import type http from "node:http";

import { subscribeToTask } from "./event-bus.js";
import type { AgentStore } from "../store/agent-store.js";
import { logger } from "../logger.js";

import type { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import {
  taskTool,
  taskResume,
  agentTool,
} from "@adhd/agent-engine-orchestrator";
import type {
  TaskDeps,
  SessionDeps,
} from "@adhd/agent-engine-orchestrator";

export interface GatewayDeps {
    agentStore: AgentStore;
    sessionStore: SessionStore;
    taskStore: TaskStore;
    taskDeps: TaskDeps;
}

export interface GatewayDepsRef {
    value: GatewayDeps | undefined;
}

const fingerprintMap = new Map<string, string>();

export function resetFingerprintMap(): void {
    fingerprintMap.clear();
}

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
    isHitl: boolean;
}

function parseModel(model: string): { agentName: string; explicitSessionId?: string } {
    const idx = model.indexOf("#");
    return idx === -1
        ? { agentName: model }
        : { agentName: model.slice(0, idx), explicitSessionId: model.slice(idx + 1) };
}

function computeFingerprint(messages: ChatRequestMessage[], user?: string): string {
    const systemContent = messages.find(m => m.role === "system")?.content ?? "";
    const firstUser = messages.find(m => m.role === "user")?.content ?? "";
    return crypto
        .createHash("sha256")
        .update(JSON.stringify([systemContent, firstUser, user ?? ""]))
        .digest("hex")
        .slice(0, 32);
}

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

async function resolveSession(
    agentName: string,
    messages: ChatRequestMessage[],
    headerSessionId: string | undefined,
    explicitSessionId: string | undefined,
    userField: string | undefined,
    deps: GatewayDeps
): Promise<string> {
    if (explicitSessionId) {
        try {
            const s = deps.sessionStore.read(explicitSessionId);
            if (s.status === "active") return explicitSessionId;
        } catch { /* not found or closed */ }
    }

    if (headerSessionId) {
        try {
            const s = deps.sessionStore.read(headerSessionId);
            if (s.status === "active") return headerSessionId;
        } catch { /* not found */ }
    }

    const fp = computeFingerprint(messages, userField);
    const cached = fingerprintMap.get(fp);
    if (cached) {
        try {
            const s = deps.sessionStore.read(cached);
            if (s.status === "active") return cached;
        } catch { /* session gone */ }
        fingerprintMap.delete(fp);
    }

    const sessionDeps: SessionDeps = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agentStore: deps.agentStore as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionStore: deps.sessionStore as any,
        policy: deps.taskDeps.policy,
    };
    const out = await agentTool({ name: agentName }, sessionDeps);
    const newSessionId = out.session_id;
    fingerprintMap.set(fp, newSessionId);
    return newSessionId;
}

function readHitlQuestion(sessionId: string, deps: GatewayDeps): string {
    try {
        const msgs = deps.sessionStore.getMessages(sessionId) as Array<{
            role: string;
            toolCalls?: Array<{ tool: string; arguments?: { prompt?: string } }>;
        }>;
        for (let i = msgs.length - 1; i >= 0; i--) {
            const msg = msgs[i];
            if (msg.role === "assistant" && Array.isArray(msg.toolCalls)) {
                for (const tc of msg.toolCalls) {
                    if (tc.tool === "request_human_input") {
                        const args = tc.arguments;
                        return args?.prompt ?? "Please provide input:";
                    }
                }
            }
        }
    } catch { /* best-effort */ }
    return "Please provide input:";
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

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

        try {
            const task = deps.taskStore.read(taskId);
            if (TERMINAL_STATUSES.has(task.status)) {
                settle({ content: task.result ?? task.error ?? "", isHitl: false });
            } else if (!afterResume && task.status === "awaiting_input") {
                settle({ content: readHitlQuestion(sessionId, deps), isHitl: true });
            }
        } catch { /* task may not be readable yet */ }
    });
}

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

export async function handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    deps: GatewayDeps
): Promise<void> {
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

    const { agentName, explicitSessionId } = parseModel(model);
    try {
        deps.agentStore.read(agentName);
    } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `Agent '${agentName}' not found`, type: "invalid_request_error" } }));
        return;
    }

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

    const delta = extractDelta(messages);

    const systemMsg = messages.find(m => m.role === "system");
    const prompt = (systemMsg?.content)
        ? `${delta}\n\n[Supplementary context: ${systemMsg.content}]`
        : delta;

    const awaitingTasks = deps.taskStore.list({ session_id: sessionId, status: "awaiting_input" });
    const hitlTask = awaitingTasks[0] as { id: string; resumeToken?: string } | undefined;

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

    const afterResume = hitlTask !== undefined;
    if (stream) {
        await serveStreaming(taskId, agentName, sessionId, req, res, deps, afterResume);
    } else {
        await serveNonStreaming(taskId, agentName, sessionId, res, deps, afterResume);
    }
}

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
            emitContent(event.chunk);
        } else if (event.type === "done") {
            unsubscribe();
            settle({ content: event.result ?? event.error ?? "", isHitl: false });
        } else if (event.type === "status_change" && event.status === "awaiting_input") {
            unsubscribe();
            settle({ content: readHitlQuestion(sessionId, deps), isHitl: true });
        }
    });

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

    req.on("close", () => {
        unsubscribe();
        finish();
    });
}

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
