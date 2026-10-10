/**
 * ebfe7421 (D2 follow-up, CG-AC1..CG-AC5) — the cache guard's estimate undercounts the API, so
 * the exact `estimate >= minimum` gate refused to cache prefixes the API would have cached.
 *
 * Fixtures are the three real requests of one claude-haiku-4-5 `task` (shell_execute +
 * web_search_20250305 + web_fetch_20250910, OAuth two-block system, 1/3/5 messages) copied from
 * the agent-mcp api log (`http.request`, before any breakpoint existed) with the API's own
 * `input_tokens` from the paired `http.response`: 3130 / 4404 / 4714. The guard estimated
 * 2532 / 3566 / 3770 (598 / 838 / 944 short, <= 20% of the real count). Turns 2 and 3 are above
 * Haiku 4.5's 4096 minimum and were never cached.
 *
 * Premium question (CG-AC3): Anthropic's prompt-caching docs state a prompt below the model
 * minimum is simply not cached (no cache write, no premium). The one-off live measurement of that
 * claim is recorded in the package README ("cache guard calibration"); this file makes no
 * network call and spawns nothing.
 *
 * Unit lane: pure functions, fixtures read from disk only.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";
import { describe, expect, it } from "vitest";
import type { MessageParam, TextBlockParam, Tool } from "@anthropic-ai/sdk/resources/messages";

import {
  CACHE_GUARD_SAFETY_RATIO,
  UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS,
  applyCacheBreakpoints,
  cacheGuardThreshold,
  minCacheableTokens,
} from "../providers/anthropic-cache.js";
import { distinctFiller } from "./fixtures/anthropic-sse.js";

const HERE = dirname(fileURLToPath(import.meta.url));

interface IRealTurn {
  realInputTokens: number;
  request: { model: string; system: TextBlockParam[]; tools: Tool[]; messages: MessageParam[] };
}
const turn = (n: 1 | 2 | 3): IRealTurn =>
  JSON.parse(readFileSync(join(HERE, "fixtures", "cacheguard", `haiku45-turn${n}.json`), "utf8")) as IRealTurn;

const run = (t: IRealTurn) =>
  applyCacheBreakpoints({
    model: t.request.model,
    tools: t.request.tools,
    system: t.request.system,
    messages: t.request.messages,
    protectedLeadingSystemBlocks: 1, // OAuth identity block
  });

describe("ebfe7421 CG-AC1: real turns above the model minimum get a messages breakpoint", () => {
  it.each([
    [2 as const, 4404],
    [3 as const, 4714],
  ])("ebfe7421 CG-AC1: real turn %i (API input_tokens %i >= 4096) places a messages breakpoint", (n, real) => {
    const t = turn(n);
    expect(t.realInputTokens).toBe(real);
    expect(t.realInputTokens).toBeGreaterThanOrEqual(minCacheableTokens(t.request.model));
    const out = run(t);
    expect(out.placed).toContain("messages");
    // the moving breakpoint lands on the final message, and the protected identity block stays bare
    const last = out.messages[out.messages.length - 1];
    expect(JSON.stringify(last)).toContain('"cache_control":{"type":"ephemeral"}');
    expect(JSON.stringify((out.system as TextBlockParam[])[0])).not.toContain("cache_control");
  });
});

describe("ebfe7421 CG-AC2: below the minimum behaves as documented", () => {
  it("ebfe7421 CG-AC2: real turn 1 (3130 < 4096, API would not cache it) places nothing: estimate 2532 is under the 3072 guard", () => {
    const t = turn(1);
    expect(t.realInputTokens).toBe(3130);
    expect(t.realInputTokens).toBeLessThan(minCacheableTokens(t.request.model));
    const out = run(t);
    expect(out.placed).toEqual([]);
    expect(out.messages).toBe(t.request.messages);
  });

  it("ebfe7421 CG-AC2: a clearly small prefix (~1.5k tokens) still places nothing", () => {
    const system = distinctFiller(190, "sys");
    const user = distinctFiller(190, "usr");
    const approx = encode(system).length + encode(user).length;
    expect(approx).toBeGreaterThan(1200);
    expect(approx).toBeLessThan(1800);
    const out = applyCacheBreakpoints({
      model: "claude-haiku-4-5",
      tools: undefined,
      system,
      messages: [{ role: "user", content: user }],
    });
    expect(out.placed).toEqual([]);
  });

  it("ebfe7421 CG-AC2: an unknown model still assumes 4096 and guards at 0.75 of it", () => {
    expect(minCacheableTokens("some-future-model")).toBe(UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS);
    expect(UNKNOWN_MODEL_MIN_CACHEABLE_TOKENS).toBe(4096);
    expect(CACHE_GUARD_SAFETY_RATIO).toBe(0.75);
    expect(cacheGuardThreshold("some-future-model")).toBe(3072);
    expect(cacheGuardThreshold("claude-haiku-4-5")).toBe(3072);
    expect(cacheGuardThreshold("claude-sonnet-4-6")).toBe(768);
  });

  it("ebfe7421 CG-AC2: the per-model minimum table is unchanged", () => {
    expect(minCacheableTokens("claude-haiku-4-5-20251001")).toBe(4096);
    expect(minCacheableTokens("claude-sonnet-5-1")).toBe(1024);
    expect(minCacheableTokens("claude-haiku-5-5")).toBe(512);
  });
});

describe("ebfe7421 CG-AC1: the margin covers the measured undercount", () => {
  it("ebfe7421 CG-AC1: 0.75 clears the worst measured undercount (20% of the real count) with headroom", () => {
    const worstEstimateOverReal = Math.min(...[1, 2, 3].map(n => {
      // estimate = real - undercount; undercounts measured as 598 / 838 / 944 tokens
      const real = turn(n as 1 | 2 | 3).realInputTokens;
      const undercount = [598, 838, 944][n - 1];
      return (real - undercount) / real;
    }));
    expect(worstEstimateOverReal).toBeGreaterThan(0.79);
    expect(worstEstimateOverReal).toBeGreaterThan(CACHE_GUARD_SAFETY_RATIO);
  });
});
