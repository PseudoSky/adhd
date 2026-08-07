import { describe, expect, it } from "vitest";
import { normaliseOpenAIUsage } from "../providers/openai.js";
import { normaliseAnthropicUsage } from "../providers/anthropic.js";

/**
 * Providers disagree on whether their headline input count INCLUDES cached tokens.
 * Anthropic EXCLUDES them; OpenAI/DeepSeek/Gemini INCLUDE them. Storing each provider's
 * raw headline in one column silently under-counts Anthropic spend and makes budget caps
 * bite openai-provider agents sooner for identical real usage (BUG-ORCH-010).
 *
 * `inputTokens` must therefore mean the SAME THING on every provider: the total input the
 * model actually processed.
 */
describe("usage normalisation — provider-neutral inputTokens", () => {
    describe("OpenAI-compatible (inclusive headline)", () => {
        it("reads DeepSeek's prompt_cache_hit/miss fields (verbatim wire payload)", () => {
            // Captured from a real DeepSeek response via the wiretap proxy (call 41).
            const wire = {
                prompt_tokens: 40_360,
                completion_tokens: 250,
                prompt_tokens_details: { cached_tokens: 40_192 },
                prompt_cache_hit_tokens: 40_192,
                prompt_cache_miss_tokens: 168,
                completion_tokens_details: { reasoning_tokens: 96 },
            };

            const usage = normaliseOpenAIUsage(wire, "stop", 8192);

            // The headline is already the true total on this family.
            expect(usage.inputTokens).toBe(40_360);
            expect(usage.cacheReadTokens).toBe(40_192);
            expect(usage.uncachedInputTokens).toBe(168);
            expect(usage.reasoningTokens).toBe(96);
            // DeepSeek documents the equation; hold it.
            expect(usage.cacheReadTokens! + usage.uncachedInputTokens!).toBe(usage.inputTokens);
        });

        it("derives the uncached remainder when only OpenAI's cached_tokens is present", () => {
            // OpenAI reports cached_tokens but no explicit miss count.
            const usage = normaliseOpenAIUsage(
                { prompt_tokens: 10_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 8_000 } },
                "stop"
            );

            expect(usage.inputTokens).toBe(10_000);
            expect(usage.cacheReadTokens).toBe(8_000);
            expect(usage.uncachedInputTokens).toBe(2_000);
        });

        it("treats a cold call (no cache fields) as fully uncached — never negative", () => {
            const usage = normaliseOpenAIUsage({ prompt_tokens: 500, completion_tokens: 20 }, "stop");

            expect(usage.inputTokens).toBe(500);
            expect(usage.cacheReadTokens).toBe(0);
            expect(usage.uncachedInputTokens).toBe(500);
        });
    });

    describe("Anthropic (EXCLUSIVE headline — the outlier)", () => {
        it("SUMS input + cache_read + cache_creation into inputTokens", () => {
            // A cache-warm Anthropic call: input_tokens is only the uncached tail.
            // Passing it through raw would report 300 tokens for a call that actually
            // processed 50,300 — under-counting spend by 166x.
            const usage = normaliseAnthropicUsage(
                {
                    input_tokens: 300,
                    output_tokens: 150,
                    cache_read_input_tokens: 48_000,
                    cache_creation_input_tokens: 2_000,
                },
                "stop",
                8192
            );

            expect(usage.inputTokens).toBe(50_300); // 300 + 48_000 + 2_000
            expect(usage.uncachedInputTokens).toBe(300);
            expect(usage.cacheReadTokens).toBe(48_000);
            expect(usage.cacheCreationTokens).toBe(2_000);
        });

        it("handles a no-cache call (fields absent) without inflating the total", () => {
            const usage = normaliseAnthropicUsage(
                { input_tokens: 1_200, output_tokens: 80 },
                "stop",
                8192
            );

            expect(usage.inputTokens).toBe(1_200);
            expect(usage.uncachedInputTokens).toBe(1_200);
            expect(usage.cacheReadTokens).toBe(0);
            expect(usage.cacheCreationTokens).toBe(0);
        });
    });

    it("makes inputTokens comparable ACROSS providers for identical real usage", () => {
        // Same real work: 50,000 input processed, 48,000 of it cached.
        const anthropic = normaliseAnthropicUsage(
            { input_tokens: 2_000, output_tokens: 100, cache_read_input_tokens: 48_000 },
            "stop",
            8192
        );
        const deepseek = normaliseOpenAIUsage(
            {
                prompt_tokens: 50_000,
                completion_tokens: 100,
                prompt_cache_hit_tokens: 48_000,
                prompt_cache_miss_tokens: 2_000,
            },
            "stop"
        );

        // Before normalisation these reported 2,000 vs 50,000 for the same work.
        expect(anthropic.inputTokens).toBe(50_000);
        expect(deepseek.inputTokens).toBe(50_000);
        expect(anthropic.inputTokens).toBe(deepseek.inputTokens);
        expect(anthropic.uncachedInputTokens).toBe(deepseek.uncachedInputTokens);
    });
});
