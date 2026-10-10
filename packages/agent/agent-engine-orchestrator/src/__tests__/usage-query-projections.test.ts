/**
 * 8333f755 (plan 9ed453c1) -- usage_query projections that previously required reading SQLite directly.
 *
 *  AC1  usage_query rows include cli_reported_cost_usd.
 *  AC2  usage_query rows include requested_model next to the resolved model.
 *  AC3  usage_query rows include cache_creation_1h_tokens.
 *  AC4  sync task and result usage summaries include est_cost_usd.
 *
 * Real ClaudeCliProvider + Orchestrator + UsagePlugin + migrated SQLite; only `child_process.spawn` is replaced
 * by the recorded `--model haiku` run (fixtures/claudecli-alias-haiku.stream.jsonl: the alias resolved to
 * claude-haiku-5-5, every cache write on the 1-hour tier, total_cost_usd 0.02025881).
 */
import { describe, expect, it, vi } from "vitest";

import { buildTaskUsageReport, usageQueryByGrain } from "../tools/usage.js";
import { fixture, replayStream } from "./fixtures/claudecli-replay-harness.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const ALIAS = fixture("claudecli-alias-haiku.stream.jsonl");
const CLI_COST = 0.02025881;
const WRITE_1H = 85_269;

describe("8333f755: usage_query exposes the columns/fields the CLI-parity experiments had to read from SQLite", () => {
  it("8333f755 AC1: task and turn grain rows include cli_reported_cost_usd, equal to the CLI's total_cost_usd", async () => {
    const r = await replayStream(ALIAS, "haiku");
    const task = usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "task" });
    expect(task.rows[0]?.cli_reported_cost_usd).toBeCloseTo(CLI_COST, 8);
    const turn = usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "turn" });
    expect(turn.rows[0]?.cli_reported_cost_usd).toBeCloseTo(CLI_COST, 8);
    // The estimate and the CLI figure are now comparable from one response (the cross-check the ticket asked for).
    expect(task.rows[0]?.est_cost_usd).toBeCloseTo(CLI_COST, 5);
    r.close();
  });

  it("8333f755 AC1: a provider that reports no cost has cli_reported_cost_usd null (never 0)", async () => {
    const noCost = ALIAS.split("\n").filter(Boolean).map((l) => {
      const e = JSON.parse(l) as Record<string, unknown>;
      if (e["type"] === "result") delete e["total_cost_usd"];
      return JSON.stringify(e);
    }).join("\n") + "\n";
    const r = await replayStream(noCost, "haiku");
    expect(usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "task" }).rows[0]?.cli_reported_cost_usd).toBeNull();
    r.close();
  });

  it("8333f755 AC2: rows show requested_model (the alias) next to the resolved model", async () => {
    const r = await replayStream(ALIAS, "haiku");
    for (const grain of ["task", "turn"] as const) {
      const row = usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain }).rows[0];
      expect(row?.requested_model).toBe("haiku");
      expect(row?.model).toBe("claude-haiku-5-5");
    }
    r.close();
  });

  it("8333f755 AC3: rows include cache_creation_1h_tokens -- persisted on task_usage and projected at task, turn and session grain", async () => {
    const r = await replayStream(ALIAS, "haiku");
    const col = r.sqlite.prepare("SELECT cache_creation_1h_tokens AS v FROM task_usage WHERE task_id = ?").get(r.taskId) as { v: number };
    expect(col.v).toBe(WRITE_1H);
    for (const grain of ["task", "turn", "session"] as const) {
      const row = usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain }).rows[0];
      // Session grain needs a session id on the tasks row; the harness task has one.
      expect(row?.cache_creation_1h_tokens, grain).toBe(WRITE_1H);
      expect(row?.cache_creation_tokens, grain).toBe(WRITE_1H);
    }
    r.close();
  });

  it("8333f755 AC3: a legacy row (column NULL) projects null = not recorded, never a fabricated 0", async () => {
    const r = await replayStream(ALIAS, "haiku");
    r.sqlite.prepare("UPDATE task_usage SET cache_creation_1h_tokens = NULL WHERE task_id = ?").run(r.taskId);
    expect(usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "task" }).rows[0]?.cache_creation_1h_tokens).toBeNull();
    r.close();
  });

  it("8333f755 AC4: the task result usage summary (direct and subtree) includes est_cost_usd", async () => {
    const r = await replayStream(ALIAS, "haiku");
    const report = buildTaskUsageReport(r.db, r.taskId);
    expect(report?.direct.est_cost_usd).toBeCloseTo(CLI_COST, 5);
    expect(report?.subtree.est_cost_usd).toBeCloseTo(CLI_COST, 5);
    // It is the same number the grain rows carry.
    expect(report?.direct.est_cost_usd).toBe(usageQueryByGrain(r.db, { include_incomplete: true, limit: 5, grain: "task" }).rows[0]?.est_cost_usd);
    r.close();
  });

  it("8333f755 AC4: est_cost_usd is null (never 0) when a contributing turn could not be priced", async () => {
    const r = await replayStream(ALIAS, "haiku");
    r.sqlite.prepare("UPDATE task_usage SET est_cost_usd = NULL WHERE task_id = ?").run(r.taskId);
    expect(buildTaskUsageReport(r.db, r.taskId)?.direct.est_cost_usd).toBeNull();
    r.close();
  });
});
