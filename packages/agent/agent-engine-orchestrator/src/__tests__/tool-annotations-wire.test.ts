/**
 * R10 S2 AC5 (product amendment P10 AC6): `ToolDefinition.annotations` is engine-internal. Tools
 * flow from a REAL `McpClientRegistry.listAllTools` (annotations present) through the engine's
 * canonicalize + compact step into every wire / hash projection the engine has, and each projection
 * is byte-equal to the one produced from the same tools WITHOUT annotations.
 *
 * Projections covered: the Anthropic and OpenAI request `tools` arrays (real providers + real SDKs
 * through the `wire.fetch` seam, no socket), the names-mode prompt document and name-only tool
 * list, and the claudecli resume-config hash.
 *
 * Negative control (recorded in the R10 S2 return): making the registry fold the annotations into
 * the advertised description turns the byte-equality assertions red.
 *
 * guards: ToolDefinition.annotations leaks into a provider request tools array, the names-mode prompt document, the name-only tool list or the claudecli resume-config hash, changing bytes or cache keys.
 * tier: S
 * cites: R10 S2 AC5 (product amendment P10 AC6).
 */
import { describe, expect, it } from "vitest";

import { McpClientRegistry } from "../clients/registry.js";
import { renderToolPromptDoc, toNameOnlyTools } from "../engine/tool-advertisement.js";
import { canonicalizeToolDefinitions, compactToolDefinitions } from "../engine/tool-schema-compact.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { claudeCliResumeConfigKey } from "../providers/claudecli-session.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { ToolDefinition } from "../providers/types.js";
import type { ExecutionContext } from "../validation/index.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODEL = "claude-haiku-5-5";
const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] };

const HINTS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

/** Tools as the engine gets them: through a real registry (in-process server), canonicalized and compacted. */
async function engineTools(annotated: boolean): Promise<ToolDefinition[]> {
    const registry = new McpClientRegistry(
        { "agent-mcp": { transport: "stdio", command: "noop" } } as never,
        undefined,
        [
            { name: "guide", description: "Read the guide\n\nReturns: text", inputSchema: schema, ...(annotated ? { annotations: HINTS } : {}) },
            { name: "task", description: "Run a task", inputSchema: schema, ...(annotated ? { annotations: { readOnlyHint: false } } : {}) },
        ],
        async () => "ok",
        {} as ExecutionContext
    );
    return compactToolDefinitions(canonicalizeToolDefinitions(await registry.listAllTools()));
}

describe("R10 S2 AC5: annotations never reach a wire or a hash", () => {
    it("R10 S2 AC5: the annotated tools really carry annotations inside the engine (the guard has something to guard)", async () => {
        const tools = await engineTools(true);
        expect(tools.find((t) => t.name === "agent-mcp__guide")?.annotations).toEqual(HINTS);
        expect((await engineTools(false)).every((t) => !("annotations" in t))).toBe(true);
    });

    it("R10 S2 AC5: anthropic request `tools` is byte-equal with and without annotations", async () => {
        const send = async (tools: ToolDefinition[]): Promise<string> => {
            const bodies: Array<{ tools?: unknown[] }> = [];
            const fetchSeam: typeof fetch = async (_u, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return new Response(anthropicSseBody({ model: MODEL, text: "ok", usage: { input_tokens: 10, output_tokens: 5 } }), {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                });
            };
            const engineConfig = {
                server: { contextLimit: 0, defaultMaxTokens: 8192 },
                wire: { fetch: fetchSeam },
                getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
            } as unknown as EngineConfig;
            await new AnthropicProvider({ type: "anthropic", model: MODEL }, engineConfig, logger).chat({
                messages: [{ role: "user", content: "hi" }] as never,
                tools,
            });
            return JSON.stringify(bodies[0]!.tools);
        };
        const withAnnotations = await send(await engineTools(true));
        expect(withAnnotations).toBe(await send(await engineTools(false)));
        expect(withAnnotations).not.toMatch(/annotations|readOnlyHint|destructiveHint|idempotentHint/);
    });

    it("R10 S2 AC5: openai request `tools` is byte-equal with and without annotations", async () => {
        const send = async (tools: ToolDefinition[]): Promise<string> => {
            const bodies: Array<{ tools?: unknown[] }> = [];
            const fetchSeam: typeof fetch = async (_u, init) => {
                bodies.push(JSON.parse(String(init?.body)));
                return new Response(
                    JSON.stringify({
                        id: "x",
                        object: "chat.completion",
                        created: 0,
                        model: "m",
                        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
                        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } }
                );
            };
            const engineConfig = {
                server: { contextLimit: 0, defaultMaxTokens: 8192 },
                wire: { fetch: fetchSeam },
                getProviderConfig: () => ({ secret: "sk-test", model: "m", baseURL: "http://localhost:1/v1" }),
            } as unknown as EngineConfig;
            try {
                await new OpenAIProvider({ type: "openai", model: "m" } as never, engineConfig).chat({
                    messages: [{ role: "user", content: "hi" }] as never,
                    tools,
                });
            } catch {
                /* only the captured request body is under test */
            }
            expect(bodies.length).toBeGreaterThan(0);
            return JSON.stringify(bodies[0]!.tools);
        };
        const withAnnotations = await send(await engineTools(true));
        expect(withAnnotations).toBe(await send(await engineTools(false)));
        expect(withAnnotations).not.toMatch(/annotations|readOnlyHint|destructiveHint|idempotentHint/);
    });

    it("R10 S2 AC5: the names-mode prompt document and the name-only tool list are byte-equal", async () => {
        const a = await engineTools(true);
        const b = await engineTools(false);
        expect(renderToolPromptDoc(a)).toBe(renderToolPromptDoc(b));
        expect(JSON.stringify(toNameOnlyTools(a))).toBe(JSON.stringify(toNameOnlyTools(b)));
        expect(JSON.stringify(toNameOnlyTools(a))).not.toContain("readOnlyHint");
    });

    it("R10 S2 AC5: the claudecli resume-config hash is unchanged by annotations", async () => {
        const key = (tools: ToolDefinition[]) =>
            claudeCliResumeConfigKey({
                systemPrompt: "sys",
                model: "m",
                cwd: "/w",
                builtinTools: null,
                builtinToolsArgv: [],
                bridgedTools: tools, // the real call site hands the engine's ToolDefinition[] through
                settingSources: undefined,
                permissionMode: "default",
            });
        expect(key(await engineTools(true))).toBe(key(await engineTools(false)));
    });
});
