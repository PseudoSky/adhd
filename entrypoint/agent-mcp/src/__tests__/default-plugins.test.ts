import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_PLUGIN_MODULE,
  defaultPluginEntries,
} from "../config.js";

/**
 * Backlog 5339c2e5 — agent-mcp loads agent-plugin-budget BY DEFAULT with a
 * conservative, always-enforceable cap, so an unattended dispatch run stops at
 * a spend limit without any operator-authored config file.
 *
 * These assertions FAIL if the default entry is removed (test 1) or the opt-out
 * / env caps stop being honoured.
 */
describe("defaultPluginEntries — default-on budget plugin (5339c2e5)", () => {
  it("returns the budget plugin by default, with a conservative call cap", () => {
    const entries = defaultPluginEntries({} as NodeJS.ProcessEnv);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.module).toBe(DEFAULT_BUDGET_PLUGIN_MODULE);
    const defaults = entries[0]?.config["defaults"] as {
      mode?: string;
      caps?: Array<{ field: string; maximum: number }>;
    };
    expect(defaults.mode).toBe("block");
    expect(defaults.caps).toContainEqual({ field: "calls", maximum: 500 });
  });

  it("honours ADHD_AGENT_BUDGET_MAX_CALLS", () => {
    const entries = defaultPluginEntries({
      ADHD_AGENT_BUDGET_MAX_CALLS: "7",
    } as unknown as NodeJS.ProcessEnv);
    const defaults = entries[0]?.config["defaults"] as {
      caps?: Array<{ field: string; maximum: number }>;
    };
    expect(defaults.caps).toContainEqual({ field: "calls", maximum: 7 });
  });

  it("adds an enforceable cost cap when ADHD_AGENT_BUDGET_COST_USD is set", () => {
    const entries = defaultPluginEntries({
      ADHD_AGENT_BUDGET_COST_USD: "0.01",
    } as unknown as NodeJS.ProcessEnv);
    const defaults = entries[0]?.config["defaults"] as {
      caps?: Array<{ field: string; maximum: number }>;
      costPerInputToken?: number;
      costPerOutputToken?: number;
    };
    expect(defaults.caps).toContainEqual({ field: "cost", maximum: 0.01 });
    // Rates must be present, otherwise the plugin computes cost 0 and the cap
    // could never fire — this is the "enforceable" half of the DoD.
    expect(defaults.costPerInputToken).toBeGreaterThan(0);
    expect(defaults.costPerOutputToken).toBeGreaterThan(0);
  });

  it("is opt-OUT via ADHD_AGENT_DISABLE_BUDGET_PLUGIN=1", () => {
    expect(
      defaultPluginEntries({
        ADHD_AGENT_DISABLE_BUDGET_PLUGIN: "1",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual([]);
    expect(
      defaultPluginEntries({
        ADHD_AGENT_DISABLE_BUDGET_PLUGIN: "true",
      } as unknown as NodeJS.ProcessEnv)
    ).toEqual([]);
  });
});
