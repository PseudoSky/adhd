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
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { projectTaskRecord, resultTool, taskList } from "../tools/task.js";
import { nowIso } from "../utils/timestamps.js";

const DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  agent_name TEXT NOT NULL,
  agent_version INTEGER NOT NULL,
  agent_data TEXT NOT NULL,
  status TEXT DEFAULT 'active' NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  composed_prompt_id TEXT
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_results TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT,
  parent_task_id TEXT,
  is_ephemeral INTEGER DEFAULT 0 NOT NULL,
  recursion_depth INTEGER DEFAULT 0 NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL,
  prompt TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  depends_on TEXT,
  on_upstream_failure TEXT,
  inputs TEXT,
  resume_token TEXT
);
CREATE TABLE task_events (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE task_usage (
  task_id TEXT PRIMARY KEY NOT NULL,
  root_task_id TEXT,
  agent_name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0 NOT NULL,
  output_tokens INTEGER DEFAULT 0 NOT NULL,
  tool_call_count INTEGER DEFAULT 0 NOT NULL,
  model_calls INTEGER DEFAULT 0 NOT NULL,
  latency_ms INTEGER DEFAULT 0 NOT NULL,
  is_complete INTEGER DEFAULT 0 NOT NULL,
  stop_reason TEXT,
  max_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  uncached_input_tokens INTEGER,
  reasoning_tokens INTEGER,
  peak_context_tokens INTEGER,
  peak_context_at INTEGER,
  compute_ms INTEGER,
  est_tool_result_tokens INTEGER,
  est_cost_usd REAL,
  created_at TEXT NOT NULL
);
`;

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
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
