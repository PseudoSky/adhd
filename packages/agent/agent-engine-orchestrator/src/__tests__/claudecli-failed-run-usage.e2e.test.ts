/**
 * afa37093 + debd934d + 8333f755 (plan 9ed453c1), END TO END (ADR-0009 e2e lane; not env-gated).
 *
 * The REAL `taskTool` -> `Orchestrator` -> `ClaudeCliProvider` spawns a REAL child (fixtures/fake-claude-usage.mjs,
 * and fake-claude-mcp.mjs with the real loopback bridge for the fatal-after-return case); only the model is
 * absent. Rows are asserted from the real database through `usageQueryByGrain` (the function behind `usage_query`).
 * Scaffold: fixtures/claudecli-usage-e2e-env.ts.
 *
 *  afa37093 AC1  a CLI is_error result records the tokens and the cli_reported cost it emitted
 *  afa37093 AC2  a fatal governance error raised after chat() returns still records the CLI's usage
 *  afa37093 AC3  a timeout / cancel records partial usage if the CLI emitted any; otherwise a zero row marked unmeasured
 *  afa37093 AC4  usage_query returns these rows with the failed task status
 *  debd934d AC1/AC2  first-turn context and the bounded per-turn array reach usage_query from a real child's stream
 *
 * Reference figures (fake-claude-usage.mjs): two calls, context 3,012 then 3,208; aggregate input 20 + cache_read
 * 3,000 + cache_write 3,200 (all 1h) = 6,220, output 50; total_cost_usd 0.00697 == the 1h-tier-priced estimate.
 */
import { afterEach, describe, expect, it } from "vitest";

import { taskCancel, taskTool } from "../tools/task.js";
import { usageQueryByGrain } from "../tools/usage.js";
import { FAKE_MCP_CLAUDE, FAKE_USAGE_CLAUDE, cleanupE2eDirs, makeUsageE2eEnv, until } from "./fixtures/claudecli-usage-e2e-env.js";
import type { IUsageE2eEnv } from "./fixtures/claudecli-usage-e2e-env.js";

const COST = 0.00697;
const envs: IUsageE2eEnv[] = [];
afterEach(() => {
  for (const e of envs.splice(0)) e.close();
  cleanupE2eDirs();
});
const make = (o: Parameters<typeof makeUsageE2eEnv>[0]): IUsageE2eEnv => {
  const e = makeUsageE2eEnv(o);
  envs.push(e);
  return e;
};

const taskRow = (e: IUsageE2eEnv) => usageQueryByGrain(e.db, { include_incomplete: false, limit: 10, grain: "task" }).rows;
const turnRows = (e: IUsageE2eEnv) => usageQueryByGrain(e.db, { include_incomplete: false, limit: 10, grain: "turn" }).rows;

