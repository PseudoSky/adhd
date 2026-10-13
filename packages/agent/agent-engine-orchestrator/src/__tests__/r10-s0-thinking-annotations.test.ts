/**
 * R10 S0 (types only, additive, zero behaviour change).
 * AC2: the anthropic provider config accepts `thinking: {type:'adaptive'}` / `{type:'disabled'}`, rejects unknown
 *      shapes and wrong types naming the `thinking` key, and parses unchanged when `thinking` is absent; the field
 *      survives the agent-definition -> binding -> provider-config chain.
 * AC6 (product amendment P10 AC6): `ToolDefinition.annotations` is engine-internal and never reaches the provider
 *      wire: the serialized `tools` array is byte-equal with and without annotations, through canonicalize + compact,
 *      for the real Anthropic and OpenAI providers.
 *
 * Real providers + real SDKs through the engine's `wire.fetch` seam: no socket.
 */
import { describe, expect, it } from "vitest";

import { canonicalizeToolDefinitions, compactToolDefinitions } from "../engine/tool-schema-compact.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { providerConfigToBinding, selectionToProviderConfig } from "../providers/resolve-selection.js";
import type { ToolDefinition } from "../providers/types.js";
import { agentCreateInputSchema, providerConfigSchema, providerConfigStoredSchema } from "../validation/agent.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODEL = "claude-haiku-5-5";

/** The slice of a zod schema these tests use. */
interface ISafeParse {
  safeParse(v: unknown): { success: boolean; error?: { issues: Array<{ path: PropertyKey[] }> } };
}

describe("R10 S0 AC2: provider.thinking validation", () => {
  it("R10 S0 AC2: adaptive, adaptive with display, and disabled parse", () => {
    for (const thinking of [
      { type: "adaptive" },
      { type: "adaptive", display: "summarized" },
      { type: "adaptive", display: "omitted" },
      { type: "disabled" },
    ]) {
      const parsed = providerConfigSchema.safeParse({ type: "anthropic", model: MODEL, thinking });
      expect(parsed.success, JSON.stringify(thinking)).toBe(true);
      if (parsed.success) expect(parsed.data).toMatchObject({ type: "anthropic", thinking });
    }
  });

  it("R10 S0 AC2: absent thinking parses exactly as before (no thinking key introduced)", () => {
    const parsed = providerConfigSchema.safeParse({ type: "anthropic", model: MODEL, effort: "high" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(Object.keys(parsed.data as object)).not.toContain("thinking");
  });

  const rejected: Array<[string, unknown]> = [
    ["unknown type", { type: "sometimes" }],
    ["legacy enabled+budget_tokens", { type: "enabled", budget_tokens: 2048 }],
    ["display value outside the API reference", { type: "adaptive", display: "updates" }],
    ["extra key on disabled", { type: "disabled", display: "omitted" }],
    ["extra key on adaptive", { type: "adaptive", budget_tokens: 1 }],
    ["wrong type: string", "adaptive"],
    ["wrong type: boolean", true],
    ["wrong type: number type", { type: 1 }],
    ["wrong type: display not a string", { type: "adaptive", display: 3 }],
    ["missing type", {}],
  ];
  for (const [label, thinking] of rejected) {
    it(`R10 S0 AC2: rejects ${label} and names the thinking key`, () => {
      const inputs: Array<[string, ISafeParse, unknown]> = [
        ["providerConfigSchema", providerConfigSchema as unknown as ISafeParse, { type: "anthropic", model: MODEL, thinking }],
        ["providerConfigStoredSchema", providerConfigStoredSchema as unknown as ISafeParse, { type: "anthropic", model: MODEL, thinking }],
        [
          "agentCreateInputSchema",
          agentCreateInputSchema as unknown as ISafeParse,
          { name: "a", systemPrompt: "p", provider: { type: "anthropic", model: MODEL, thinking } },
        ],
      ];
      for (const [schemaName, schema, input] of inputs) {
        const r = schema.safeParse(input);
        expect(r.success, `${schemaName}: ${label}`).toBe(false);
        expect(
          r.error?.issues.some((i) => i.path.includes("thinking")),
          `${schemaName}: ${JSON.stringify(r.error?.issues)}`
        ).toBe(true);
      }
    });
  }

  it("R10 S0 AC2: thinking is rejected on providers that have no such knob (strict input)", () => {
    expect(providerConfigSchema.safeParse({ type: "openai", model: "gpt-x", thinking: { type: "disabled" } }).success).toBe(false);
    expect(providerConfigSchema.safeParse({ type: "claudecli", thinking: { type: "disabled" } }).success).toBe(false);
  });

  it("R10 S0 AC2: thinking survives agent-definition -> binding -> provider-config; absent stays absent", () => {
    const binding = providerConfigToBinding({ type: "anthropic", model: MODEL, thinking: { type: "adaptive", display: "omitted" } } as never);
    expect(binding).toMatchObject({ providerType: "anthropic", thinking: { type: "adaptive", display: "omitted" } });
    const cfg = selectionToProviderConfig({ ...binding, providerType: "anthropic", modelRef: MODEL } as never, MODEL);
    expect(cfg).toMatchObject({ type: "anthropic", model: MODEL, thinking: { type: "adaptive", display: "omitted" } });

    const bare = providerConfigToBinding({ type: "anthropic", model: MODEL } as never);
    expect(Object.keys(bare ?? {})).not.toContain("thinking");
    const bareCfg = selectionToProviderConfig({ ...bare, providerType: "anthropic", modelRef: MODEL } as never, MODEL);
    expect(Object.keys(bareCfg)).not.toContain("thinking");
  });
});

describe("R10 S0 AC6: ToolDefinition.annotations never reaches the provider wire", () => {
  const tool = (annotations?: ToolDefinition["annotations"]): ToolDefinition => ({
    name: "fs__read_file",
    description: "Read a file\n\nReturns: text",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    ...(annotations && { annotations }),
  });
  const annotated = tool({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  const through = (t: ToolDefinition): ToolDefinition[] => compactToolDefinitions(canonicalizeToolDefinitions([t]));

  it("R10 S0 AC6: annotations are real engine-side data (the guard below has something to guard)", () => {
    expect(through(annotated)[0]!.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  });

  it("R10 S0 AC6: anthropic request `tools` is byte-equal with and without annotations", async () => {
    const send = async (t: ToolDefinition): Promise<string> => {
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
        tools: through(t),
      });
      return JSON.stringify(bodies[0]!.tools);
    };
    const withAnn = await send(annotated);
    expect(withAnn).toBe(await send(tool()));
    expect(withAnn).not.toContain("annotations");
    expect(withAnn).not.toContain("readOnlyHint");
  });

  it("R10 S0 AC6: openai request `tools` is byte-equal with and without annotations", async () => {
    const send = async (t: ToolDefinition): Promise<string> => {
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
          tools: through(t),
        });
      } catch {
        /* only the captured request body is under test */
      }
      expect(bodies.length).toBeGreaterThan(0);
      return JSON.stringify(bodies[0]!.tools);
    };
    const withAnn = await send(annotated);
    expect(withAnn).toBe(await send(tool()));
    expect(withAnn).not.toContain("annotations");
    expect(withAnn).not.toContain("readOnlyHint");
  });
});
