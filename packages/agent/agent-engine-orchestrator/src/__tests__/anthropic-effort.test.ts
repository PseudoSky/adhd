/**
 * R8-AC (ticket R8-AC, EXPERIMENT-LOG SCOPE-R8-A-C-complete): the Anthropic provider can carry an explicit reasoning-effort level as the
 * Messages API request field `output_config.effort`, so the parity instrument can set effort on arm C exactly as it does on arms A and B.
 * Acceptance ids: R8-AC-effort AC1 (the real provider puts the field on the wire, and ONLY when configured), AC2 (agent_create input
 * validation accepts a valid level, rejects an unknown one and the field on a provider that has no such knob), AC3 (the field survives the
 * agent-definition -> binding -> provider-config chain a stored agent takes at run time).
 *
 * Real AnthropicProvider + real @anthropic-ai/sdk through the engine's `wire.fetch` seam: no socket, no api.anthropic.com.
 */
import { describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { providerConfigToBinding, selectionToProviderConfig } from "../providers/resolve-selection.js";
import { agentCreateInputSchema } from "../validation/agent.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODEL = "claude-haiku-5-5";

interface IWireBody {
  model?: string;
  output_config?: { effort?: string };
  [k: string]: unknown;
}

function makeProvider(capture: IWireBody[], providerConfig: Record<string, unknown>) {
  const fetchSeam: typeof fetch = async (_url, init) => {
    capture.push(JSON.parse(String(init?.body)) as IWireBody);
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
  return new AnthropicProvider({ type: "anthropic", model: MODEL, ...providerConfig } as never, engineConfig, logger);
}

const ask = { messages: [{ role: "user", content: "hi" }] as never };

describe("R8-AC-effort AC1: the provider sends output_config.effort when configured, and nothing otherwise", () => {
  it("R8-AC-effort AC1: effort high is on the request body as output_config {effort:'high'}", async () => {
    const bodies: IWireBody[] = [];
    await makeProvider(bodies, { effort: "high" }).chat(ask);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].output_config).toEqual({ effort: "high" });
    expect(bodies[0].model).toBe(MODEL);
  });

  it("R8-AC-effort AC1 negative control: with no effort configured the body has no output_config key at all (the pre-change request, so every other consumer is untouched)", async () => {
    const bodies: IWireBody[] = [];
    await makeProvider(bodies, {}).chat(ask);
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0])).not.toContain("output_config");
  });

  it("R8-AC-effort AC1: each documented level reaches the wire verbatim", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const bodies: IWireBody[] = [];
      await makeProvider(bodies, { effort }).chat(ask);
      expect(bodies[0].output_config, effort).toEqual({ effort });
    }
  });
});

describe("R8-AC-effort AC2: agent_create provider validation", () => {
  const input = (provider: Record<string, unknown>) => ({ name: "effort-agent", provider });

  it("R8-AC-effort AC2: an anthropic provider accepts each effort level", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      expect(agentCreateInputSchema.safeParse(input({ type: "anthropic", model: MODEL, effort })).success, effort).toBe(true);
    }
  });

  it("R8-AC-effort AC2 negative controls: an unknown level, and effort on a provider that has no such knob, are rejected (strict input)", () => {
    expect(agentCreateInputSchema.safeParse(input({ type: "anthropic", effort: "ultra" })).success).toBe(false);
    expect(agentCreateInputSchema.safeParse(input({ type: "openai", effort: "high" })).success).toBe(false);
    expect(agentCreateInputSchema.safeParse(input({ type: "claudecli", effort: "high" })).success).toBe(false);
  });
});

describe("R8-AC-effort AC3: effort survives the agent-definition -> binding -> provider-config chain", () => {
  it("R8-AC-effort AC3: providerConfigToBinding carries it and selectionToProviderConfig puts it back on the anthropic config", () => {
    const binding = providerConfigToBinding({ type: "anthropic", model: MODEL, effort: "high" } as never);
    expect(binding).toMatchObject({ providerType: "anthropic", effort: "high" });
    const cfg = selectionToProviderConfig({ ...binding, providerType: "anthropic", modelRef: MODEL } as never, MODEL);
    expect(cfg).toMatchObject({ type: "anthropic", model: MODEL, effort: "high" });
  });

  it("R8-AC-effort AC3 negative control: no effort in -> no effort key out", () => {
    const binding = providerConfigToBinding({ type: "anthropic", model: MODEL } as never);
    expect(Object.keys(binding ?? {})).not.toContain("effort");
    const cfg = selectionToProviderConfig({ ...binding, providerType: "anthropic", modelRef: MODEL } as never, MODEL);
    expect(Object.keys(cfg)).not.toContain("effort");
  });
});
