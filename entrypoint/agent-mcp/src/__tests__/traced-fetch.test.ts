/**
 * c536ce29 (wire tracing, W1) — `tracedFetch` against a real local HTTP server standing in for an LLM.
 *
 *   c536ce29 TRC-AC2  logged request/response bodies are byte-identical (sha256 + length) to what the
 *                     server received / sent; the caller gets the same response unchanged
 *   c536ce29 TRC-AC3  a streamed response reaches the caller chunk-for-chunk while the log holds the
 *                     whole stream; a body above bodyMaxBytes is truncated with exact bytes + sha256
 *   c536ce29 TRC-AC4  canary secrets (Authorization, x-api-key, URL query value, JSON api_key field,
 *                     a registered secret) never reach the file; identityRedactor control shows they would
 *   c536ce29 TRC-AC9  connection refused and AbortSignal abort write http.error with duration and the
 *                     original error is still thrown
 *   c536ce29 TRC-AC9  records carry the ambient withLogContext ids; an inert channel logs nothing and
 *                     does not change behaviour; a throwing channel never reaches the caller
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { identityRedactor, withLogContext, type LogChannel } from "@adhd/agent-plugin-tracing";

import { noopLogChannel } from "../wire/channels.js";
import { redactUrl, tracedFetch } from "../wire/index.js";
import { makeTestChannel, waitFor, type ITestChannel, type Rec } from "./wire-test-utils.js";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const CANARY = ["sk-ant-", "api03-CANARY0123456789abcdef"].join(""); // assembled at runtime so the repo secret scan sees no key-shaped literal

interface ISeen {
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body: Buffer;
}

let server: Server;
let base: string;
let seen: ISeen[];
let handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;
let tc: ITestChannel;
const channels: ITestChannel[] = [];

function track(c: ITestChannel): ITestChannel {
    channels.push(c);
    return c;
}

beforeEach(async () => {
    seen = [];
    handler = (_req, res) => res.end("ok");
    server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const body = Buffer.concat(chunks);
            seen.push({ method: req.method, url: req.url, headers: req.headers, body });
            handler(req, res, body);
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tc = track(makeTestChannel());
});

afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    for (const c of channels.splice(0)) await c.dispose();
});

async function responseRecord(c: ITestChannel, callId?: string): Promise<Rec> {
    return waitFor(async () => (await c.records()).find((r) => r.event === "http.response" && (!callId || r.call_id === callId)), "http.response");
}

describe("c536ce29 TRC-AC2 tracedFetch byte fidelity", () => {
    it("c536ce29 TRC-AC2: logged request and response bodies are byte-identical to the wire; caller gets the response unchanged", async () => {
        // Non-ASCII and NUL-free binary-ish JSON to prove bytes, not text re-encoding.
        const reqBody = JSON.stringify({ model: "m", messages: [{ role: "user", content: "héllo \u{1F600}   wörld" }], max_tokens: 4096 });
        const resBody = JSON.stringify({ id: "msg_1", content: [{ type: "text", text: "réponse \u{1F680}" }], usage: { input_tokens: 3, output_tokens: 5 } });
        handler = (_q, res) => {
            res.setHeader("content-type", "application/json");
            res.end(resBody);
        };
        const f = tracedFetch(tc.channel, fetch);
        const res = await f(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: reqBody });
        const got = Buffer.from(await res.arrayBuffer());

        expect(res.status).toBe(200);
        expect(got.toString("utf8")).toBe(resBody);
        expect(seen[0]!.body.toString("utf8")).toBe(reqBody);

        const rr = await responseRecord(tc);
        const records = await tc.records();
        const rq = records.find((r) => r.event === "http.request")!;
        expect(rq.call_id).toBe(rr.call_id);
        expect(rq.method).toBe("POST");
        expect(rq.body_bytes).toBe(seen[0]!.body.length);
        expect(rq.body_sha256).toBe(sha(seen[0]!.body));
        expect(rq.body).toBe(reqBody);
        expect(rr.status).toBe(200);
        expect(rr.body_bytes).toBe(Buffer.byteLength(resBody));
        expect(rr.body_sha256).toBe(sha(resBody));
        expect(rr.body).toBe(resBody);
        expect(rr.truncated).toBe(false);
        expect(typeof rr.latency_ms).toBe("number");
        expect(typeof rr.ttfb_ms).toBe("number");
        // request is written before the response (durable-first)
        expect(records.findIndex((r) => r.event === "http.request")).toBeLessThan(records.findIndex((r) => r.event === "http.response"));
    });

    it("c536ce29 TRC-AC2: accepts URL, Request and Uint8Array inputs without altering what is sent", async () => {
        const f = tracedFetch(tc.channel, fetch);
        const bytes = new Uint8Array([0, 1, 2, 250, 251, 252]);
        await (await f(new URL(`${base}/u`), { method: "POST", body: bytes })).text();
        await (await f(new Request(`${base}/r`, { method: "POST", body: "from-request" }))).text();
        expect(seen[0]!.body.equals(Buffer.from(bytes))).toBe(true);
        expect(seen[1]!.body.toString()).toBe("from-request");
        const rqs = (await tc.records()).filter((r) => r.event === "http.request");
        expect(rqs[0]!.body_sha256).toBe(sha(bytes));
        expect(rqs[1]!.body).toBe("from-request");
    });

    it("c536ce29 TRC-AC2: negative control - a corrupted logged digest would not match the wire", async () => {
        const f = tracedFetch(tc.channel, fetch);
        await (await f(`${base}/x`, { method: "POST", body: "abc" })).text();
        const rq = (await tc.records()).find((r) => r.event === "http.request")!;
        expect(rq.body_sha256).not.toBe(sha("abd"));
        expect(rq.body_sha256).toBe(sha("abc"));
    });
});

describe("c536ce29 TRC-AC3 tracedFetch streaming", () => {
    it("c536ce29 TRC-AC3: SSE chunks reach the caller one-for-one unchanged while the log holds the whole stream with timing", async () => {
        const events = ["data: one\n\n", "data: two\n\n", "data: three \u{1F600}\n\n"];
        handler = (_q, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            // A latch per chunk: write the next only once the previous was flushed to the socket.
            let i = 0;
            const next = (): void => {
                if (i >= events.length) return void res.end();
                res.write(events[i++], () => setTimeout(next, 15));
            };
            next();
        };
        const f = tracedFetch(tc.channel, fetch);
        const res = await f(`${base}/stream`);
        const reader = res.body!.getReader();
        const received: Buffer[] = [];
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received.push(Buffer.from(value));
        }
        const all = Buffer.concat(received);
        expect(all.toString("utf8")).toBe(events.join(""));

        const rr = await responseRecord(tc);
        expect(rr.body).toBe(events.join(""));
        expect(rr.body_bytes).toBe(all.length);
        expect(rr.body_sha256).toBe(sha(all));
        expect(rr.chunk_count).toBe(received.length);
        const timing = rr.chunk_timing as Array<[number, number]>;
        expect(timing.length).toBe(received.length);
        expect(timing.reduce((n, [, b]) => n + b, 0)).toBe(all.length);
        expect(timing.map(([, b]) => b)).toEqual(received.map((c) => c.length));
        expect(rr.aborted).toBe(false);
        expect(rr.truncated).toBe(false);
    });

    it("c536ce29 TRC-AC3: a body above bodyMaxBytes is truncated with exact body_bytes and a sha256 of ALL bytes; caller still gets everything", async () => {
        const big = Buffer.alloc(300_000, "x");
        for (let i = 0; i < big.length; i += 1000) big[i] = 65 + ((i / 1000) % 26);
        handler = (_q, res) => {
            res.writeHead(200, { "content-length": String(big.length) });
            res.end(big);
        };
        const small = track(makeTestChannel());
        const f = tracedFetch(small.channel, fetch, { bodyMaxBytes: 1024 });
        const res = await f(`${base}/big`, { method: "POST", body: Buffer.alloc(5000, "q") });
        const got = Buffer.from(await res.arrayBuffer());
        expect(got.equals(big)).toBe(true);

        const rr = await responseRecord(small);
        expect(rr.truncated).toBe(true);
        expect(rr.body_bytes).toBe(big.length);
        expect(rr.body_sha256).toBe(sha(big));
        expect(Buffer.byteLength(rr.body as string)).toBeLessThanOrEqual(1024);
        const rq = (await small.records()).find((r) => r.event === "http.request")!;
        expect(rq.truncated).toBe(true);
        expect(rq.body_bytes).toBe(5000);
        expect(rq.body_sha256).toBe(sha(Buffer.alloc(5000, "q")));
    });

    it("c536ce29 TRC-AC3: an abort mid-stream is recorded as aborted with the partial body", async () => {
        handler = (_q, res) => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("data: first\n\n");
            // never ends; the client aborts
        };
        const ac = new AbortController();
        const f = tracedFetch(tc.channel, fetch);
        const res = await f(`${base}/hang`, { signal: ac.signal });
        const reader = res.body!.getReader();
        const first = await reader.read();
        expect(Buffer.from(first.value!).toString()).toBe("data: first\n\n");
        ac.abort();
        await expect(reader.read()).rejects.toBeDefined();
        const rr = await responseRecord(tc);
        expect(rr.aborted).toBe(true);
        expect(rr.body).toBe("data: first\n\n");
        expect((rr.error as { error_class: string }).error_class).toBe("AbortError");
    });
});

describe("c536ce29 TRC-AC4 tracedFetch redaction", () => {
    async function sendCanaries(c: ITestChannel): Promise<void> {
        const f = tracedFetch(c.channel, fetch);
        const res = await f(`${base}/v1/x?key=${CANARY}&alt=sse`, {
            method: "POST",
            headers: { authorization: `Bearer ${CANARY}`, "x-api-key": CANARY, "content-type": "application/json" },
            body: JSON.stringify({ api_key: CANARY, max_tokens: 4096, note: "plain" }),
        });
        await res.text();
        await responseRecord(c);
    }

    it("c536ce29 TRC-AC4: the canary never appears anywhere in the channel file; non-secrets are preserved", async () => {
        const c = track(makeTestChannel({ knownSecrets: ["registered-secret-value-9999"] }));
        c.channel.registerSecret("registered-secret-value-9999");
        handler = (_q, res) => res.end(JSON.stringify({ echoed: "registered-secret-value-9999" }));
        await sendCanaries(c);
        const text = await c.rawText();
        expect(text).not.toContain("CANARY0123456789abcdef");
        expect(text).not.toContain("registered-secret-value-9999");
        const rq = (await c.records()).find((r) => r.event === "http.request")!;
        expect(String(rq.body)).toContain('"max_tokens":4096');
        expect(String(rq.url)).toContain("alt=");
        expect(String(rq.url)).not.toContain("sse");
    });

    it("c536ce29 TRC-AC4: negative control - with identityRedactor the header/body canaries DO appear (the scan has teeth)", async () => {
        const c = track(makeTestChannel({ redactor: identityRedactor }));
        await sendCanaries(c);
        const text = await c.rawText();
        expect(text).toContain("CANARY0123456789abcdef");
        // ...yet the URL query value is still never logged, because tracedFetch itself redacts it.
        const rq = (await c.records()).find((r) => r.event === "http.request")!;
        expect(String(rq.url)).not.toContain("CANARY");
    });

    it("c536ce29 TRC-AC4: redactUrl strips userinfo/fragment and replaces every query value", () => {
        expect(redactUrl("https://user:pw@api.example.com/v1/m?key=abc123&x=1#frag")).toBe(
            "https://api.example.com/v1/m?key=[REDACTED:len=6]&x=[REDACTED:len=1]"
        );
        expect(redactUrl("https://api.example.com/v1/m")).toBe("https://api.example.com/v1/m");
    });
});

describe("c536ce29 TRC-AC9 tracedFetch errors, context and safety", () => {
    it("c536ce29 TRC-AC9: connection refused writes http.error with duration and rethrows the original error", async () => {
        const dead = createServer();
        await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
        const port = (dead.address() as AddressInfo).port;
        await new Promise<void>((r) => dead.close(() => r()));
        let original: unknown;
        const failing: typeof fetch = async (i, n) => {
            try {
                return await fetch(i, n);
            } catch (e) {
                original = e;
                throw e;
            }
        };
        const f = tracedFetch(tc.channel, failing);
        const thrown = await f(`http://127.0.0.1:${port}/x`).then(
            () => undefined,
            (e: unknown) => e
        );
        expect(thrown).toBeDefined();
        expect(thrown).toBe(original);
        const er = (await tc.records()).find((r) => r.event === "http.error")!;
        expect(er.error_class).toBe((original as Error).name);
        expect(er.error_message).toBe((original as Error).message);
        expect(typeof er.duration_ms).toBe("number");
        expect(er.aborted).toBe(false);
        expect(er.call_id).toBe((await tc.records()).find((r) => r.event === "http.request")!.call_id);
    });

    it("c536ce29 TRC-AC9: abort via AbortSignal writes http.error(aborted) and the AbortError reaches the caller", async () => {
        handler = () => undefined; // never respond
        const ac = new AbortController();
        const f = tracedFetch(tc.channel, fetch);
        const p = f(`${base}/slow`, { signal: ac.signal });
        await waitFor(async () => (seen.length > 0 ? true : undefined), "server to receive request");
        ac.abort();
        await expect(p).rejects.toMatchObject({ name: "AbortError" });
        const er = (await tc.records()).find((r) => r.event === "http.error")!;
        expect(er.aborted).toBe(true);
        expect(er.error_class).toBe("AbortError");
        expect(typeof er.duration_ms).toBe("number");
    });

    it("c536ce29 TRC-AC9: every record carries the ambient withLogContext ids, including async stream completion", async () => {
        const f = tracedFetch(tc.channel, fetch);
        await withLogContext({ task_id: "t-1", session_id: "s-1", turn: 2 }, async () => {
            await (await f(`${base}/ctx`, { method: "POST", body: "{}" })).text();
        });
        await responseRecord(tc);
        const recs = (await tc.records()).filter((r) => r.event.startsWith("http."));
        expect(recs.length).toBe(2);
        for (const r of recs) {
            expect(r.task_id).toBe("t-1");
            expect(r.session_id).toBe("s-1");
            expect(r.turn).toBe(2);
        }
    });

    it("c536ce29 TRC-AC9: an inert channel logs nothing and the response is still delivered", async () => {
        const f = tracedFetch(noopLogChannel(), fetch);
        const res = await f(`${base}/n`);
        expect(await res.text()).toBe("ok");
        expect((await tc.records()).length).toBe(0);
    });

    it("c536ce29 TRC-AC9: a channel whose every write throws never affects the caller", async () => {
        const boom: LogChannel = { ...tc.channel, logRaw: () => { throw new Error("sink exploded"); } };
        const f = tracedFetch(boom, fetch);
        const res = await f(`${base}/b`, { method: "POST", body: "payload" });
        expect(await res.text()).toBe("ok");
        expect(seen[0]!.body.toString()).toBe("payload");
    });
});
