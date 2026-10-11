/**
 * b3999dfa AC3: `mergeProviderUsage` accounts for EVERY field of `TokenUsage` / `ProviderTokenUsage`.
 *
 * The merge spreads `...later` and sums an enumerated list, so a numeric field added to the type later would
 * silently keep only the second attempt's value. `HANDLING` is a `Record` over `keyof ProviderTokenUsage`: adding
 * a field to either interface fails `typecheck-spec` here until it is classified, and the behavioural assertions
 * below then prove the classification matches what the merge does.
 */
import { describe, expect, it } from "vitest";

import { mergeProviderUsage } from "../providers/partial-usage.js";
import type { IProviderTurnUsage, ProviderTokenUsage } from "../providers/partial-usage.js";

type Handling =
  | "summed" //          earlier + later
  | "max" //             Math.max(earlier, later)
  | "later" //           the later attempt's value is the response's
  | "merged-list" //     both lists combined (per-model entries added)
  | "dropped-unless-both" // kept only when both sides carry it (otherwise it would misdescribe part of the tokens)
  | "first-attempt" //   taken from the earlier attempt (with perTurnUsage)
  | "flag"; //           boolean derived from either side

const HANDLING: Record<keyof ProviderTokenUsage, Handling> = {
  inputTokens: "summed",
  outputTokens: "summed",
  stopReason: "later",
  maxTokens: "later",
  uncachedInputTokens: "summed",
  cacheReadTokens: "summed",
  cacheCreationTokens: "summed",
  cacheCreation1hTokens: "summed",
  reasoningTokens: "summed",
  cliReportedCostUsd: "summed",
  peakContextTokens: "max",
  modelBreakdown: "merged-list",
  firstTurnContextTokens: "first-attempt",
  perTurnUsage: "dropped-unless-both",
  perTurnUsageTruncated: "dropped-unless-both",
  unmeasured: "flag",
  usageLowerBound: "flag",
};

const turnEntry: IProviderTurnUsage = { uncachedInputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1, contextTokens: 1 };

/** A usage with every NUMERIC field set to a value derived from `seed`, so a wrong merge cannot coincide with the right one. */
function populated(seed: number, stopReason: string): ProviderTokenUsage {
  const usage: ProviderTokenUsage = {
    inputTokens: 100 * seed,
    outputTokens: 10 * seed,
    stopReason,
    maxTokens: 1000 + seed,
    uncachedInputTokens: 7 * seed,
    cacheReadTokens: 11 * seed,
    cacheCreationTokens: 13 * seed,
    cacheCreation1hTokens: 3 * seed,
    reasoningTokens: 5 * seed,
    cliReportedCostUsd: 0.5 * seed,
    peakContextTokens: 1000 * seed,
    modelBreakdown: [{ model: "m", uncachedInputTokens: seed, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, outputTokens: seed }],
    firstTurnContextTokens: 50 * seed,
    perTurnUsage: [{ ...turnEntry }],
  };
  return usage;
}

describe("b3999dfa AC3: mergeProviderUsage handles every TokenUsage field", () => {
  it("b3999dfa AC3: every field of the type is classified, and the merge does what the classification says", () => {
    const first = populated(1, "tool_use");
    const second = populated(2, "end_turn");
    const merged = mergeProviderUsage(first, second);

    // Every populated key is a classified key (a field added to the fixture but not the type would not compile either).
    for (const key of Object.keys(first) as (keyof ProviderTokenUsage)[]) expect(HANDLING[key], `unclassified ${key}`).toBeDefined();

    // A field the fixture leaves unset would pass its branch vacuously (undefined === undefined).
    for (const [key, how] of Object.entries(HANDLING) as [keyof ProviderTokenUsage, Handling][]) {
      if (how !== "flag" && how !== "dropped-unless-both") expect(first[key], `fixture must populate ${key}`).toBeDefined();
    }

    for (const [key, how] of Object.entries(HANDLING) as [keyof ProviderTokenUsage, Handling][]) {
      const a = first[key];
      const b = second[key];
      switch (how) {
        case "summed":
          expect(merged[key], `${key} must be summed`).toBe((a as number) + (b as number));
          break;
        case "max":
          expect(merged[key], `${key} must be the max`).toBe(Math.max(a as number, b as number));
          break;
        case "later":
          expect(merged[key], `${key} must be the later value`).toBe(b);
          break;
        case "merged-list":
          expect(merged.modelBreakdown).toEqual([{ model: "m", uncachedInputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, cacheCreation1hTokens: 0, outputTokens: 3 }]);
          break;
        case "first-attempt":
          expect(merged[key], `${key} must come from the earlier attempt`).toBe(a);
          break;
        case "dropped-unless-both":
          if (key === "perTurnUsage") expect(merged.perTurnUsage).toHaveLength(2);
          else expect(merged[key]).toBeUndefined();
          break;
        case "flag":
          expect(merged[key]).toBeUndefined(); // both sides measured and exact
          break;
      }
    }
  });

  it("b3999dfa AC3: a numeric field is never taken from only one side of two measured attempts", () => {
    const merged = mergeProviderUsage(populated(1, "a"), populated(3, "b"));
    const numericSummed = (Object.keys(HANDLING) as (keyof ProviderTokenUsage)[]).filter((k) => HANDLING[k] === "summed");
    expect(numericSummed.length).toBeGreaterThanOrEqual(8);
    for (const k of numericSummed) expect(merged[k]).not.toBe(populated(3, "b")[k]);
  });
});
