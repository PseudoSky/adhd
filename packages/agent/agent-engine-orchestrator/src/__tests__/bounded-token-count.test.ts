/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1 (bucket B2, G5): `boundedTokenCount` is exact up to
 * 20k chars and sampled above; the tokenizer is never handed an unbounded span. Deterministic:
 * bounds are asserted on the tokenizer's argument length, never on wall-clock.
 */
import { encode as realEncode } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";

import {
    BOUNDED_COUNT_EXACT_MAX_CHARS,
    BOUNDED_COUNT_SAMPLE_CHARS,
    boundedTokenCount,
} from "../engine/bounded-token-count.js";
import { estimateToolResultTokens } from "../engine/tool-result-tokens.js";

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC1: boundedTokenCount", () => {
    it("ea8f6f92 AC1: exact (== encode().length, not estimated) up to the 20k-char threshold", () => {
        const prose = "The quick brown fox jumps over the lazy dog. ".repeat(500).slice(0, BOUNDED_COUNT_EXACT_MAX_CHARS);
        expect(prose.length).toBe(BOUNDED_COUNT_EXACT_MAX_CHARS);
        const out = boundedTokenCount(prose);
        expect(out.estimated).toBe(false);
        expect(out.tokens).toBe(realEncode(prose).length);
    });

    it("ea8f6f92 AC1: above the threshold it samples (estimated) and never hands the tokenizer more than the sample bound", () => {
        const seen: number[] = [];
        const spy = (s: string) => {
            seen.push(s.length);
            return realEncode(s);
        };
        const out = boundedTokenCount("m".repeat(75_000), spy);
        expect(out.estimated).toBe(true);
        expect(out.tokens).toBeGreaterThan(0);
        expect(Math.max(...seen)).toBeLessThanOrEqual(BOUNDED_COUNT_SAMPLE_CHARS);
        expect(seen.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(2 * BOUNDED_COUNT_SAMPLE_CHARS);
    });

    it("ea8f6f92 AC1: the sampled estimate tracks the exact count for ordinary prose (within 10%)", () => {
        const prose = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2_000);
        const exact = realEncode(prose).length;
        const est = boundedTokenCount(prose).tokens;
        expect(Math.abs(est - exact) / exact).toBeLessThan(0.1);
    });

    it("ea8f6f92 AC1: tool-result-tokens delegates with identical output", () => {
        for (const text of ["", "hello world", "x".repeat(30_000), "ab ".repeat(50_000)]) {
            expect(estimateToolResultTokens(text)).toEqual(boundedTokenCount(text));
        }
    });
});
