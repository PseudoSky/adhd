/**
 * c536ce29 (wire tracing, W1) — `TracedTransport` over a real in-memory MCP transport pair with a
 * real MCP Server and Client (the SDK's own protocol layer).
 *
 *   c536ce29 TRC-AC6w  every JSON-RPC message is logged in both directions with ids; the protocol
 *                      still works end to end (initialize, tools/list, tools/call)
 */
import { afterEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { identityRedactor, withLogContext } from "@adhd/agent-plugin-tracing";

import { noopLogChannel } from "../wire/channels.js";
import { TracedTransport } from "../wire/index.js";
import { makeTestChannel, type ITestChannel } from "./wire-test-utils.js";

const created: ITestChannel[] = [];
afterEach(async () => {
    for (const c of created.splice(0)) await c.dispose();
});

async function connectPair(wrap: (t: InMemoryTransport) => InMemoryTransport | TracedTransport): Promise<{ client: Client; server: Server }> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "calc", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "add", description: "adds", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const a = req.params.arguments as { a: number; b: number };
        return { content: [{ type: "text", text: String(a.a + a.b) }] };
    });
    await server.connect(serverSide);
    const client = new Client({ name: "host", version: "1.0.0" }, { capabilities: {} });
    await client.connect(wrap(clientSide));
    return { client, server };
}

describe("c536ce29 TRC-AC6w TracedTransport", () => {
    it("c536ce29 TRC-AC6w: logs each message in both directions with ids, and the protocol works end to end", async () => {
        const tc = makeTestChannel();
        created.push(tc);
        const { client, server } = await connectPair((t) => new TracedTransport(t, { server: "calc", transport: "memory" }, tc.channel));
        const tools = await client.listTools();
        const result = await withLogContext({ task_id: "t-9" }, () => client.callTool({ name: "add", arguments: { a: 2, b: 40 } }));
        expect(tools.tools.map((t) => t.name)).toEqual(["add"]);
        expect((result.content as Array<{ text: string }>)[0]!.text).toBe("42");
        await client.close();
        await server.close();

        const recs = (await tc.records()).filter((r) => r.event.startsWith("mcp."));
        const sent = recs.filter((r) => r.event === "mcp.send");
        const recv = recs.filter((r) => r.event === "mcp.recv");
        expect(sent.every((r) => r.direction === "out" && r.server === "calc" && r.transport === "memory")).toBe(true);
        expect(recv.every((r) => r.direction === "in")).toBe(true);

        const methods = sent.map((r) => r.method).filter(Boolean);
        expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
        const call = sent.find((r) => r.method === "tools/call")!;
        expect(call.kind).toBe("request");
        expect(JSON.parse(call.body as string).params.arguments).toEqual({ a: 2, b: 40 });
        expect(call.task_id).toBe("t-9");
        const response = recv.find((r) => r.id === call.id)!;
        expect(response.kind).toBe("response");
        expect(JSON.parse(response.body as string).result.content[0].text).toBe("42");
        expect(response.call_id).toBe(call.call_id);
        expect(recv.map((r) => r.id)).toEqual(sent.filter((r) => r.kind === "request").map((r) => r.id));
        expect(recs.some((r) => r.event === "mcp.close")).toBe(true);
        // in-order: a request is logged before its response
        expect(recs.indexOf(call)).toBeLessThan(recs.indexOf(response));
    });

    it("c536ce29 TRC-AC6w: secrets inside JSON-RPC params are redacted; identityRedactor control leaks them", async () => {
        const CANARY = ["sk-ant-", "api03-CANARY0123456789abcdef"].join(""); // assembled at runtime so the repo secret scan sees no key-shaped literal
        for (const [redactor, leaks] of [[undefined, false], [identityRedactor, true]] as const) {
            const tc = makeTestChannel(redactor ? { redactor } : {});
            created.push(tc);
            const { client, server } = await connectPair((t) => new TracedTransport(t, { server: "calc", transport: "memory" }, tc.channel));
            await client.callTool({ name: "add", arguments: { a: 1, b: 1, api_key: CANARY } });
            await client.close();
            await server.close();
            expect((await tc.rawText()).includes("CANARY0123456789abcdef")).toBe(leaks);
        }
    });

    it("c536ce29 TRC-AC6w: an inert channel leaves the protocol working and writes nothing", async () => {
        const { client, server } = await connectPair((t) => new TracedTransport(t, { server: "calc", transport: "memory" }, noopLogChannel()));
        const result = await client.callTool({ name: "add", arguments: { a: 3, b: 4 } });
        expect((result.content as Array<{ text: string }>)[0]!.text).toBe("7");
        await client.close();
        await server.close();
    });

    it("c536ce29 TRC-AC6w: a send failure is logged as mcp.error and rethrown unchanged", async () => {
        const tc = makeTestChannel();
        created.push(tc);
        const boom = new Error("pipe closed");
        const inner = { start: async () => undefined, send: async () => { throw boom; }, close: async () => undefined };
        const t = new TracedTransport(inner, { server: "s", transport: "stdio" }, tc.channel);
        await t.start();
        await expect(t.send({ jsonrpc: "2.0", id: 1, method: "ping" })).rejects.toBe(boom);
        const err = (await tc.records()).find((r) => r.event === "mcp.error")!;
        expect(err.error_message).toBe("pipe closed");
    });
});
