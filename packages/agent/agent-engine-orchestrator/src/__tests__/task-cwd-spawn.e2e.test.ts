/**
 * 9ed453c1 CWD — the cwd a task is dispatched with must reach the spawned `claude`
 * process (ADR-0008 D4/D9). Drives the REAL `taskTool` -> `buildProviderForSelection`
 * -> `ClaudeCliProvider` -> real child spawn against a REAL better-sqlite3
 * TaskStore/SessionStore/BackgroundQueue/DagEngine. The ONLY stub is the `claude`
 * executable itself (fixtures/fake-claude.mjs records its own `process.cwd()`).
 * Nothing injects `EngineConfig.cwd`: the host-global config has none, exactly like
 * the real agent-mcp host (the old D9 AC3 test injected it directly and hid this bug).
 *
 * e2e lane (spawns a subprocess, ADR-0009); runs by default in CI, not env-gated.
 * Teeth: reverting the `construct.ts` wiring turns AC1/AC2/AC3 red; reverting the
 * `enqueueExistingTask` cwd restore turns AC3 red.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn as nodeSpawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition } from "@adhd/agent-base-types";

import { enqueueExistingTask, taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import type { SessionStoreForTool } from "../tools/session.js";
import { PolicyEngine } from "../engine/policy.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { nowIso } from "../utils/timestamps.js";

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

// The REAL migrations agent-mcp ships (no hand-rolled DDL that can drift from the schema).
const MIGRATIONS = fileURLToPath(new URL("../../../../../entrypoint/agent-mcp/drizzle", import.meta.url));

const silentLogger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const dirs: string[] = [];
/** A real, symlink-resolved temp dir so the child's `process.cwd()` matches. */
function freshDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function agentDef(name: string): AgentDefinition {
  return {
    name,
    version: 1,
    provider: { type: "claudecli", claudePath: FAKE_CLAUDE, model: "claude-haiku-4-5" } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

interface Env {
  deps: TaskDeps;
  taskStore: TaskStore;
  queue: BackgroundQueue;
  dagEngine: DagEngine;
  sessionId: string;
  /** The cwd the most recent `claude` spawn ran in (fake-claude overwrites its record per spawn). */
  spawnCwd: () => string;
}

function makeEnv(): Env {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  migrate(db, { migrationsFolder: MIGRATIONS });
  // sessions.agent_name -> agents.name is a real FK in the shipped schema.
  sqlite
    .prepare("INSERT INTO agents (name, version, data, created_at, updated_at) VALUES ('cwd-agent', 1, '{}', ?, ?)")
    .run(nowIso(), nowIso());
  chmodSync(FAKE_CLAUDE, 0o755);

  const selfOut = join(freshDir("adhd-cwd-spawn-"), "claude-self.json");
  const hooks = new HookRegistry();
  const sessionStore = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition = agentDef("cwd-agent");
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const queue = new BackgroundQueue(5, silentLogger);
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: 5 });
  const depsRef: { value?: TaskDeps } = {};
  const dagEngine = new DagEngine(
    db,
    queue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore as any,
    async (taskId: string) => {
      if (!depsRef.value) throw new Error("dispatchFn before init");
      await enqueueExistingTask(taskId, depsRef.value);
    },
    silentLogger
  );
  // NOTE: no `cwd` here — the host-global config carries none (as in agent-mcp's toEngineConfig).
  const config = {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 5 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    getProviderConfig: () => ({}),
    subprocessEnv: () => ({ ADHD_FAKE_CLAUDE_OUT: selfOut }),
    isEnvNameAllowed: () => true,
    // Passthrough wire seams: the REAL node spawn/fetch, no logging.
    wire: {
      fetch: globalThis.fetch,
      spawn: nodeSpawn,
      wrapTransport: (t: unknown) => t,
      withContext: (_ctx: unknown, fn: () => unknown) => fn(),
      tempDir: freshDir("adhd-cwd-spawn-tmp-"),
    },
  } as unknown as EngineConfig;

  const deps: TaskDeps = {
    agentStore,
    sessionStore: sessionStore as unknown as SessionStoreForTool,
    taskStore,
    orchestrator: new Orchestrator(),
    queue,
    policy,
    hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error("no in-process tools registered in this test");
    },
    db,
    dagEngine,
    config,
    logger: silentLogger,
  };
  depsRef.value = deps;
  const session = sessionStore.create({ agentName: definition.name, agentDefinition: definition });
  return {
    deps,
    taskStore,
    queue,
    dagEngine,
    sessionId: session.id,
    spawnCwd: () => (JSON.parse(readFileSync(selfOut, "utf8")) as { cwd: string }).cwd,
  };
}

