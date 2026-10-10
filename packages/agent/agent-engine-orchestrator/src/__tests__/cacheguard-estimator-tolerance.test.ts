/**
 * ebfe7421 AC2 — "the estimate for the tools block is within a stated tolerance of the real count
 * on the measured fixture."
 *
 * The real tools-block count is not separately measurable from the logs (the API reports one
 * `input_tokens` for the whole request), so the tolerance is stated on what IS measured: the
 * WHOLE-PREFIX estimate produced by the production estimator (`estimatePrefixTokens`, the function
 * `applyCacheBreakpoints` gates on), run against the three real logged request bodies in
 * `fixtures/cacheguard/haiku45-turn{1,2,3}.json`, versus the API's own `input_tokens`
 * (3130 / 4404 / 4714):
 *
 *     CACHE_ESTIMATE_LOWER_TOLERANCE (0.78) * real <= estimate <= real
 *
 * Upper bound = the estimate is a lower bound (never places a breakpoint the API would refuse).
 * Lower bound = the 0.75 gate (CG ids CG-AC1/CG-AC2) clears every real prefix at or above the
 * model minimum. The tools-block component is pinned to its definition and the server-tool credit
 * to its measured value (2180 = 1090 + 1090 on this fixture), so the credit that dominates the
 * tools block cannot drift silently.
 *
 * Unit lane: pure functions, fixtures read from disk only; no network, no subprocess.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";
import type { MessageParam, TextBlockParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import {
  CACHE_ESTIMATE_LOWER_TOLERANCE,
  CACHE_GUARD_SAFETY_RATIO,
  estimatePrefixTokens,
  estimateToolsTokens,
  minCacheableTokens,
  serverToolTokens,
} from "../providers/anthropic-cache.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface IRealTurn {
  realInputTokens: number;
  request: { model: string; system: TextBlockParam[]; tools: Tool[]; messages: MessageParam[] };
}
const turn = (n: 1 | 2 | 3): IRealTurn =>
  JSON.parse(readFileSync(join(HERE, "fixtures", "cacheguard", `haiku45-turn${n}.json`), "utf8")) as IRealTurn;

const REAL = [3130, 4404, 4714] as const;
const TURNS = [1, 2, 3] as const;

describe("ebfe7421 AC2: whole-prefix estimator vs the API's real input_tokens", () => {
  it.each(TURNS)(
    "ebfe7421 AC2 / CG-AC1: turn %i estimate is within [0.78 * real, real] (lower bound, never below 78%)",
    n => {
      const t = turn(n);
      expect(t.realInputTokens).toBe(REAL[n - 1]);
      const est = estimatePrefixTokens(t.request).total;
      const ratio = est / t.realInputTokens;
      // eslint-disable-next-line no-console
      console.info(`ebfe7421 AC2 turn${n}: estimate=${est} real=${t.realInputTokens} ratio=${ratio.toFixed(4)}`);
      expect(est).toBeLessThanOrEqual(t.realInputTokens);
      expect(est).toBeGreaterThanOrEqual(CACHE_ESTIMATE_LOWER_TOLERANCE * t.realInputTokens);
    },
  );

  it("ebfe7421 AC2 / CG-AC1: the estimator reproduces the debug-measured estimates 2532 / 3566 / 3770", () => {
    expect(TURNS.map(n => estimatePrefixTokens(turn(n).request).total)).toEqual([2532, 3566, 3770]);
  });

  it("ebfe7421 AC2 / CG-AC1: the tolerance floor is above the guard ratio, so the 0.75 gate clears every real prefix >= the minimum", () => {
    expect(CACHE_ESTIMATE_LOWER_TOLERANCE).toBeGreaterThan(CACHE_GUARD_SAFETY_RATIO);
    for (const n of TURNS) {
      const t = turn(n);
      const min = minCacheableTokens(t.request.model);
      // gate input is the estimate; a real prefix at the minimum would estimate at >= 0.78 * min >= 0.75 * min
      expect(Math.ceil(CACHE_ESTIMATE_LOWER_TOLERANCE * min)).toBeGreaterThanOrEqual(Math.ceil(CACHE_GUARD_SAFETY_RATIO * min));
      if (t.realInputTokens >= min) {
        expect(estimatePrefixTokens(t.request).total).toBeGreaterThanOrEqual(Math.ceil(CACHE_GUARD_SAFETY_RATIO * min));
      }
    }
  });
});

describe("ebfe7421 AC2: tools-block estimate component", () => {
  it.each(TURNS)("ebfe7421 AC2 / CG-AC1: turn %i tools estimate = countTokens(JSON.stringify(tools)) + serverToolTokens(tools)", n => {
    const { tools } = turn(n).request;
    const expected = encode(JSON.stringify(tools)).length + serverToolTokens(tools);
    expect(estimateToolsTokens(tools)).toBe(expected);
    expect(estimatePrefixTokens(turn(n).request).tools).toBe(expected);
  });

  it("ebfe7421 AC2 / CG-AC1: fixture tools are shell_execute + web_search + web_fetch and the server-tool credit is 2180", () => {
    const { tools } = turn(1).request;
    const names = tools.map(t => (t as { name: string }).name);
    expect(names).toEqual(["shell__shell_execute", "web_search", "web_fetch"]);
    expect(tools.map(t => (t as { type?: string }).type)).toEqual([undefined, "web_search_20250305", "web_fetch_20250910"]);
    expect(serverToolTokens(tools)).toBe(2180);
  });

  it("ebfe7421 AC2 / CG-AC1: the tools block is a stub-JSON component plus the credit, and the credit is the bulk of it", () => {
    const { tools } = turn(1).request;
    const stub = encode(JSON.stringify(tools)).length;
    const credit = serverToolTokens(tools);
    expect(estimateToolsTokens(tools)).toBe(stub + credit);
    expect(credit).toBeGreaterThan(stub);
  });
});
