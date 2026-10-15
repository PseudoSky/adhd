/**
 * task-events-stdio.e2e.test.ts — facd4aaa AC5. The `task_events` tool, as a host reaches it.
 *
 * A real MCP client (`@modelcontextprotocol/sdk` Client over StdioClientTransport) spawns the REAL built
 * agent-mcp entry (`dist/src/index.js`) with an isolated fake HOME, cwd and operational database, then calls
 * `tools/list` and `tools/call` over JSON-RPC. Nothing reaches into the server's functions.
 *
 * Fixture: the operational database is migrated and seeded BEFORE the server starts, with one completed task
 * and three `task_events` rows that share one `created_at` (emit order is their insertion order). The server
 * reads that file through `ADHD_AGENT_DATABASE_PATH`.
 *
 * Assertions (over the wire):
 *   - `tools/list` advertises `task_events` with `task_id` required and `limit` / `offset` properties.
 *   - A page of the seeded task returns `total` 3, `has_more` true, the first two events in emit order, and a
 *     parsed payload on the TOOL_RESULT row.
 *   - The final window returns the last event with `has_more` false.
 *   - An unknown uuid is an error result naming TASK_NOT_FOUND, not an empty page.
 *   - `limit` 501 is an error result (the boundary is enforced by the server, not only by the unit schema).
 *
 * Tier: P. Fidelity gap: this cannot be observed at tier S because only a spawned built server over stdio
 * exercises the MCP tool registration, the `dist/` artifact, the environment cascade and the stdio JSON-RPC
 * framing that a host depends on.
 *
 * Real-run case (AC5): the same server also runs a REAL task. `agent_create` (anthropic provider, native tooling
 * off) -> `agent` -> `task` go over stdio to the built server, whose Anthropic SDK talks over HTTP to an
 * in-process loopback model server on 127.0.0.1 (`ANTHROPIC_BASE_URL`, the repository's existing loopback-model
 * pattern from integration/provider-selection.e2e.test.ts). The model is the only scripted boundary. The test
 * then reads the events the run recorded back through `task_events` and asserts their order
 * (MODEL_REQUEST before MODEL_RESPONSE before TASK_COMPLETED, TASK_COMPLETED last) and paging
 * (limit 1 windows concatenate to the full list, `total` equals its length, `has_more` falls to false).
 *
 * Not covered, stated precisely: a run that calls a tool (no TOOL_CALL / TOOL_RESULT events are asserted from a
 * real run; those payloads are covered only by the seeded task above), and a byte-budget truncation over the
 * wire (covered at tier S in task-events-tool.test.ts).
 *
 * Not env-gated (ADR-0009 e2e lane). Fails loudly if the built entry is missing; it never skips.
 *
 * Tag: regression:facd4aaa (AC5).
 * Red: pending (user hold). Tests cannot run until the hold is released. Expected red at facd4aaa^ (the tool is
 * not advertised, so the tools/list and tools/call cases fail with the missing-tool assertion).
 */
import fs from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyLockingPragmas } from "@adhd/agent-core-env";

import { runMigrationsOn } from "../db/migrate-runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, "..", "..");
const DIST_ENTRY = path.join(PACKAGE_ROOT, "dist", "src", "index.js");
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const TMP_ROOT = path.join(REPO_ROOT, "tmp", "agent-mcp", "task-events-stdio");

const TASK_ID = "a7c3e1f0-5b2d-4e8a-9c61-0d4f2b8e7a19";
const UNKNOWN_TASK_ID = "b8d4f2a1-6c3e-4f9b-8d72-1e5a3c9f8b20";
const SHARED_CREATED_AT = "2026-01-01T00:00:00.000Z";

let tmpDir: string;
let fakeHome: string;
let dbPath: string;
let client: Client;
let modelServer: HttpServer;
let modelOrigin: string;
let modelRequests = 0;

