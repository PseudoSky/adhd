/**
 * c536ce29 FIX-L1 — the SSE MCP client routes BOTH the event-stream GET and the JSON-RPC POSTs
 * through `EngineConfig.wire.fetch`. Real loopback SSE MCP server (node:http); nothing mocked.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { SseMcpClient } from "../clients/http-client.js";
import type { EngineConfig } from "../interfaces.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
    await close?.();
    close = undefined;
});

async function startSseServer(): Promise<string> {
    let stream: ServerResponse | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.method === "GET" && req.url === "/sse") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            res.write("event: endpoint\ndata: /messages\n\n");
            stream = res;
            return;
        }
        if (req.method === "POST" && req.url === "/messages") {
            let body = "";
            req.on("data", (c) => (body += c));
            req.on("end", () => {
                const msg = JSON.parse(body) as { id?: number; method: string };
                res.writeHead(202).end("Accepted");
                if (msg.method === "initialize") {
                    const result = { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "loop", version: "1" } };
                    stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n\n`);
                }
            });
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    close = async () => {
        stream?.end();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    };
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("c536ce29 FIX-L1 SSE MCP client uses the wire fetch for POSTs as well as the stream", () => {
    it("every request (GET /sse and POST /messages) passes through wire.fetch", async () => {
        const origin = await startSseServer();
        const seen: string[] = [];
        const wireFetch: typeof fetch = (input, init) => {
            const url = input instanceof URL ? input.href : String((input as Request).url ?? input);
            seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
            return fetch(input, init);
        };
        const config = { wire: { fetch: wireFetch, wrapTransport: (t: unknown) => t } } as unknown as EngineConfig;
        const client = new SseMcpClient("loop", { transport: "sse", url: `${origin}/sse` } as never, config);
        await client.connect();
        await client.close();

        expect(seen).toContain("GET /sse");
        // The initialize request and the initialized notification are POSTs: without the fix none of
        // these are seen by the seam (only the event-stream GET was).
        expect(seen.filter((s) => s === "POST /messages").length).toBeGreaterThanOrEqual(2);
    });
});
