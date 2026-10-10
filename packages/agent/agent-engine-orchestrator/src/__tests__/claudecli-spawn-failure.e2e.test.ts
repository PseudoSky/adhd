/**
 * b8372f5a D1 (real-subprocess proof, e2e lane per ADR-0009): a genuinely absent `claude` binary
 * driven through the REAL `child_process.spawn` path yields PROVIDER_ERROR naming ENOENT, not the
 * PROVIDER_AUTH_ERROR empty-result message. Nothing is mocked; no network or model is involved.
 */
import { describe, expect, it } from "vitest";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { ClaudeCliProvider } from "../providers/claudecli.js";
import { ToolError } from "../validation/errors.js";

const engineConfig = {
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "" },
  plugins: { entries: [] },
  getProviderConfig: () => ({}),
  subprocessEnv: () => ({}),
  resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
} as unknown as EngineConfig;
const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const request: ProviderChatRequest = {
  messages: [{ role: "user", content: "Say OK" } as ProviderChatRequest["messages"][number]],
};

describe("claudecli missing binary through the real spawn path (b8372f5a)", () => {
  it("b8372f5a D1-AC1: an absent binary rejects with PROVIDER_ERROR naming ENOENT", async () => {
    const bin = "/nonexistent-dir-b8372f5a/claude-absent";
    const provider = new ClaudeCliProvider(
      { type: "claudecli", model: "claude-haiku-4-5", claudePath: bin },
      {},
      undefined,
      engineConfig,
      logger
    );
    const err = await provider.chat(request).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ToolError);
    const te = err as ToolError;
    expect(te.code).toBe("PROVIDER_ERROR");
    expect(te.message).toContain("ENOENT");
    expect(te.message).toContain(bin);
    expect(te.message).not.toContain("auth status");
  }, 30_000);
});