/** One streamed Anthropic message with a single text block: the whole scripted model. */
const MODEL_SSE = [
  ["message_start", { type: "message_start", message: { id: "msg_te", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }],
  ["message_stop", { type: "message_stop" }],
] as const;

/** Child env: strip ambient `ADHD_AGENT_*`, pin the operational DB to the seeded file, force stdio. */
function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("ADHD_AGENT_")) continue;
    if (value !== undefined) env[key] = value;
  }
  env.HOME = fakeHome;
  env.ADHD_AGENT_DATABASE_PATH = dbPath;
  env.ADHD_AGENT_TRANSPORT = "stdio";
  env.ADHD_AGENT_SSE_ENABLED = "false";
  // The real-run case: the child's Anthropic SDK talks to the loopback model, never to the internet.
  env.ANTHROPIC_BASE_URL = modelOrigin;
  env.ADHD_AGENT_ANTHROPIC_SECRET = "sk-ant-api-task-events-e2e"; // pragma: allowlist secret — synthetic loopback value
  return env;
}

/** Migrates the operational DB and inserts one completed task with three events sharing a timestamp. */
function seedOperationalStore(file: string): void {
  const sqlite = new Database(file);
  applyLockingPragmas(sqlite, { busyTimeoutMs: 5_000 });
  // Raw inserts below do not register an owning agent; the production FK constraint is not under test here.
  sqlite.pragma("foreign_keys = OFF");
  runMigrationsOn(sqlite, drizzle(sqlite));
  sqlite
    .prepare(
      "INSERT INTO tasks (id, session_id, status, prompt, created_at, updated_at, completed_at) VALUES (?, NULL, 'completed', 'seeded', ?, ?, ?)",
    )
    .run(TASK_ID, SHARED_CREATED_AT, SHARED_CREATED_AT, SHARED_CREATED_AT);
  const insert = sqlite.prepare(
    "INSERT INTO task_events (id, task_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run(
    "10000000-0000-4000-8000-000000000001",
    TASK_ID,
    "TOOL_RESULT",
    JSON.stringify({ result: "seeded tool text", result_sha256: "0".repeat(64) }),
    SHARED_CREATED_AT,
  );
  insert.run(
    "20000000-0000-4000-8000-000000000002",
    TASK_ID,
    "MODEL_REQUEST",
    JSON.stringify({ advertisedToolNames: ["test-server__echo"], systemPromptSha256: null }),
    SHARED_CREATED_AT,
  );
  insert.run(
    "30000000-0000-4000-8000-000000000003",
    TASK_ID,
    "TASK_COMPLETED",
    JSON.stringify({ ok: true }),
    SHARED_CREATED_AT,
  );
  sqlite.close();
}

