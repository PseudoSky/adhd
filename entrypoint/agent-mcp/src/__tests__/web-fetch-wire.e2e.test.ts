/**
 * 49cec55e - `tracedRequest` against REAL sockets: a real `ClientRequest` / `IncomingMessage` from
 * `node:http` talking to a real loopback server, driven through the real `executeWebFetch` pinned
 * transport and writing to a real file-backed `agent-mcp.api` channel.
 *
 * The unit tests fake the socket leaf (`fakeNet`); this proves what a fake cannot: that `close` fires on
 * a real response, `complete` is true after a full body, and `wire_bytes` is the byte count that crossed
 * the socket AFTER chunked transfer-decoding but BEFORE `Content-Encoding` is undone (the gzip length the
 * server wrote, not the decoded text length).
 *
 * The SSRF guard refuses loopback by design (bc799330), so the lab maps the validated PUBLIC address onto
 * 127.0.0.1 in `base` only (the same substitution as the orchestrator's `labRequest`): the engine still
 * validates, pins and logs the public address; only the socket destination differs.
 *
 *   49cec55e AC1  per-hop records on a real socket (302 then a chunked gzip body)
 *
 * Negative control: make `tracedRequest` return `base(options)` unconditionally and this goes red.
 */
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { executeWebFetch } from "@adhd/agent-engine-orchestrator";

import { tracedRequest, plainRequest } from "../wire/traced-request.js";
import { makeTestChannel, type ITestChannel } from "./wire-test-utils.js";

const PUBLIC_IP = "203.0.113.9";
const channels: ITestChannel[] = [];
const servers: Server[] = [];
afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
    for (const c of channels.splice(0)) await c.dispose();
});

describe("49cec55e AC1 (real sockets)", () => {
    it("49cec55e AC1: a 302 hop then a chunked gzip page: per-hop records, complete=true, wire_bytes = the compressed bytes sent", async () => {
        const tc = makeTestChannel();
        channels.push(tc);
        const gz = gzipSync(Buffer.from(`real socket page ${"y".repeat(8000)}`));
        const server = createServer((req, res) => {
            if (req.url?.startsWith("/start")) {
                res.writeHead(302, { location: "/final?secret=real-socket-canary" });
                res.end();
                return;
            }
            // No content-length: the body is chunked, and the two writes force more than one chunk.
            res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
            res.write(gz.subarray(0, 40));
            res.end(gz.subarray(40));
        });
        servers.push(server);
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        const port = (server.address() as AddressInfo).port;

        const base: typeof plainRequest = (o) => plainRequest({ ...o, host: "127.0.0.1", family: 4 });
        const out = (await executeWebFetch(
            { url: `http://lab.example.test:${port}/start` },
            {
                resolve: async () => [{ address: PUBLIC_IP, family: 4 }],
                request: tracedRequest(tc.channel, base),
            }
        )) as { content: { source: { data: string } } };
        expect(out.content.source.data).toContain("real socket page"); // decoded for the caller

        const recs = await tc.records();
        expect(recs.map((r) => r.event)).toEqual(["http.request", "http.response", "http.request", "http.response"]);
        for (const r of recs) {
            expect(r.host).toBe("lab.example.test");
            expect(r.ip).toBe(PUBLIC_IP); // the validated address, not the lab's 127.0.0.1
            expect(r.port).toBe(port);
        }
        const hop1 = recs[1]!;
        const hop2 = recs[3]!;
        expect(hop1).toMatchObject({ status: 302, complete: true });
        expect(hop2).toMatchObject({ status: 200, complete: true, wire_bytes: gz.length });
        expect(hop2.wire_bytes).toBeLessThan(8000); // wire bytes, not the decoded length
        expect(recs[0]!.call_id).not.toBe(recs[2]!.call_id);
        const raw = await tc.rawText();
        expect(raw).not.toContain("real-socket-canary");
        expect(raw).not.toContain("/final");
    });
});
