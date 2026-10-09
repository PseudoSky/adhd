/**
 * c536ce29 P1 (provider egress through EngineConfig.wire) - unit lane, loopback HTTP only.
 *
 *   TRC-AC2/AC3  a real OpenAI-shaped and a real Anthropic-shaped (SSE streamed) provider call
 *                through the PRODUCTION wiring (`toEngineConfig()` + `createWireSeams()` over real
 *                channels) writes http.request / http.response records whose bodies are
 *                byte-identical to what the loopback server saw / sent; credentials never reach disk
 *   TRC-AC6      the engine's real HTTP MCP client against a real local streamable-HTTP MCP server
 *                writes mcp.send / mcp.recv through the same wiring
 *   TRC-AC9      a 400 and a refused connection are logged AND surface to the caller exactly as the
 *                unwrapped path surfaces them
 *   P1-AC-B      with the inert (uninstalled) channels the wired providers behave identically and
 *                nothing is written; with no `wire` the SDK option object is untouched
 *
 * Nothing here reaches a non-loopback host: the base fetch is a guard that fails the test loudly.
 */
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProvider, HttpMcpClient, type EngineLogger } from "@adhd/agent-engine-orchestrator";

import { engineConfig, getWireSeams } from "../wire/seams.js";
import { getLogChannels } from "../wire/channels.js";
import {
    guardedEngineConfig,
    installChannels,
    startLoopback,
    type IChannelFixture,
    type ILoopback,
    type Rec,
} from "./provider-wire-utils.js";

// Assembled at runtime so the repo secret scan sees no key-shaped literal.
const OPENAI_SECRET = ["sk-", "p1wire", "OPENAIcanary0123456789"].join("");
const ANTHROPIC_SECRET = ["sk-ant-", "api03-", "p1wireANTHcanary0123456789"].join(""); // gitleaks:allow runtime-built canary
const SECRET_ENV = "ADHD_AGENT_P1WIRE_SECRET"; // env var NAME, not a credential  pragma: allowlist secret
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");
const log: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const messages = [{ id: "m1", sessionId: "s1", role: "user" as const, content: "ping", createdAt: new Date().toISOString() }];

const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
}

let leaks: string[];
let server: ILoopback | undefined;
let ch: IChannelFixture | undefined;

beforeEach(() => {
    leaks = [];
    setEnv(SECRET_ENV, OPENAI_SECRET); // before channel install so the redactor learns it
});
afterEach(async () => {
    await server?.close();
    server = undefined;
    await ch?.dispose();
    ch = undefined;
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
        delete saved[k];
    }
    expect(leaks, "a request left loopback").toEqual([]);
});

const openaiSelection = (origin: string) => ({
    providerType: "openai" as const,
    modelRef: "p1-test-model",
    baseURL: `${origin}/v1`,
    env: { secret: SECRET_ENV },
    retryConfig: undefined,
});
const OPENAI_OK = JSON.stringify({
    id: "c1", object: "chat.completion", created: 1, model: "p1-test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "pong" } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
});

function anthropicSse(): string[] {
    const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    return [
        ev("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "p1-claude", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } } }),
        ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "po" } }),
        ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ng" } }),
        ev("content_block_stop", { type: "content_block_stop", index: 0 }),
        ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }),
        ev("message_stop", { type: "message_stop" }),
    ];
}

