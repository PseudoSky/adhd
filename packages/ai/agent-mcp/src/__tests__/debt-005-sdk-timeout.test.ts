/**
 * DEBT-005: provider `timeoutMs` must be forwarded to the OpenAI/Anthropic SDK
 * client constructor.
 *
 * Without the passthrough, a slow local model (e.g. 27B dense) exceeds the SDK's
 * ~10-minute default and throws `APIConnectionTimeoutError` ("Request timed out.")
 * — a generic PROVIDER_ERROR that is mislabeled and un-tunable via `timeoutMs`.
 * After the fix, the SDK timeout is aligned with `timeoutMs` so our AbortSignal
 * always fires first, producing the actionable PROVIDER_TIMEOUT.
 *
 * Teeth check: removing the `timeout: config.timeoutMs` line from OpenAIProvider
 * causes the spy assertion to fail (the constructor would be called without the
 * timeout property) — the test goes red exactly where it should.
 *
 * Note: tests use `baseURL: "http://localhost:1234/v1"` so `config.getProviderConfig`
 * applies the localhost exemption (no ADHD_AGENT_OPENAI_SECRET required).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the openai module BEFORE importing OpenAIProvider so the provider's
// `new OpenAI(...)` call hits the spy, not the real SDK.
// ---------------------------------------------------------------------------
const openAISpy = vi.fn();
vi.mock("openai", () => ({
    default: class MockOpenAI {
        // Record constructor args so we can assert on them
        constructor(...args: unknown[]) {
            openAISpy(...args);
        }
        chat = {
            completions: {
                create: vi.fn().mockResolvedValue({
                    choices: [{ message: { content: "ok", tool_calls: undefined }, finish_reason: "stop" }],
                    usage: { prompt_tokens: 1, completion_tokens: 1 },
                }),
            },
        };
    },
}));

import { OpenAIProvider } from "../providers/openai.js";
import type { ProviderConfig } from "../validation/index.js";

function makeOpenAIConfig(overrides: Partial<Extract<ProviderConfig, { type: "openai" }>> = {}): Extract<ProviderConfig, { type: "openai" }> {
    return {
        type: "openai",
        model: "gpt-4o-mini",
        // Use a localhost baseURL so config.getProviderConfig applies the
        // localhost exemption — no ADHD_AGENT_OPENAI_SECRET required.
        baseURL: "http://localhost:1234/v1",
        ...overrides,
    };
}

describe("DEBT-005 — timeoutMs forwarded to OpenAI SDK constructor", () => {
    beforeEach(() => {
        openAISpy.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("passes the configured timeoutMs to the OpenAI constructor", () => {
        const timeoutMs = 120_000;
        new OpenAIProvider(makeOpenAIConfig({ timeoutMs }));

        expect(openAISpy).toHaveBeenCalledOnce();
        const constructorArg = openAISpy.mock.calls[0]![0] as Record<string, unknown>;
        expect(constructorArg["timeout"]).toBe(timeoutMs);
    });

    it("falls back to 60_000ms when timeoutMs is not set", () => {
        new OpenAIProvider(makeOpenAIConfig());

        expect(openAISpy).toHaveBeenCalledOnce();
        const constructorArg = openAISpy.mock.calls[0]![0] as Record<string, unknown>;
        expect(constructorArg["timeout"]).toBe(60_000);
    });

    it("a large timeoutMs (>SDK default of ~600k ms) is passed verbatim", () => {
        const timeoutMs = 1_200_000; // 20 min — what the 27B study runs needed
        new OpenAIProvider(makeOpenAIConfig({ timeoutMs }));

        const constructorArg = openAISpy.mock.calls[0]![0] as Record<string, unknown>;
        expect(constructorArg["timeout"]).toBe(1_200_000);
    });

    it("timeout passthrough applies for any localhost server (lm-studio, ollama, etc.)", () => {
        // lmstudio is now just an OpenAI-compatible server with a localhost base URL.
        // Verify that different localhost origins still get the timeout forwarded.
        const timeoutMs = 300_000;
        new OpenAIProvider(makeOpenAIConfig({
            baseURL: "http://127.0.0.1:11434/v1", // ollama-style
            timeoutMs,
        }));

        const constructorArg = openAISpy.mock.calls[0]![0] as Record<string, unknown>;
        expect(constructorArg["timeout"]).toBe(300_000);
    });
});
