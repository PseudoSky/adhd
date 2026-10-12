/**
 * R7-think AC3b -- the anthropic provider's default max_tokens for the Sonnet 5 family comes from the model table
 * (catalog max_output_tokens.upper 128000), not the engine's small fallback. Also pins that the request body carries
 * no `thinking` field (the provider never forces thinking on or off; the API default for the model governs).
 * Real AnthropicProvider; only the SDK network boundary is mocked.
 */
import { describe, expect, it, vi } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";

const sdk = vi.hoisted(() => ({ bodies: [] as Record<string, unknown>[] }));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = {
      stream: (body: Record<string, unknown>) => {
        sdk.bodies.push(body);
        return {
          finalMessage: async () => ({
            model: "m",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        };
      },
    };
  }
  return { default: FakeAnthropic };
});

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const FALLBACK = 8192;
const engineConfig = {
  server: { contextLimit: 0, defaultMaxTokens: FALLBACK },
  queue: { concurrency: 1 },
  sse: { baseUrl: "http://localhost:0" },
  plugins: { entries: [] },
  getProviderConfig: () => ({ secret: "sk-test", model: "m" }),
  subprocessEnv: () => ({}),
  resolveEnvName: () => undefined,
  isEnvNameAllowed: () => true,
} as unknown as EngineConfig;
const request: ProviderChatRequest = { messages: [{ role: "user", content: "hi" } as ProviderChatRequest["messages"][number]] };

async function requestFor(model: string): Promise<Record<string, unknown>> {
  const { AnthropicProvider } = await import("../providers/anthropic.js");
  sdk.bodies.length = 0;
  await new AnthropicProvider({ type: "anthropic", model }, engineConfig, logger).chat(request);
  return sdk.bodies[0] as Record<string, unknown>;
}

describe("R7-think AC3b: Sonnet 5 family max_tokens", () => {
  it.each(["claude-sonnet-5-5", "claude-sonnet-5-5-20260101", "claude-sonnet-5"])("%s uses 128000, not the engine fallback", async (model) => {
    expect((await requestFor(model))["max_tokens"]).toBe(128_000);
  });

  it("negative controls: neighbours keep their own values and an unknown model still takes the engine fallback", async () => {
    expect((await requestFor("claude-sonnet-4-6"))["max_tokens"]).toBe(64_000);
    expect((await requestFor("totally-unknown-model"))["max_tokens"]).toBe(FALLBACK);
  });

  it("the request body never carries a thinking field (provider leaves thinking at the model's API default)", async () => {
    expect(Object.keys(await requestFor("claude-sonnet-5-5"))).not.toContain("thinking");
  });
});
