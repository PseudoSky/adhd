/**
 * Anthropic provider honors the resolved endpoint. `EngineConfig.getProviderConfig` resolves
 * `ADHD_AGENT_ANTHROPIC_BASE_URL` into `baseURL`; before this fix `AnthropicProvider` computed it and
 * never passed it to the SDK, so every request went to the SDK default (`https://api.anthropic.com`)
 * regardless of configuration.
 *
 * Real AnthropicProvider + real @anthropic-ai/sdk through the engine's `wire.fetch` seam: the captured
 * request URL is the consumer-visible outcome. No socket, no api.anthropic.com.
 *
 * guards: the Anthropic provider sends its requests to the resolved base URL, and to the SDK default when none is resolved.
 * tier: S
 * cites: anthropic-base-url AC1 (configured endpoint receives the request), AC2 (unset endpoint keeps the SDK default).
 * red run: with `baseURLOption` forced to `{}` (the pre-fix behaviour) AC1 fails with the request sent to https://api.anthropic.com/v1/messages.
 */
import { describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODEL = "claude-haiku-5-5";

function providerWith(baseURL: string | undefined, seenUrls: string[]): AnthropicProvider {
  const fetchSeam: typeof fetch = async (url) => {
    seenUrls.push(String(url));
    return new Response(anthropicSseBody({ model: MODEL, text: "ok", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 256 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL, baseURL }),
  } as unknown as EngineConfig;
  return new AnthropicProvider({ type: "anthropic", model: MODEL } as never, engineConfig, logger);
}

describe("Anthropic provider endpoint (anthropic-base-url)", () => {
  it("AC1: sends the request to the configured base URL", async () => {
    const seen: string[] = [];
    const provider = providerWith("http://127.0.0.1:65530", seen);
    await (provider as unknown as { client: { messages: { create: (b: unknown) => Promise<unknown> } } }).client.messages.create({
      model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe("http://127.0.0.1:65530/v1/messages");
  });

  it("AC2: with no resolved base URL the SDK default endpoint is used", () => {
    const provider = providerWith(undefined, []);
    const client = (provider as unknown as { client: { baseURL: string } }).client;
    expect(client.baseURL).toBe("https://api.anthropic.com");
  });
});