/** Parses the single text block of a tool result as JSON. */
function parseText(result: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const text = (result.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? "";
  return JSON.parse(text);
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? "";
}

describe("facd4aaa AC5 task_events over stdio JSON-RPC against the built server", () => {
  beforeAll(async () => {
    expect(
      fs.existsSync(DIST_ENTRY),
      `expected built entry at ${DIST_ENTRY}; run "npx nx build agent-mcp" first`,
    ).toBe(true);

    modelServer = createHttpServer((req, res) => {
      req.resume();
      req.on("end", () => {
        modelRequests++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [event, data] of MODEL_SSE) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", r));
    modelOrigin = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;

    fs.mkdirSync(TMP_ROOT, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(TMP_ROOT, "run-"));
    fakeHome = path.join(tmpDir, "home");
    fs.mkdirSync(fakeHome, { recursive: true });
    dbPath = path.join(tmpDir, "agents.db");
    seedOperationalStore(dbPath);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_ENTRY],
      env: buildChildEnv(),
      // Hermetic cwd: no `.env` at any level of the hierarchy, so the seeded DB path is the only override.
      cwd: tmpDir,
    });
    client = new Client({ name: "task-events-e2e", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore: the child may already have exited */
    }
    try {
      await new Promise<void>((r) => modelServer?.close(() => r()));
    } catch {
      /* ignore: teardown is best effort after assertions have run */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore: teardown is best effort after assertions have run */
    }
  });

  it("facd4aaa AC5: tools/list advertises task_events with task_id required and limit / offset properties", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "task_events");

    expect(tool, "task_events must be advertised to a host").toBeDefined();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(schema.properties ?? {})).toEqual(expect.arrayContaining(["task_id", "limit", "offset"]));
    expect(schema.required).toContain("task_id");
  });

  it("facd4aaa AC5: a page of the seeded task returns total 3, has_more true, the first two events in emit order, and a parsed payload", async () => {
    const result = await client.callTool({ name: "task_events", arguments: { task_id: TASK_ID, limit: 2, offset: 0 } });
    expect(result.isError).not.toBe(true);
    const page = parseText(result) as {
      total: number;
      has_more: boolean;
      events: Array<{ id: string; type: string; created_at: string; payload: Record<string, unknown> | null }>;
    };

    expect(page.total).toBe(3);
    expect(page.has_more).toBe(true);
    expect(page.events.map((e) => e.type)).toEqual(["TOOL_RESULT", "MODEL_REQUEST"]);
    expect(page.events.map((e) => e.id)).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ]);
    expect(page.events[0]!.created_at).toBe(SHARED_CREATED_AT);
    expect(page.events[0]!.payload).toEqual({ result: "seeded tool text", result_sha256: "0".repeat(64) });
    expect(page.events[1]!.payload).toEqual({ advertisedToolNames: ["test-server__echo"], systemPromptSha256: null });
  });

  it("facd4aaa AC5: the final window returns the last event with has_more false", async () => {
    const result = await client.callTool({ name: "task_events", arguments: { task_id: TASK_ID, limit: 2, offset: 2 } });
    const page = parseText(result) as { total: number; has_more: boolean; events: Array<{ type: string }> };

    expect(page.total).toBe(3);
    expect(page.events.map((e) => e.type)).toEqual(["TASK_COMPLETED"]);
    expect(page.has_more).toBe(false);
  });

  it("facd4aaa AC5: an unknown task_id is an error result naming TASK_NOT_FOUND, not an empty page", async () => {
    const result = await client.callTool({ name: "task_events", arguments: { task_id: UNKNOWN_TASK_ID } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("TASK_NOT_FOUND");
  });

  it("facd4aaa AC5: limit 501 is an error result over the wire (the bound is enforced by the server)", async () => {
    const result = await client.callTool({ name: "task_events", arguments: { task_id: TASK_ID, limit: 501 } });

    expect(result.isError).toBe(true);
  });

  it("facd4aaa AC5: a REAL task run through the server (loopback model only) is read back over stdio in recorded order with consistent paging", async () => {
    const created = await client.callTool({
      name: "agent_create",
      arguments: {
        name: "task-events-e2e-agent",
        provider: { type: "anthropic", model: "claude-sonnet-4-6", env: { secret: "ADHD_AGENT_ANTHROPIC_SECRET" } },
        systemPrompt: "You are a test agent.",
        mcpServers: {},
        permissions: {},
        nativeTooling: { fs: false, shell: false, dispatch: false },
      },
    });
    expect(created.isError, textOf(created)).not.toBe(true);
    const { session_id } = parseText(await client.callTool({ name: "agent", arguments: { name: "task-events-e2e-agent" } })) as { session_id: string };
    const run = await client.callTool({ name: "task", arguments: { session_id, prompt: "ping" } });
    expect(run.isError, textOf(run)).not.toBe(true);
    const done = parseText(run) as { task_id: string; status: string; result?: string };
    expect(done.status).toBe("completed");
    expect(done.result).toBe("pong");
    expect(modelRequests).toBeGreaterThanOrEqual(1);

    type Page = { total: number; offset: number; has_more: boolean; events: Array<{ id: string; type: string; created_at: string }> };
    const full = parseText(await client.callTool({ name: "task_events", arguments: { task_id: done.task_id, limit: 500 } })) as Page;
    const types = full.events.map((e) => e.type);
    expect(full.total).toBe(full.events.length);
    expect(full.has_more).toBe(false);
    expect(types.indexOf("MODEL_REQUEST")).toBeGreaterThanOrEqual(0);
    expect(types.indexOf("MODEL_RESPONSE")).toBeGreaterThan(types.indexOf("MODEL_REQUEST"));
    expect(types.indexOf("TASK_COMPLETED")).toBeGreaterThan(types.indexOf("MODEL_RESPONSE"));
    expect(types[types.length - 1]).toBe("TASK_COMPLETED");

    // Paging over the same run: windows of one concatenate to the full list; has_more is true until the last.
    const ids: string[] = [];
    for (let offset = 0; offset < full.total; offset++) {
      const page = parseText(await client.callTool({ name: "task_events", arguments: { task_id: done.task_id, limit: 1, offset } })) as Page;
      expect(page.total).toBe(full.total);
      expect(page.events).toHaveLength(1);
      expect(page.has_more).toBe(offset < full.total - 1);
      ids.push(page.events[0]!.id);
    }
    expect(ids).toEqual(full.events.map((e) => e.id));
  }, 60_000);
});