describe("afa37093: a real child that fails still has its spend recorded", () => {
  it("afa37093 AC1 + AC4: a CLI is_error result records tokens and total_cost_usd; usage_query returns the row with task_status failed", async () => {
    const e = make({ claude: FAKE_USAGE_CLAUDE, childEnv: { ADHD_FAKE_CLAUDE_MODE: "error" } });
    const out = await taskTool({ agent_name: "r2-agent", prompt: "go" }, e.deps);
    expect(out.status).toBe("failed");
    const rows = taskRow(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      task_status: "failed", input_tokens: 6_220, output_tokens: 50, cache_creation_1h_tokens: 3_200,
      cache_read_tokens: 3_000, cost_status: "priced", requested_model: "claude-haiku-4-5",
    });
    expect(rows[0]?.cli_reported_cost_usd).toBeCloseTo(COST, 8);
    expect(rows[0]?.est_cost_usd).toBeCloseTo(COST, 6); // 1h tier priced at 2.0x: matches the CLI's own figure
    // The sync result's usage summary carries the cost too (8333f755 AC4).
    expect(out.usage?.direct.est_cost_usd).toBeCloseTo(COST, 6);
  }, 60_000);

  it("debd934d AC1 + AC2: the turn row shows the first call's context and one per-call entry per message id", async () => {
    const e = make({ claude: FAKE_USAGE_CLAUDE, childEnv: { ADHD_FAKE_CLAUDE_MODE: "success" } });
    const out = await taskTool({ agent_name: "r2-agent", prompt: "go" }, e.deps);
    expect(out.status).toBe("completed");
    const [turn] = turnRows(e);
    expect(turn?.first_turn).toEqual({ uncached_input_tokens: 12, cache_read_tokens: 0, cache_creation_tokens: 3_000, output_tokens: 20, context_tokens: 3_012 });
    expect(turn?.per_turn?.map((t) => t.context_tokens)).toEqual([3_012, 3_208]);
    expect(turn?.context_size).toBe(3_208); // peakContextTokens unchanged: the max, not the first
  }, 60_000);

  it("afa37093 AC3: a TIMEOUT records the partial usage the CLI had emitted (both calls), priced, on a failed task", async () => {
    const e = make({ claude: FAKE_USAGE_CLAUDE, childEnv: { ADHD_FAKE_CLAUDE_MODE: "hang" }, timeoutMs: 600 });
    const out = await taskTool({ agent_name: "r2-agent", prompt: "go" }, e.deps);
    expect(out.status).toBe("failed");
    const rows = taskRow(e);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_status: "failed", input_tokens: 6_220, output_tokens: 50, cost_status: "priced", cache_creation_1h_tokens: 3_200 });
    expect(rows[0]?.est_cost_usd).toBeCloseTo(COST, 6); // reconstructed from the stream's per-call usage
    expect(rows[0]?.cli_reported_cost_usd).toBeNull(); // the killed CLI never reported a cost; none is invented
    const failedEvent = e.sqlite.prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'MODEL_RESPONSE'").get(out.task_id) as { payload: string };
    expect(JSON.parse(failedEvent.payload)).toMatchObject({ failed: true, failure: "timeout" });
  }, 60_000);

  it("afa37093 AC3: a CANCEL mid-run records the partial usage the CLI had emitted, on a cancelled task", async () => {
    const e = make({ claude: FAKE_USAGE_CLAUDE, childEnv: { ADHD_FAKE_CLAUDE_MODE: "hang" } });
    const started = await taskTool({ session_id: e.newSession(), prompt: "go", background: true }, e.deps);
    // The provider logs the usage-window warning only after it has read both calls' usage from the stream.
    await until(() => e.warnings.some((w) => w.includes("usage window limit event")), "provider consumed the child's usage");
    taskCancel({ task_id: started.task_id }, e.deps);
    await until(() => e.taskStatus(started.task_id) === "cancelled" && taskRow(e).length === 1, "cancelled task's usage row completed");
    expect(taskRow(e)[0]).toMatchObject({ task_status: "cancelled", input_tokens: 6_220, output_tokens: 50, cost_status: "priced" });
    expect(taskRow(e)[0]?.est_cost_usd).toBeCloseTo(COST, 6);
  }, 60_000);

  it("afa37093 AC3: a timeout with NO usage emitted is a zero row marked unmeasured -- cost NULL, never $0 -- on a failed task", async () => {
    const e = make({ claude: FAKE_USAGE_CLAUDE, childEnv: { ADHD_FAKE_CLAUDE_MODE: "silent-hang" }, timeoutMs: 600 });
    const out = await taskTool({ agent_name: "r2-agent", prompt: "go" }, e.deps);
    expect(out.status).toBe("failed");
    const rows = taskRow(e);
    expect(rows[0]).toMatchObject({ task_status: "failed", input_tokens: 0, output_tokens: 0, model_calls: 0, cost_status: "unmeasured", est_cost_usd: null });
    expect(usageQueryByGrain(e.db, { include_incomplete: false, limit: 10, grain: "task" }).summary).toMatchObject({ est_cost_usd: null, unpriced_tasks: 1 });
    expect(out.usage?.direct.est_cost_usd).toBeNull();
  }, 60_000);

  it("afa37093 AC2: a fatal governance error found during a bridged call (thrown after chat() returns) still records the CLI's usage", async () => {
    const e = make({
      claude: FAKE_MCP_CLAUDE, childEnv: { ADHD_FAKE_CLAUDE_USAGE: "1" }, maxLoops: 1, withCounterServer: true,
    });
    const bump = { server: "counter", tool: "bump" };
    const out = await taskTool({ agent_name: "r2-agent", prompt: JSON.stringify({ calls: [bump, bump, bump] }) }, e.deps);
    expect(out.status).toBe("failed"); // MAX_TOOL_LOOPS_EXCEEDED, raised after chat() returned
    const rows = taskRow(e);
    expect(rows).toHaveLength(1);
    // aggregate: input 30 + cache_read 3,030 = 3,060; output 15
    expect(rows[0]).toMatchObject({ task_status: "failed", input_tokens: 3_060, output_tokens: 15 });
    expect(rows[0]?.cli_reported_cost_usd).toBeCloseTo(0.004, 8);
    expect(rows[0]?.est_cost_usd).not.toBeNull();
    const [turn] = turnRows(e);
    expect(turn?.per_turn?.map((t) => t.context_tokens)).toEqual([1_010, 1_020, 1_030]);
    expect(turn?.first_turn?.context_tokens).toBe(1_010);
  }, 60_000);
});
