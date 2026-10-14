/**
 * 49cec55e - correction-by-adapter: the engine-native `web_fetch` is on the wire log for every adapter
 * that uses it, through the PRODUCTION wiring (`createWireSeams` over a real file-backed `agent-mcp.api`
 * channel, a real `McpClientRegistry`, a real `executeWebFetch` pinned transport).
 *
 * | adapter                      | how web_fetch is reached                                           | driven here by                                   |
 * | claudecli                    | registry advertises `web__web_fetch` (the loopback bridge serves    | registry assertToolAllowed + getClient + call,   |
 * |                              | it as `mcp__web__web_fetch`); the bridge calls the registry client  | exactly what the bridge's executeTool does. The  |
 * |                              |                                                                    | subprocess bridge itself is driven in the        |
 * |                              |                                                                    | orchestrator's web-fetch-bridge.e2e (seam spy).  |
 * | openai-compatible            | real OpenAIProvider.chat sends the tool; the model's call          | OpenAIProvider.chat over a faked wire.fetch, then|
 * |                              | `web__web_fetch` is mapped back to {web, web_fetch}                 | the registry call                                |
 * | anthropic                    | NOT applicable: the provider gets the server tool                  | registry.listAllTools (absent) + no records      |
 * |                              | `web_fetch_20250910`, executed by Anthropic                        |                                                  |
 *
 * The destination is an IP literal because the dist-resolved engine's DNS cannot be stubbed from here
 * (the name-vs-IP distinction is covered in traced-request.test.ts through executeWebFetch's resolver
 * seam). Only the socket leaf (`fakeNet`) and the LLM `fetch` are fakes; nothing touches the network.
 *
 * Negative control (49cec55e AC3): make `tracedRequest` return `base(options)` unconditionally and the
 * claudecli and openai tests below go red (no http.* web_fetch records).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpClientRegistry, OpenAIProvider, type EngineConfig } from "@adhd/agent-engine-orchestrator";

import { toEngineConfig } from "../config.js";
import { createWireSeams } from "../wire/seams.js";
import { fakeNet, type IFakeNet } from "./web-fetch-wire-net.js";
import { installChannels, type IChannelFixture, type Rec } from "./provider-wire-utils.js";

const IP = "203.0.113.9";
const URL_FETCHED = `https://${IP}/docs/guide?token=wf-canary-secret`;
const PAGE = "<title>Guide</title><p>guide body text</p>";

let channels: IChannelFixture;
let net: IFakeNet;
let llmBodies: string[];

beforeEach(() => {
    channels = installChannels();
    net = fakeNet(() => ({ status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(PAGE) }));
    llmBodies = [];
});
afterEach(async () => {
    await channels.dispose();
});

/** Production seams: traced fetch + traced request, over fakes for the two network leaves. */
function seams(llm?: typeof fetch) {
    return createWireSeams({ request: net.request, ...(llm ? { fetch: llm } : {}) });
}

function registryFor(providerType: string, wire: ReturnType<typeof seams>): McpClientRegistry {
    const ctx = {
        taskId: "t", sessionId: "s", agentName: "a", recursionDepth: 0, toolCallCount: 0,
        agentDefinition: { name: "a", provider: { type: providerType, model: "m" }, mcpServers: {} },
    };
    return new McpClientRegistry(
        {}, undefined, [], (async () => ({})) as never, ctx as never,
        { ...toEngineConfig(), wire } as unknown as EngineConfig
    );
}

/** What the claudecli bridge / orchestrator do for one call: gate, resolve the client, call, fold a throw into isError. */
async function callTool(reg: McpClientRegistry, server: string, tool: string, args: unknown): Promise<{ result: unknown; isError: boolean }> {
    reg.assertToolAllowed(server, tool);
    const client = await reg.getClient(server);
    try {
        return { result: await client.callTool(tool, args), isError: false };
    } catch (e) {
        return { result: e instanceof Error ? e.message : String(e), isError: true };
    }
}

/** The web_fetch records on the api channel: http.* records that carry `ip` (the LLM-API records carry `url`). */
async function webFetchRecords(): Promise<Rec[]> {
    return (await channels.records()).filter((r) => r.event.startsWith("http.") && typeof r.ip === "string");
}

