/**
 * R7-think AC3c -- claude-sonnet-5-5 is priced from the committed OpenRouter snapshot ($2 in / $10 out / cache read 0.10 /
 * write 5m 2.50 / 1h 4.00 per M, anthropic/claude-sonnet-5.5), never at the FAMILY_ALIASES `sonnet` (4.6, $3/$15) card.
 */
import { describe, expect, it } from "vitest";

import { estimateCost, parseBundledSnapshot } from "../pricing/rate-card.js";

const USAGE = {
  uncachedInputTokens: 1_000_000,
  cacheReadTokens: 1_000_000,
  cacheCreationTokens: 2_000_000,
  cacheCreation1hTokens: 1_000_000,
  outputTokens: 1_000_000,
};
const SNAPSHOT_USD = 2 + 0.1 + 2.5 + 4.0 + 10; // input + cache read + 5m write + 1h write + output
const SONNET_4_6_USD = 3 + 0.3 + 3.75 + 6.0 + 15;

describe("R7-think AC3c: claude-sonnet-5-5 rate", () => {
  it("the bundled snapshot record is the $2/$10 source the estimate is derived from", () => {
    const feed = parseBundledSnapshot().models.find((m) => m.modelId === "anthropic/claude-sonnet-5.5");
    expect(feed?.kind).toBe("model");
    expect(feed?.inputPerM).toBeCloseTo(2, 9);
    expect(feed?.outputPerM).toBeCloseTo(10, 9);
    expect(feed?.cacheReadPerM).toBeCloseTo(0.1, 9);
    expect(feed?.cacheWritePerM).toBeCloseTo(2.5, 9);
    expect(feed?.cacheWrite1hPerM).toBeCloseTo(4.0, 9);
  });

  it.each(["claude-sonnet-5-5", "claude-sonnet-5-5-20260101", "anthropic/claude-sonnet-5-5", "Claude-Sonnet-5-5"])(
    "%s prices at the snapshot card and is labelled snapshot-sourced (strict and non-strict)",
    (model) => {
      for (const strict of [false, true]) {
        const est = estimateCost(model, USAGE, { strict });
        expect(est.status).toBe("priced");
        expect(est.basis).toBe("openrouter-estimate");
        expect(est.resolvedId).toBe("anthropic/claude-sonnet-5.5");
        expect(est.pricingRef).toMatch(/^bundled:.*:anthropic\/claude-sonnet-5\.5$/);
        expect(est.costUsd).toBeCloseTo(SNAPSHOT_USD, 9);
      }
    }
  );

  it("negative control: the old behaviour (sonnet family fallback) would have charged the 4.6 card -- the two differ", () => {
    expect(SONNET_4_6_USD).toBeGreaterThan(SNAPSHOT_USD * 1.4);
    expect(estimateCost("claude-sonnet-5-5", USAGE).costUsd).not.toBeCloseTo(SONNET_4_6_USD, 3);
  });

  it("neighbours are unchanged: 'sonnet' and 'claude-sonnet-4-6' stay on the 4.6 card; 'claude-sonnet-5' stays the documented alias; an unknown sonnet id is unpriced under strict", () => {
    expect(estimateCost("sonnet", USAGE).pricingRef).toBe("rate-card:claude_sonnet_4_6");
    expect(estimateCost("claude-sonnet-4-6", USAGE, { strict: true }).costUsd).toBeCloseTo(SONNET_4_6_USD, 9);
    expect(estimateCost("claude-sonnet-5", USAGE).pricingRef).toBe("rate-card:claude_sonnet_4_6");
    expect(estimateCost("claude-sonnet-5-6", USAGE, { strict: true }).status).toBe("unpriced_model");
  });
});