let env: Env;
beforeEach(() => {
  env = makeEnv();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("9ed453c1 CWD: the task cwd reaches the spawned claude (ADR-0008 D9)", () => {
  it("9ed453c1 CWD AC1: a one-shot task dispatched with cwd=/P through the real task tool spawns claude in /P", async () => {
    const P = freshDir("adhd-cwd-P-");
    const out = await taskTool({ agent_name: "cwd-agent", prompt: "run", cwd: P }, env.deps);
    expect(out.status).toBe("completed");
    // REVERT-FAILING: drop the executionContext.cwd override in buildProviderForSelection ->
    // claude spawns in the host process cwd (the vitest runner), not P.
    expect(env.spawnCwd()).toBe(P);
    expect(env.spawnCwd()).not.toBe(process.cwd());
  });

  it("9ed453c1 CWD AC2: the same agent dispatched at /P then /Q spawns in each in turn (no host-global bleed)", async () => {
    const P = freshDir("adhd-cwd-P-");
    const Q = freshDir("adhd-cwd-Q-");
    await taskTool({ agent_name: "cwd-agent", prompt: "one", cwd: P }, env.deps);
    expect(env.spawnCwd()).toBe(P);
    await taskTool({ agent_name: "cwd-agent", prompt: "two", cwd: Q }, env.deps);
    expect(env.spawnCwd()).toBe(Q);
    // A sessioned dispatch on the same session honours its own cwd too.
    await taskTool({ session_id: env.sessionId, prompt: "three", background: false, cwd: P }, env.deps);
    expect(env.spawnCwd()).toBe(P);
    // The host-global config was never mutated by the per-task override.
    expect(env.deps.config.cwd).toBeUndefined();
  });

  it("9ed453c1 CWD AC3: a DAG-gated task keeps its dispatch cwd when the upstream completes and it is redispatched", async () => {
    const P = freshDir("adhd-cwd-P-");
    const upstream = env.taskStore.create({ sessionId: env.sessionId, prompt: "A" });
    const b = await taskTool(
      { session_id: env.sessionId, prompt: "B", background: true, depends_on: [upstream.id], cwd: P },
      env.deps
    );
    expect(b.status).toBe("waiting");
    // The cwd is persisted on the task row (survives a process restart).
    expect(env.taskStore.read(b.task_id).cwd).toBe(P);

    env.taskStore.updateStatus(upstream.id, "completed", { result: "ok" });
    await env.dagEngine.dispatchReady(upstream.id);
    await env.queue.onIdle();
    expect(env.taskStore.read(b.task_id).status).toBe("completed");
    // REVERT-FAILING: drop `cwd: task.cwd` from enqueueExistingTask's ExecutionContext ->
    // the redispatched claude spawns in the host cwd.
    expect(env.spawnCwd()).toBe(P);
  });

  it("9ed453c1 CWD AC3: a restart redispatch (enqueueExistingTask on a persisted pending task) keeps the cwd; a legacy NULL-cwd row falls back to the host cwd", async () => {
    const P = freshDir("adhd-cwd-P-");
    const persisted = env.taskStore.create({ sessionId: env.sessionId, prompt: "R", cwd: P });
    await enqueueExistingTask(persisted.id, env.deps);
    await env.queue.onIdle();
    expect(env.taskStore.read(persisted.id).status).toBe("completed");
    expect(env.spawnCwd()).toBe(P);

    const legacy = env.taskStore.create({ sessionId: env.sessionId, prompt: "L" });
    expect(env.taskStore.read(legacy.id).cwd).toBeNull();
    await enqueueExistingTask(legacy.id, env.deps);
    await env.queue.onIdle();
    expect(env.taskStore.read(legacy.id).status).toBe("completed");
    expect(env.spawnCwd()).toBe(process.cwd());
  });

  it("9ed453c1 BLIND F9: a redispatch whose persisted cwd no longer exists fails the task hard, naming the directory, and never spawns", async () => {
    const gone = freshDir("adhd-cwd-gone-");
    const task = env.taskStore.create({ sessionId: env.sessionId, prompt: "G", cwd: gone });
    rmSync(gone, { recursive: true, force: true });
    await enqueueExistingTask(task.id, env.deps);
    await env.queue.onIdle();
    const after = env.taskStore.read(task.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain(gone);
    expect(after.error).toMatch(/no longer exists/);
    // Not an opaque spawn ENOENT, and no fallback to the host cwd: claude was never launched.
    expect(after.error).not.toMatch(/ENOENT/);
    expect(() => env.spawnCwd()).toThrow();
  });

  it("9ed453c1 BLIND F9: a persisted cwd that is a file (not a directory) is refused the same way", async () => {
    const dir = freshDir("adhd-cwd-file-");
    const file = join(dir, "not-a-dir.txt");
    writeFileSync(file, "x");
    const task = env.taskStore.create({ sessionId: env.sessionId, prompt: "F", cwd: file });
    await enqueueExistingTask(task.id, env.deps);
    await env.queue.onIdle();
    const after = env.taskStore.read(task.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain(file);
    expect(after.error).toMatch(/is not a directory/);
  });
});