function expectOneLoggedFetch(recs: Rec[]): void {
    expect(recs.map((r) => r.event)).toEqual(["http.request", "http.response"]);
    expect(recs[0]).toMatchObject({ method: "GET", scheme: "https", host: IP, ip: IP });
    expect(recs[1]).toMatchObject({ method: "GET", host: IP, ip: IP, status: 200, wire_bytes: Buffer.byteLength(PAGE), complete: true });
    expect(recs[1]!.call_id).toBe(recs[0]!.call_id);
}

describe("49cec55e AC4 claudecli", () => {
    it("49cec55e AC4: the tool is offered to the bridge and a call through the registry writes the wire-log records", async () => {
        const reg = registryFor("claudecli", seams());
        expect((await reg.listAllTools()).map((t) => t.name)).toContain("web__web_fetch");
        const out = await callTool(reg, "web", "web_fetch", { url: URL_FETCHED });
        expect(out.isError).toBe(false);
        expect(JSON.stringify(out.result)).toContain("guide body text");
        expect(net.calls.map((c) => c.host)).toEqual([IP]); // the pin still holds under tracing
        expectOneLoggedFetch(await webFetchRecords());
        const raw = await channels.rawText();
        expect(raw).not.toContain("wf-canary-secret"); // query value
        expect(raw).not.toContain("/docs/guide"); // path
        expect(raw).not.toContain("guide body text"); // body
    });

    it("49cec55e AC4: a refused internal destination is refused as before and writes no web_fetch record", async () => {
        const reg = registryFor("claudecli", seams());
        const out = await callTool(reg, "web", "web_fetch", { url: "http://169.254.169.254/latest/meta-data/" });
        expect(out.isError).toBe(true);
        expect(String(out.result)).toMatch(/link-local/);
        expect(net.calls).toHaveLength(0);
        expect(await webFetchRecords()).toEqual([]);
    });
});

describe("49cec55e AC4 OpenAI-compatible", () => {
    /** A real OpenAIProvider.chat over a faked LLM fetch whose completion is the model calling web__web_fetch. */
    async function modelCallsWebFetch(wire: ReturnType<typeof seams>, reg: McpClientRegistry) {
        const config = {
            server: { contextLimit: 0, defaultMaxTokens: 8192 },
            wire,
            getProviderConfig: () => ({ secret: "sk-test", model: "deepseek-flash", baseURL: "http://deepseek.invalid/v1" }),
        } as unknown as EngineConfig;
        return new OpenAIProvider({ type: "openai", model: "deepseek-flash" } as never, config).chat({
            messages: [{ id: "m1", role: "user", content: "fetch it" }] as never,
            tools: await reg.listAllTools(),
        });
    }
    const llmFetch = (async (_u: unknown, init?: RequestInit) => {
        llmBodies.push(String(init?.body));
        return new Response(
            JSON.stringify({
                id: "x", object: "chat.completion", created: 0, model: "deepseek-flash",
                choices: [{
                    index: 0, finish_reason: "tool_calls",
                    message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "web__web_fetch", arguments: JSON.stringify({ url: URL_FETCHED }) } }] },
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
            { status: 200, headers: { "content-type": "application/json" } }
        );
    }) as unknown as typeof fetch;

    it("49cec55e AC4: the model's web__web_fetch call goes openai.ts -> registry and its fetch is on the wire log next to the LLM call", async () => {
        const wire = seams(llmFetch);
        const reg = registryFor("openai", wire);
        const res = await modelCallsWebFetch(wire, reg);
        const call = res.message.toolCalls![0]!;
        expect([call.server, call.tool]).toEqual(["web", "web_fetch"]);
        const out = await callTool(reg, call.server, call.tool, call.arguments);
        expect(out.isError).toBe(false);
        expect(JSON.stringify(out.result)).toContain("guide body text");
        expectOneLoggedFetch(await webFetchRecords());
        // The LLM call is still traced by the fetch seam (its records carry a url, the web_fetch ones do not).
        const all = await channels.records();
        expect(all.filter((r) => r.event === "http.request" && typeof r.url === "string")).toHaveLength(1);
        expect(llmBodies).toHaveLength(1);
    });
});

describe("49cec55e AC4 anthropic", () => {
    it("49cec55e AC4: not applicable - anthropic keeps the server tool (executed by Anthropic), is never offered web__web_fetch, and writes no web_fetch record", async () => {
        const reg = registryFor("anthropic", seams());
        expect((await reg.listAllTools()).map((t) => t.name)).not.toContain("web__web_fetch");
        expect(net.calls).toHaveLength(0);
        expect(await webFetchRecords()).toEqual([]);
    });
});
