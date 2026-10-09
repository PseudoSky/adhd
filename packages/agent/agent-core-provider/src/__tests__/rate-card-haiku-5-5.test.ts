/**
 * 79aebb26 (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) BK8 AC8.2 / AC8.5 -- the claude-haiku-5-5 rate entry and
 * strict (concrete-id) pricing. Pure functions only; no I/O.
 */
import { describe, expect, it } from "vitest";

import { RATE_CARD, estimateCost, parseBundledSnapshot } from "../pricing/rate-card.js";

const USAGE = {
  uncachedInputTokens: 8,
  cacheReadTokens: 290_221,
  cacheCreationTokens: 85_269,
  cacheCreation1hTokens: 85_269,
  outputTokens: 604,
};

describe("79aebb26 AC8.5: claude_haiku_5_5 rate entry is verifiable", () => {
  it("79aebb26 AC8.5: matches the bundled OpenRouter feed's anthropic/claude-haiku-5.5 record (per-token USD -> $/MTok)", () => {
    const feed = parseBundledSnapshot().models.find((m) => m.modelId === "anthropic/claude-haiku-5.5");
    expect(feed?.kind).toBe("model");
    const rate = RATE_CARD["claude_haiku_5_5"];
    expect(rate).toBeDefined();
    expect(rate?.inputPerM).toBeCloseTo(feed?.inputPerM ?? NaN, 9);
    expect(rate?.outputPerM).toBeCloseTo(feed?.outputPerM ?? NaN, 9);
    expect(rate?.cacheReadPerM).toBeCloseTo(feed?.cacheReadPerM ?? NaN, 9);
    expect(rate?.cacheWritePerM).toBeCloseTo(feed?.cacheWritePerM ?? NaN, 9);
    expect(rate?.cacheWrite1hPerM).toBeCloseTo(feed?.cacheWrite1hPerM ?? NaN, 9);
  });

  it("79aebb26 AC8.5: reproduces the CLI-reported total_cost_usd of the recorded A0 run (0.02025881) to 8 digits", () => {
    const est = estimateCost("claude-haiku-5-5", USAGE, { strict: true });
    expect(est.status).toBe("priced");
    expect(est.pricingRef).toBe("rate-card:claude_haiku_5_5");
    expect(est.costUsd).toBeCloseTo(0.02025881, 8);
  });

  it("79aebb26 AC8.2: the same tokens at haiku-4-5's card cost ~10x more -- haiku-5-5 is not priced as haiku-4-5", () => {
    const five = estimateCost("claude-haiku-5-5", USAGE, { strict: true }).costUsd ?? 0;
    const four = estimateCost("claude-haiku-4-5", USAGE, { strict: true }).costUsd ?? 0;
    expect(four / five).toBeGreaterThan(9);
  });
});

describe("79aebb26 AC8.2: strict pricing never falls back to a same-family card", () => {
  it("79aebb26 AC8.2: an unknown concrete haiku id is unpriced under strict, with null cost (never 0)", () => {
    const est = estimateCost("claude-haiku-9-9", USAGE, { strict: true });
    expect(est.costUsd).toBeNull();
    expect(est.status).toBe("unpriced_model");
  });

  it("79aebb26 AC8.2: non-strict keeps the human-typed alias behaviour ('haiku', 'claude-sonnet-5' resolve to the newest priced card)", () => {
    expect(estimateCost("haiku", USAGE).pricingRef).toBe("rate-card:claude_haiku_4_5");
    expect(estimateCost("claude-sonnet-5", USAGE).status).toBe("priced");
    expect(estimateCost("claude-sonnet-5", USAGE, { strict: true }).status).toBe("unpriced_model");
  });

  it("79aebb26 AC8.2: strict still resolves a dated snapshot of a priced id (same model, not another family member)", () => {
    expect(estimateCost("claude-haiku-4-5-20251001", USAGE, { strict: true }).pricingRef).toBe("rate-card:claude_haiku_4_5");
  });
});
