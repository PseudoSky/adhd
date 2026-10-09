/**
 * task-list-contract.test.ts — drives the REAL `taskList` / `resultTool` tools
 * against a REAL better-sqlite3 TaskStore (no mocks) to prove the two fixes:
 *
 *   - f2b004eb: `task_list`/`result` no longer force the caller to receive every
 *     matching task's full prompt+result text — `fields` / `summary` project the
 *     output, and `limit`/`offset` page it. Without projection a 30-item poll
 *     returned 55-76KB and was truncated by the harness.
 *   - df109078: `task_list` now accepts `session_ids[]` and `agent_name`, so a
 *     caller tracking one batch need not scan the whole instance and filter.
 *
 * Teeth: reverting the schema/store changes makes the filter/projection assertions
 * fail (keys reappear / counts change), not merely "look different".
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { projectTaskRecord, resultTool, taskList } from "../tools/task.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

function makeDb() {
  const sqlite = createMigratedSqlite();
  return drizzle(sqlite, { schema });
}

function agentDef(name: string): AgentDefinition {
  const now = nowIso();
  return {
    name,
    version: 1,
    provider: { type: "openai", model: "gpt-4o-mini" } as AgentDefinition["provider"],
    systemPrompt: "You are helpful.",
    mcpServers: {},
    permissions: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("task_list / result contract (f2b004eb + df109078)", () => {
  let db: ReturnType<typeof makeDb>;
  let taskStore: TaskStore;
  let sidA: string;
  let sidB: string;

  beforeEach(() => {
    db = makeDb();
    const sessionStore = new SessionStore(
      db as unknown as Parameters<typeof SessionStore.prototype.constructor>[0]
    );
    taskStore = new TaskStore(
      db as unknown as Parameters<typeof TaskStore.prototype.constructor>[0]
    );
    sidA = sessionStore.create({ agentName: "agent-a", agentDefinition: agentDef("agent-a") }).id;
    sidB = sessionStore.create({ agentName: "agent-b", agentDefinition: agentDef("agent-b") }).id;
  });

  const resultDeps = () =>
    ({ taskStore, db } as unknown as Parameters<typeof resultTool>[1]);

  it("projects task_list to exactly the requested fields (id always kept)", () => {
    taskStore.create({ sessionId: sidA, prompt: "a very long prompt body" });
    const list = taskList({ fields: ["id", "status"] }, { taskStore });
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(["id", "status"]);
    expect(list[0].status).toBe("pending");
  });

  it("summary:true drops the bulk prompt/result but keeps the rest", () => {
    const t = taskStore.create({ sessionId: sidA, prompt: "P".repeat(5000) });
    taskStore.updateStatus(t.id, "completed", { result: "R".repeat(5000) });

    const list = taskList({ summary: true }, { taskStore });
    const item = list[0] as unknown as Record<string, unknown>;
    expect("prompt" in item).toBe(false);
    expect("result" in item).toBe(false);
    expect(item['id']).toBe(t.id);
    expect(item['status']).toBe("completed");
  });

  it("default (no projection) still returns the full task incl. prompt+result", () => {
    const t = taskStore.create({ sessionId: sidA, prompt: "hello" });
    taskStore.updateStatus(t.id, "completed", { result: "world" });
    const list = taskList({}, { taskStore });
    expect(list[0].prompt).toBe("hello");
    expect(list[0].result).toBe("world");
  });

  it("filters by session_ids[] (plural) — only those sessions' tasks", () => {
    taskStore.create({ sessionId: sidA, prompt: "A" });
    taskStore.create({ sessionId: sidB, prompt: "B" });
    const list = taskList({ session_ids: [sidA] }, { taskStore });
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(sidA);
  });

  it("filters by agent_name (via the task's session)", () => {
    taskStore.create({ sessionId: sidA, prompt: "A" });
    taskStore.create({ sessionId: sidB, prompt: "B" });
    const list = taskList({ agent_name: "agent-a" }, { taskStore });
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(sidA);
  });

  it("paginates with limit/offset deterministically (no overlap, no loss)", () => {
    for (const p of ["t1", "t2", "t3"]) taskStore.create({ sessionId: sidA, prompt: p });
    const first = taskList({ limit: 2 }, { taskStore });
    const second = taskList({ limit: 2, offset: 2 }, { taskStore });
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    const ids = new Set([...first, ...second].map(t => t.id));
    expect(ids.size).toBe(3);
  });

  it("resultTool projects to requested fields", () => {
    const t = taskStore.create({ sessionId: sidA, prompt: "p" });
    const projected = resultTool({ task_id: t.id, fields: ["id", "status"] }, resultDeps());
    expect(Object.keys(projected).sort()).toEqual(["id", "status"]);
  });

  it("resultTool without projection keeps the usage key", () => {
    const t = taskStore.create({ sessionId: sidA, prompt: "p" });
    const full = resultTool({ task_id: t.id }, resultDeps());
    expect("usage" in full).toBe(true);
    expect(full.id).toBe(t.id);
  });

  it("projectTaskRecord: summary omits prompt/result; fields always keeps id", () => {
    const rec = { id: "x", prompt: "P", result: "R", status: "pending" };
    expect(projectTaskRecord(rec, undefined, true)).toEqual({ id: "x", status: "pending" });
    expect(projectTaskRecord(rec, ["status"])).toEqual({ id: "x", status: "pending" });
  });

  it("a projected element is typed partial — a dropped field may be absent", () => {
    taskStore.create({ sessionId: sidA, prompt: "a long prompt body" });
    const [projected] = taskList({ fields: ["status"] }, { taskStore });
    // Runtime: projection physically omits the unrequested `prompt`.
    expect(Object.keys(projected).sort()).toEqual(["id", "status"]);
    // Compile-time guard (checked by `tsc`, not vitest's runtime): a projected
    // element's `prompt` is `string | undefined`, so it must NOT narrow to
    // `string`. Reverting the return type to `Task[]` would make this compile,
    // turning the directive below into an unused `@ts-expect-error`.
    // @ts-expect-error - projection may have dropped `prompt`.
    const _promptIsOptional: string = projected.prompt;
    void _promptIsOptional;
  });
});