describe("c536ce29 P1 provider wire (loopback)", () => {
    it("c536ce29 TRC-AC2: an OpenAI-shaped provider call writes http.request/http.response byte-identical to the wire, secret redacted", async () => {
        ch = installChannels();
        server = await startLoopback((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(OPENAI_OK); });
        const provider = createProvider(openaiSelection(server.origin), {}, guardedEngineConfig(leaks), log);
        const out = await provider.chat({ messages });
        expect(out.message.content).toBe("pong");

        const recs = await ch.records();
        const rq = recs.find((r) => r.event === "http.request");
        const rr = recs.find((r) => r.event === "http.response");
        expect(rq, "http.request").toBeDefined();
        expect(rr, "http.response").toBeDefined();
        expect(rq!.body_sha256).toBe(sha(server.seen[0]!.body));
        expect(rq!.body).toBe(server.seen[0]!.body.toString("utf8"));
        expect(rr!.status).toBe(200);
        expect(rr!.body).toBe(OPENAI_OK);
        expect(rr!.body_sha256).toBe(sha(OPENAI_OK));
        expect(rq!.call_id).toBe(rr!.call_id);
        // The credential reached the server (so the call was real) yet is on no disk.
        expect(server.seen[0]!.headers.authorization).toBe(`Bearer ${OPENAI_SECRET}`);
        expect(await ch.rawText()).not.toContain(OPENAI_SECRET);
    });

    it("c536ce29 TRC-AC3: an Anthropic-shaped SSE stream reaches the caller whole while the log holds the identical stream", async () => {
        setEnv("ANTHROPIC_BASE_URL", undefined);
        setEnv(SECRET_ENV, ANTHROPIC_SECRET);
        ch = installChannels();
        const frames = anthropicSse();
        server = await startLoopback((_q, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            for (const f of frames) res.write(f);
            res.end();
        });
        setEnv("ANTHROPIC_BASE_URL", server.origin);
        const provider = createProvider(
            { providerType: "anthropic", modelRef: "p1-claude", env: { secret: SECRET_ENV } },
            {},
            guardedEngineConfig(leaks),
            log
        );
        const out = await provider.chat({ messages });
        expect(out.message.content).toBe("pong");

        const recs = await ch.records();
        const rq = recs.find((r) => r.event === "http.request");
        const rr = recs.find((r) => r.event === "http.response");
        expect(rq!.body_sha256).toBe(sha(server.seen[0]!.body));
        expect(rr!.body).toBe(frames.join(""));
        expect(rr!.body_sha256).toBe(sha(frames.join("")));
        expect(rr!.chunk_count as number).toBeGreaterThanOrEqual(1);
        expect(await ch.rawText()).not.toContain(ANTHROPIC_SECRET);
    });

    it("c536ce29 TRC-AC9: a 400 is logged and rethrown exactly as the unwrapped path throws it", async () => {
        ch = installChannels();
        const errBody = JSON.stringify({ error: { message: "bad request p1", type: "invalid_request_error" } });
        server = await startLoopback((_q, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end(errBody); });
        const sel = openaiSelection(server.origin);
        const base = { ...guardedEngineConfig(leaks) };
        const unwired = { ...base, wire: undefined };
        const caught = async (cfg: typeof base): Promise<{ name: string; status: unknown; message: string }> => {
            try {
                await createProvider(sel, {}, cfg, log).chat({ messages });
            } catch (e) {
                const err = e as Error & { status?: unknown };
                return { name: err.name, status: err.status, message: err.message };
            }
            throw new Error("expected rejection");
        };
        const wired = await caught(base);
        expect(wired).toEqual(await caught(unwired));
        expect(wired.status).toBe(400);
        const rr = (await ch.records()).filter((r) => r.event === "http.response");
        expect(rr).toHaveLength(1); // only the wired call is logged
        expect(rr[0]!.status).toBe(400);
        expect(rr[0]!.body).toBe(errBody);
    });

    it("c536ce29 TRC-AC9: a refused connection writes http.error and rejects with the same error class as raw fetch", async () => {
        ch = installChannels();
        const dead = await startLoopback(() => undefined);
        const origin = dead.origin;
        await dead.close();
        const seams = guardedEngineConfig(leaks).wire!;
        const raw = await globalThis.fetch(`${origin}/x`).then(() => undefined, (e: Error) => e);
        const traced = await seams.fetch(`${origin}/x`).then(() => undefined, (e: Error) => e);
        expect(raw).toBeDefined();
        expect(traced).toBeDefined();
        expect(traced!.name).toBe(raw!.name);
        expect(traced!.message).toBe(raw!.message);
        expect((traced!.cause as { code?: string } | undefined)?.code).toBe((raw!.cause as { code?: string } | undefined)?.code);
        const errs = (await ch.records()).filter((r) => r.event === "http.error");
        expect(errs).toHaveLength(1);
        expect(errs[0]!.error_class).toBe(raw!.name);
    });

    it("c536ce29 TRC-AC6: the engine's HTTP MCP client over a real streamable-HTTP server writes mcp.send/mcp.recv", async () => {
        ch = installChannels();
        const mcpHttp = createHttpServer((req, res) => {
            const srv = new McpServer({ name: "p1-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
            srv.setRequestHandler(ListToolsRequestSchema, async () => ({
                tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
            }));
            srv.setRequestHandler(CallToolRequestSchema, async (r) => ({ content: [{ type: "text", text: String(r.params.arguments?.text ?? "") }] }));
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
            res.on("close", () => { void transport.close(); void srv.close(); });
            void srv.connect(transport).then(() => transport.handleRequest(req, res));
        });
        await new Promise<void>((r) => mcpHttp.listen(0, "127.0.0.1", r));
        const url = `http://127.0.0.1:${(mcpHttp.address() as AddressInfo).port}/mcp`;
        const client = new HttpMcpClient("p1-http", { transport: "http", url } as never, guardedEngineConfig(leaks));
        try {
            await client.connect();
            expect((await client.listTools()).map((t) => t.name)).toEqual(["echo"]);
            expect(await client.callTool("echo", { text: "hello-p1" })).toEqual([{ type: "text", text: "hello-p1" }]);
        } finally {
            await client.close();
            mcpHttp.closeAllConnections();
            await new Promise<void>((r) => mcpHttp.close(() => r()));
        }
        const recs = await ch.records();
        const mcp = recs.filter((r: Rec) => r.event === "mcp.send" || r.event === "mcp.recv");
        const methods = (ev: string): unknown[] => mcp.filter((r) => r.event === ev).map((r) => r.method);
        expect(methods("mcp.send")).toEqual(expect.arrayContaining(["initialize", "tools/list", "tools/call"]));
        expect(mcp.some((r) => r.event === "mcp.recv" && String(r.body).includes("hello-p1"))).toBe(true);
        expect(mcp.every((r) => r.server === "p1-http" && r.transport === "streamable-http")).toBe(true);
        // The HTTP carrier is traced too (same wire): initialize/tools POSTs appear as http.request.
        expect(recs.some((r) => r.event === "http.request")).toBe(true);
    });

    it("c536ce29 P1-AC-B: with inert channels a wired call behaves identically to the unwired call and the production config carries the seams", async () => {
        // No channels installed => the process-wide api channel is inert.
        expect(getLogChannels().apiEnabled).toBe(false);
        server = await startLoopback((_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(OPENAI_OK); });
        const sel = openaiSelection(server.origin);
        const wired = await createProvider(sel, {}, guardedEngineConfig(leaks), log).chat({ messages });
        const plain = await createProvider(sel, {}, { ...guardedEngineConfig(leaks), wire: undefined }, log).chat({ messages });
        expect({ ...wired.message, id: "", createdAt: "" }).toEqual({ ...plain.message, id: "", createdAt: "" });
        expect(wired.usage).toEqual(plain.usage);
        // The request bytes the server saw are identical with and without the seam.
        expect(server.seen[0]!.body.equals(server.seen[1]!.body)).toBe(true);
        // Production config carries the process-wide seams.
        expect(engineConfig().wire).toBe(getWireSeams());
    });
});
