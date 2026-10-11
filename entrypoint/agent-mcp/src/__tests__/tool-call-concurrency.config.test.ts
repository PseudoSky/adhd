/**
 * tool-call-concurrency.config.test.ts — backlog 668fae7a: `agent.toolCallConcurrency`
 * (`ADHD_AGENT_TOOL_CALL_CONCURRENCY`) resolves through the Environment cascade, reaches the
 * engine config via `toEngineConfig()`, and malformed values fail loud with a RangeError.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TOOL_CALL_CONCURRENCY } from "@adhd/agent-engine-orchestrator";

import { parseToolCallConcurrency } from "../config.js";

const ENV = "ADHD_AGENT_TOOL_CALL_CONCURRENCY";
const prev = process.env[ENV];

function set(v: string | undefined): void {
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
}

afterEach(() => set(prev));

/** The module-level `env` snapshots process.env at import, so load a fresh config module per env value. */
async function freshConfig(value: string | undefined): Promise<typeof import("../config.js")> {
  set(value);
  vi.resetModules();
  return import("../config.js");
}

describe("668fae7a AC1 agent.toolCallConcurrency through the cascade into the engine config", () => {
  it("the code default is 8", () => {
    expect(DEFAULT_TOOL_CALL_CONCURRENCY).toBe(8);
  });

  it("a4235310 AC5 the engine barrel is the single definition: config.ts re-declares nothing and its default resolves to the engine constant", async () => {
    const mod = await freshConfig(undefined);
    expect("DEFAULT_TOOL_CALL_CONCURRENCY" in mod).toBe(false);
    expect(mod.toEngineConfig().toolCallConcurrency).toBe(DEFAULT_TOOL_CALL_CONCURRENCY);
  });

  it("668fae7a AC2 absent env resolves to the code default 8 with default provenance", async () => {
    const { toEngineConfig, env } = await freshConfig(undefined);
    expect(toEngineConfig().toolCallConcurrency).toBe(8);
    expect(env.get("provenance.agent.toolCallConcurrency")).toMatchObject({ source: "default" });
  });

  it("668fae7a AC1 ADHD_AGENT_TOOL_CALL_CONCURRENCY reaches the Orchestrator config", async () => {
    const { toEngineConfig, env } = await freshConfig("3");
    expect(toEngineConfig().toolCallConcurrency).toBe(3);
    expect(env.get("provenance.agent.toolCallConcurrency")).toMatchObject({ source: "env", env: ENV });
  });
});

describe("668fae7a AC2 malformed values fail loud", () => {
  it.each(["0", "-1", "abc", "1.5", "8x", "", "  ", "1e3", "NaN"])("env %p throws RangeError from toEngineConfig", async (bad) => {
    const { toEngineConfig } = await freshConfig(bad);
    expect(() => toEngineConfig()).toThrow(RangeError);
  });

  it("parseToolCallConcurrency accepts positive integers and numbers, rejects the rest", () => {
    expect(parseToolCallConcurrency("12")).toBe(12);
    expect(parseToolCallConcurrency(4)).toBe(4);
    expect(() => parseToolCallConcurrency(undefined)).toThrow(RangeError);
    expect(() => parseToolCallConcurrency(0)).toThrow(RangeError);
  });
});
