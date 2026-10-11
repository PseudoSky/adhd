/**
 * ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC2 / AC3 / AC4 (bucket B2, G5): the anthropic cache guard
 * must not stall the event loop on a pathological single-character prompt. gpt-tokenizer's
 * `encode` costs ~3.2 s on a 75 KB single-char run (tool-result-tokens.ts notes). The guard's
 * `countTokens` now delegates to the shared bounded counter.
 *
 * Proof is deterministic (no wall-clock): `gpt-tokenizer.encode` is wrapped to record every
 * argument length, and the guard is driven through the real `applyCacheBreakpoints`. With the old
 * unbounded `encode(text)` the 75 KB prompt reaches the tokenizer whole and these tests go red
 * (negative control, AC4).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MessageParam, TextBlockParam } from "@anthropic-ai/sdk/resources/messages";

const encodeArgLengths: number[] = [];
vi.mock("gpt-tokenizer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("gpt-tokenizer")>();
    return {
        ...actual,
        encode: (s: string, ...rest: unknown[]) => {
            encodeArgLengths.push(s.length);
            return (actual.encode as (s: string, ...r: unknown[]) => number[])(s, ...rest);
        },
    };
});

import { encode } from "gpt-tokenizer";
import {
    SAMPLED_ESTIMATE_MARGIN,
    applyCacheBreakpoints,
    cacheGuardThreshold,
    estimatePrefixTokens,
} from "../providers/anthropic-cache.js";
import { BOUNDED_COUNT_SAMPLE_CHARS, BOUNDED_COUNT_SAMPLE_CHUNKS, boundedTokenCount } from "../engine/bounded-token-count.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = "claude-haiku-4-5";
const BIG = 75 * 1024;
// The tokenizer is handed one sampled chunk at a time: (2 * budget) / chunks chars (500), not the whole budget.
const BOUND = (2 * BOUNDED_COUNT_SAMPLE_CHARS) / BOUNDED_COUNT_SAMPLE_CHUNKS;

function guard(system: TextBlockParam[], messages: MessageParam[]) {
    encodeArgLengths.length = 0;
    const out = applyCacheBreakpoints({ model: MODEL, tools: [], system, messages });
    return { out, maxEncodeArg: Math.max(0, ...encodeArgLengths) };
}

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC2: cache guard is bounded on pathological input", () => {
    it("ea8f6f92 AC2: a 75 KB single-char SYSTEM prompt never reaches the tokenizer whole", () => {
        const { maxEncodeArg } = guard(
            [{ type: "text", text: "a".repeat(BIG) }],
            [{ role: "user", content: "hi" }]
        );
        expect(maxEncodeArg).toBeGreaterThan(0);
        expect(maxEncodeArg).toBeLessThanOrEqual(BOUND);
    });

    it("ea8f6f92 AC2: a 75 KB single-char USER message never reaches the tokenizer whole", () => {
        const { maxEncodeArg } = guard(
            [{ type: "text", text: "You are helpful." }],
            [{ role: "user", content: "z".repeat(BIG) }]
        );
        expect(maxEncodeArg).toBeGreaterThan(0);
        expect(maxEncodeArg).toBeLessThanOrEqual(BOUND);
    });

    it("ea8f6f92 AC2: a normal-size prompt is counted exactly as before (every encode arg is the full text)", () => {
        const text = "Summarise the quarterly report in three bullet points. ".repeat(60);
        expect(text.length).toBeLessThan(20_000);
        const { maxEncodeArg } = guard([{ type: "text", text }], [{ role: "user", content: "go" }]);
        expect(maxEncodeArg).toBe(text.length); // exact path: whole text, same as encode(text)
        // identical figure to the unbounded encoder for normal-size text: no margin, no sampling
        const est = estimatePrefixTokens({ tools: [], system: [{ type: "text", text }], messages: [] });
        expect(est.throughSystem).toBe(encode(text).length);
    });
});

describe("ea8f6f92-d0db-426e-bf9d-bd7ba2fdd5ca AC3: no unbounded encode( in providers/", () => {
    it("ea8f6f92 AC3: no provider source calls the tokenizer's encode( directly", () => {
        const dir = join(HERE, "..", "providers");
        const offenders: string[] = [];
        for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
            const code = readFileSync(join(dir, f), "utf8")
                .split("\n")
                .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
                .join("\n");
            if (/(^|[^.\w])encode\(/.test(code) || /from\s+["']gpt-tokenizer["']/.test(code)) offenders.push(f);
        }
        expect(offenders).toEqual([]);
    });
});

describe("ea8f6f92 review B2-M4: a sampled count keeps the cache guard's undercount margin", () => {
    // Prose interleaved with dash runs: sampled gpt-tokenizer figure lands below the Haiku 4.5 guard
    // (0.75 * 4096 = 3072) but within SAMPLED_ESTIMATE_MARGIN of it.
    const unit = "the quick brown fox ".repeat(5) + "-".repeat(100);
    const text = unit.repeat(Math.ceil(24_000 / unit.length));

    it("ea8f6f92 review-M4: the fixture is a sampled figure just under the guard threshold", () => {
        const raw = boundedTokenCount(text);
        expect(raw.estimated).toBe(true);
        expect(raw.tokens).toBeLessThan(cacheGuardThreshold(MODEL));
        expect(raw.tokens * SAMPLED_ESTIMATE_MARGIN).toBeGreaterThanOrEqual(cacheGuardThreshold(MODEL));
    });

    it("ea8f6f92 review-M4: estimatePrefixTokens inflates a sampled figure by the margin", () => {
        const est = estimatePrefixTokens({ tools: [], system: [{ type: "text", text }], messages: [] });
        expect(est.throughSystem).toBe(Math.ceil(boundedTokenCount(text).tokens * SAMPLED_ESTIMATE_MARGIN));
    });

    it("ea8f6f92 review-M4: the margin keeps the system breakpoint the raw sampled figure would have skipped", () => {
        const out = applyCacheBreakpoints({
            model: MODEL, tools: [], system: [{ type: "text", text }], messages: [{ role: "user", content: "hi" }],
        });
        expect(out.placed).toContain("system");
    });
});
