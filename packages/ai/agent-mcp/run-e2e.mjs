#!/usr/bin/env node
/**
 * E2E test runner for agent-mcp.
 * Spawns the agent-mcp server, creates (or reuses) an e2e-runner agent,
 * submits E2E_PROMPT.md as a task, and polls until done.
 *
 * Usage:
 *   node packages/ai/agent-mcp/run-e2e.mjs
 *
 * Env vars (all optional — defaults match local dev setup):
 *   DATABASE_PATH       path to the SQLite DB
 *   LMSTUDIO_API_KEY    LM Studio API key
 *   LMSTUDIO_BASE_URL   LM Studio base URL
 *   AGENT_MCP_DIST      path to compiled index.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DIST =
    process.env.AGENT_MCP_DIST ??
    path.resolve(__dirname, "../../../dist/packages/ai/agent-mcp/src/index.js");

const DB =
    process.env.DATABASE_PATH ??
    path.resolve(__dirname, "data/agents.db");

const LMSTUDIO_API_KEY =
    process.env.LMSTUDIO_API_KEY ?? "sk-lm-aTPoK9Gs:qf2Ncsq8ezFfN6kIALi5";

const LMSTUDIO_BASE_URL =
    process.env.LMSTUDIO_BASE_URL ?? "http://192.168.1.59:1234/v1";

const RUNNER_MODEL =
    "qwen3.5-9b-claude-4.6-highiq-instruct-heretic-uncensored-mlx-mxfp8";

const RUNNER_NAME = "e2e-runner";
const POLL_MS = 15_000;
const TIMEOUT_MS = 15 * 60 * 1000; // 15 min — delegation tasks are slow

const E2E_PROMPT = readFileSync(
    path.resolve(__dirname, "E2E_PROMPT.md"),
    "utf-8"
);

// ---------------------------------------------------------------------------

async function callTool(client, name, args = {}) {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function ensureRunnerAgent(client) {
    const agents = await callTool(client, "agent_list");
    if (agents.some((a) => a.name === RUNNER_NAME)) {
        console.log(`Agent '${RUNNER_NAME}' already exists.`);
        return;
    }
    console.log(`Creating agent '${RUNNER_NAME}'...`);
    await callTool(client, "agent_create", {
        name: RUNNER_NAME,
        provider: {
            type: "lmstudio",
            model: RUNNER_MODEL,
            apiKeyEnv: "LMSTUDIO_API_KEY",
            baseURL: LMSTUDIO_BASE_URL,
            timeoutMs: 300_000,
        },
        systemPrompt:
            "You are an automated E2E test runner. " +
            "Follow the test plan exactly, use the available tools, and report results.",
        mcpServers: {
            "agent-mcp": {
                transport: "stdio",
                command: "node",
                args: [DIST],
                env: {
                    DATABASE_PATH: DB,
                    LMSTUDIO_API_KEY,
                    LMSTUDIO_BASE_URL,
                },
            },
        },
        permissions: {},
    });
}

async function poll(client, taskId) {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const res = await callTool(client, "result", { task_id: taskId });
        const done = ["completed", "failed", "cancelled"].includes(res.status);
        process.stdout.write(`  [${new Date().toISOString()}] status: ${res.status}\n`);
        if (done) return res;
    }
    throw new Error(`Timed out after ${TIMEOUT_MS / 60_000} minutes`);
}

async function main() {
    console.log("=== agent-mcp E2E runner ===\n");
    console.log(`  dist   : ${DIST}`);
    console.log(`  db     : ${DB}`);
    console.log(`  lm url : ${LMSTUDIO_BASE_URL}\n`);

    const transport = new StdioClientTransport({
        command: "node",
        args: [DIST],
        env: {
            ...process.env,
            DATABASE_PATH: DB,
            LMSTUDIO_API_KEY,
            LMSTUDIO_BASE_URL,
            ALLOWED_AGENTS: "",
        },
    });

    const client = new Client({ name: "e2e-runner-client", version: "1.0.0" });
    await client.connect(transport);
    console.log("Connected to agent-mcp server.\n");

    await ensureRunnerAgent(client);

    const session = await callTool(client, "agent", { name: RUNNER_NAME });
    const sessionId = session.session_id;
    console.log(`Session: ${sessionId}`);

    const task = await callTool(client, "task", {
        session_id: sessionId,
        prompt: E2E_PROMPT,
        background: true,
    });
    const taskId = task.task_id;
    console.log(`Task:    ${taskId}\n`);
    console.log("Polling for results...");

    const result = await poll(client, taskId);

    console.log("\n" + "=".repeat(60));
    if (result.status === "completed") {
        console.log(result.result);
        await client.close();
        process.exit(0);
    } else {
        console.error(`\nE2E ${result.status.toUpperCase()}`);
        if (result.error) console.error(result.error);
        await client.close();
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
