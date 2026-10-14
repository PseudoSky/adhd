/**
 * 49cec55e - the engine-native `web_fetch` reaches the `agent-mcp.api` wire log again.
 *
 * Since the SSRF fix (bc799330) `web_fetch` connects to a validated, pinned IP through
 * `node:http(s).request`, so the traced `fetch` never sees it. `tracedRequest` wraps that request
 * function. Driven here through the REAL `executeWebFetch` (DNS stubbed, the socket leaf faked by
 * `fakeNet`) writing to a REAL file-backed api channel; nothing touches the network.
 *
 *   49cec55e AC1  every request, redirect hop and failover attempt writes http.* records carrying ONLY
 *                 host, method, status, wire byte count and the validated IP (plus the envelope ids);
 *                 never the body, a header, the path/query or a credential
 *   49cec55e AC2  the record comes from the injected `request` seam (`WebFetchOptions.request`), not fetch
 *   49cec55e AC3  tracing is a pure pass-through (inert channel, throwing channel); the SSRF refusals hold
 *                 when traced (a refused hop never reaches the seam)
 *
 * Negative control (AC3): make `tracedRequest` return `base(options)` unconditionally and the AC1/AC2
 * tests below go red (no records are written).
 */
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { executeWebFetch } from "@adhd/agent-engine-orchestrator";
import { withLogContext, type LogChannel } from "@adhd/agent-plugin-tracing";

import { noopLogChannel } from "../wire/channels.js";
import { tracedRequest } from "../wire/index.js";
import { fakeNet, type IFakeReply } from "./web-fetch-wire-net.js";
import { makeTestChannel, type ITestChannel, type Rec } from "./wire-test-utils.js";

const CANARY = ["sk-ant-", "api03-WEBFETCH0123456789canary"].join(""); // assembled at runtime: no key-shaped literal in the repo
const PUBLIC_A = "203.0.113.9";
const PUBLIC_B = "198.51.100.7";

const channels: ITestChannel[] = [];
afterEach(async () => {
    for (const c of channels.splice(0)) await c.dispose();
});
function track(): ITestChannel {
    const c = makeTestChannel();
    channels.push(c);
    return c;
}

const resolver = (map: Record<string, string[]>) => async (host: string) =>
    (map[host] ?? []).map((address) => ({ address, family: (address.includes(":") ? 6 : 4) as 4 | 6 }));

const page = (text: string): IFakeReply => ({
    status: 200,
    headers: { "content-type": "text/plain" },
    body: Buffer.from(text),
});

describe("49cec55e AC1 the wire log records every web_fetch request", () => {
    it("49cec55e AC1: a fetch writes http.request + http.response with ONLY host, method, status, wire bytes and the validated IP", async () => {
        const tc = track();
        const gz = gzipSync(Buffer.from(`hello ${"x".repeat(5000)} ${CANARY}-in-body`));
        const net = fakeNet(() => ({
            status: 200,
            headers: { "content-type": "text/plain", "content-encoding": "gzip", "set-cookie": `session=${CANARY}` },
            body: gz,
        }));
        const out = (await executeWebFetch(
            { url: `https://news.example.com:8443/private/path?token=${CANARY}` },
            { resolve: resolver({ "news.example.com": [PUBLIC_A] }), request: tracedRequest(tc.channel, net.request) }
        )) as { content: { source: { data: string } } };
        expect(out.content.source.data).toContain("hello"); // the caller got the decoded page unchanged

        const recs = (await tc.records()).filter((r) => r.event.startsWith("http."));
        expect(recs.map((r) => r.event)).toEqual(["http.request", "http.response"]);
        const [req, res] = recs as [Rec, Rec];
        // The channel's own envelope keys are whatever an empty record carries; everything beyond them is payload.
        tc.channel.logRaw("probe", {});
        const probe = (await tc.records()).find((r) => r.event === "probe")!;
        const envelope = new Set(Object.keys(probe));
        const payload = (r: Rec) => Object.fromEntries(Object.entries(r).filter(([k]) => !envelope.has(k) && k !== "call_id"));
        expect(req.call_id).toBeTruthy();
        expect(res.call_id).toBe(req.call_id);
        expect(payload(req)).toMatchObject({ method: "GET", scheme: "https", host: "news.example.com", port: 8443, ip: PUBLIC_A });
        expect(payload(res)).toMatchObject({ method: "GET", scheme: "https", host: "news.example.com", port: 8443, ip: PUBLIC_A, status: 200, complete: true });
        // wire bytes = what crossed the socket (the compressed length), not the decoded text length.
        expect(res.wire_bytes).toBe(gz.length);
        expect(gz.length).toBeLessThan(5000);
        // The payload keys are an allow-list: nothing else (no url, path, headers, body) can ride along.
        const allowed = new Set(["method", "scheme", "host", "port", "ip", "status", "wire_bytes", "complete"]);
        expect(Object.keys(payload(req)).filter((k) => !allowed.has(k))).toEqual([]);
        expect(Object.keys(payload(res)).filter((k) => !allowed.has(k))).toEqual([]);
        // Teeth: the canary appears in the path/query, a request-visible secret, a response header and the body.
        const raw = await tc.rawText();
        expect(raw).not.toContain(CANARY);
        expect(raw).not.toContain("private/path");
        expect(raw).not.toContain("set-cookie");
        expect(raw).not.toContain("accept-encoding");
    });

    it("49cec55e AC1: each redirect hop is its own request/response pair, with its own validated IP", async () => {
        const tc = track();
        const net = fakeNet((ip) =>
            ip === PUBLIC_A
                ? { status: 302, headers: { location: "https://other.example.org/landing?next=1" } }
                : page("landed")
        );
        await executeWebFetch(
            { url: "http://first.example.com/start" },
            { resolve: resolver({ "first.example.com": [PUBLIC_A], "other.example.org": [PUBLIC_B] }), request: tracedRequest(tc.channel, net.request) }
        );
        const recs = await tc.records();
        expect(recs.map((r) => r.event)).toEqual(["http.request", "http.response", "http.request", "http.response"]);
        expect(recs.map((r) => [r.host, r.ip])).toEqual([
            ["first.example.com", PUBLIC_A], ["first.example.com", PUBLIC_A],
            ["other.example.org", PUBLIC_B], ["other.example.org", PUBLIC_B],
        ]);
        expect(recs.filter((r) => r.event === "http.response").map((r) => r.status)).toEqual([302, 200]);
        expect(new Set(recs.map((r) => r.call_id)).size).toBe(2);
    });

    it("49cec55e AC1: a refused connect writes http.error and the failover attempt is a second record set", async () => {
        const tc = track();
        const net = fakeNet(() => page("ok"), { [PUBLIC_A]: "ECONNREFUSED" });
        await executeWebFetch(
            { url: "https://flaky.example.com/" },
            { resolve: resolver({ "flaky.example.com": [PUBLIC_A, PUBLIC_B] }), request: tracedRequest(tc.channel, net.request) }
        );
        const recs = await tc.records();
        expect(recs.map((r) => `${r.event}@${r.ip}`)).toEqual([
            `http.request@${PUBLIC_A}`, `http.error@${PUBLIC_A}`,
            `http.request@${PUBLIC_B}`, `http.response@${PUBLIC_B}`,
        ]);
        const err = recs[1]!;
        expect(err.error_code).toBe("ECONNREFUSED");
        expect(err.call_id).toBe(recs[0]!.call_id);
        expect(err.host).toBe("flaky.example.com");
    });

    it("49cec55e AC1: records carry the ambient withLogContext ids", async () => {
        const tc = track();
        const net = fakeNet(() => page("ok"));
        await withLogContext({ task_id: "t-web", session_id: "s-web" }, () =>
            executeWebFetch({ url: "https://ctx.example.com/" }, { resolve: resolver({ "ctx.example.com": [PUBLIC_A] }), request: tracedRequest(tc.channel, net.request) })
        );
        const recs = await tc.records();
        expect(recs.map((r) => r.event)).toEqual(["http.request", "http.response"]); // teeth: a loop over zero records would pass
        for (const r of recs) {
            expect(r.task_id).toBe("t-web");
            expect(r.session_id).toBe("s-web");
        }
    });
});

describe("49cec55e AC3 tracing never changes behaviour", () => {
    it("49cec55e AC3: a refused destination never reaches the seam, so nothing is logged for it", async () => {
        const tc = track();
        const net = fakeNet(() => page("secret"));
        await expect(
            executeWebFetch({ url: "http://169.254.169.254/latest/meta-data/" }, { request: tracedRequest(tc.channel, net.request) })
        ).rejects.toThrow(/link-local/);
        expect(net.calls).toHaveLength(0);
        expect(await tc.records()).toEqual([]);
    });

    it("49cec55e AC3: the connection is made to the validated IP with the name in Host, exactly as untraced", async () => {
        const tc = track();
        const net = fakeNet(() => page("ok"));
        await executeWebFetch({ url: "https://pin.example.com/a" }, { resolve: resolver({ "pin.example.com": [PUBLIC_A] }), request: tracedRequest(tc.channel, net.request) });
        expect(net.calls.map((c) => c.host)).toEqual([PUBLIC_A]);
        expect((net.calls[0]!.headers as Record<string, string>)["host"]).toBe("pin.example.com");
    });

    it("49cec55e AC3: an inert channel is a pure pass-through (the base request object is returned, nothing written)", () => {
        const net = fakeNet(() => page("ok"));
        const traced = tracedRequest(noopLogChannel(), net.request);
        const req = traced({ protocol: "http:", host: PUBLIC_A, method: "GET", headers: { host: "x.example.com" } });
        expect(net.calls).toHaveLength(1);
        expect(req.listenerCount("response")).toBe(0); // no tracing listeners were attached
    });

    it("49cec55e AC3: a channel that throws on every write never reaches the caller", async () => {
        const boom = new Proxy({} as LogChannel, {
            get: (_t, prop) => (prop === "logRaw" ? () => { throw new Error("sink down"); } : () => undefined),
        });
        const net = fakeNet(() => page("still fine"));
        const out = (await executeWebFetch(
            { url: "https://boom.example.com/" },
            { resolve: resolver({ "boom.example.com": [PUBLIC_A] }), request: tracedRequest(boom, net.request) }
        )) as { content: { source: { data: string } } };
        expect(out.content.source.data).toContain("still fine");
    });
});
