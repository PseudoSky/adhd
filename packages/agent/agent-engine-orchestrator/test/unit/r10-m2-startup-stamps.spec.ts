/**
 * R10 M2: the dispatching tool (`tools/task.ts`) stamps the two start-up times the engine cannot see, and the
 * engine forwards them in `task:startup`. Driven through the REAL `taskTool` / `enqueueExistingTask`, the REAL
 * `Orchestrator`, real stores on a migrated sqlite and the real `BackgroundQueue`. Only the LLM provider is
 * scripted (the orchestrator wrapper swaps it for a one-reply stub), so the same assertions run for an
 * `anthropic`-type agent and an `openai`-type (OpenAI-compatible / DeepSeek) agent. The per-adapter proof through
 * the real wire adapters and the real tracing sink is `entrypoint/agent-mcp/src/__tests__/r10-m2-startup-stamps.e2e.ts`.
 *
 * Time is virtual where it must be exact: `performance.now` is wrapped with a skew a store wrapper or a queue
 * latch advances, so "session creation took D" and "the task waited D in the queue" are proven with no sleeping.
 *
 *  - R10 M2 AC1: a dispatched child's `task:startup` carries `sessionMs` and `queueWaitMs` as integers >= 0
 *    (sync ephemeral, sync session, background ephemeral, background session, DAG redispatch).
 *  - R10 M2 AC2: both are measured inside the dispatch: their sum never exceeds the dispatch's own wall time.
 *  - R10 M2 AC3: a delayed `sessionStore.create` raises `sessionMs` by at least the delay; a queue that holds the
 *    task raises `queueWaitMs` by at least the hold; an engine fed no stamps leaves the keys ABSENT (not 0).
 *  - R10 M2 AC4: a call with no dispatching parent leaves both absent.
 *  - R10 M2 AC5: the claudecli family takes the same `Orchestrator.run` path (a stamp is forwarded regardless of provider).
 *
 * guards: task:startup carries a wrong, negative or fabricated 0 sessionMs or queueWaitMs (instead of leaving the key absent), the stamps exceed the dispatch's own wall time, a delayed session create or a held queue is not reflected, or a DAG redispatch or a call with no parent is stamped wrongly, for the anthropic or openai family.
 * tier: S (real task tool, orchestrator, stores and BackgroundQueue; only the LLM provider is scripted; virtual time, no sleeping)
 * cites: R10 M2 AC1-AC5 (cited in the docblock and test titles).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, TaskStartupPayload } from "@adhd/agent-base-types";

import { DagEngine } from "../../src/engine/dag-engine.js";
import { HookRegistry } from "../../src/engine/hooks.js";
import { Orchestrator, type OrchestratorRunInput } from "../../src/engine/orchestrator.js";
import { PolicyEngine } from "../../src/engine/policy.js";
import { BackgroundQueue } from "../../src/engine/queue.js";
import type { EngineConfig, EngineLogger } from "../../src/interfaces.js";
import type { LLMProvider } from "../../src/providers/types.js";
import type { AgentStore } from "../../src/tools/agent-crud.js";
import { enqueueExistingTask, taskTool } from "../../src/tools/task.js";
import type { TaskDeps } from "../../src/tools/task.js";
import { generateId } from "../../src/utils/ids.js";
import { nowIso } from "../../src/utils/timestamps.js";
import type { ExecutionContext } from "../../src/validation/index.js";
import { createMigratedSqlite } from "../fixtures/real-schema-db.js";

type Family = "anthropic" | "openai" | "claudecli";
const FAMILIES: Family[] = ["anthropic", "openai", "claudecli"];

const silentLogger: EngineLogger = { info() {}, warn() {}, error() {}, debug() {} } as EngineLogger;

const definitionFor = (family: Family): AgentDefinition =>
  ({
    name: `m2-${family}`,
    version: 1,
    provider: { type: family, model: family === "claudecli" ? "sonnet" : "test-model" },
    systemPrompt: "You are a test agent.",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }) as unknown as AgentDefinition;

const config = (): EngineConfig =>
  ({
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 1 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    getProviderConfig: () => ({ secret: "test-secret", baseURL: "http://localhost:0/v1", model: "test-model" }),
    subprocessEnv: () => ({}),
    isEnvNameAllowed: () => true,
  }) as unknown as EngineConfig;

/** A one-reply provider: the only scripted boundary. */
const scriptedProvider = (): LLMProvider =>
  ({
    chat: async () => ({
      message: { id: generateId(), sessionId: "s", role: "assistant", content: "done", createdAt: nowIso() },
      stopReason: "completed",
    }),
  }) as unknown as LLMProvider;

/** Wall-clock plus a skew that tests advance deterministically (no sleeping). */
let skew = 0;
const realNow = performance.now.bind(performance);
function installVirtualClock(): void {
  skew = 0;
  vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
}

interface IEnv {
  deps: TaskDeps;
  sessionStore: SessionStore;
  taskStore: TaskStore;
  queue: BackgroundQueue;
  startups: Map<string, TaskStartupPayload>;
  /** The `startupStamps` each `Orchestrator.run` call received, by task id. */
  received: Map<string, OrchestratorRunInput["startupStamps"]>;
}

/**
 * @param engine `real` runs the real stamps through; `drop` is the "build that omits the stamp" mutant (the
 * wrapper strips the field before the engine sees it); `zero` is the "stamp 0 instead of omitting" mutant.
 */
function makeEnv(family: Family, engine: "real" | "drop" | "zero" = "real"): IEnv {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite) as any;
  const taskStore = new TaskStore(db);
  const sessionStore = new SessionStore(db);
  const definition = definitionFor(family);
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const queue = new BackgroundQueue(1, silentLogger);
  const hooks = new HookRegistry();
  const startups = new Map<string, TaskStartupPayload>();
  hooks.register("task:startup", (p) => {
    startups.set(p.executionContext.taskId, p);
  });
  const real = new Orchestrator();
  const received: IEnv["received"] = new Map();
  const orchestrator = {
    run: (input: OrchestratorRunInput) => {
      received.set(input.taskId, input.startupStamps);
      const { startupStamps, ...rest } = input;
      const forwarded: OrchestratorRunInput = {
        ...rest,
        provider: scriptedProvider(),
        ...(engine === "real" && startupStamps ? { startupStamps } : {}),
        ...(engine === "zero" && startupStamps ? { startupStamps: { queueWaitMs: 0, sessionMs: 0 } } : {}),
      };
      return real.run(forwarded);
    },
  } as unknown as Orchestrator;
  const depsRef: { value?: TaskDeps } = {};
  const dagEngine = new DagEngine(
    db,
    queue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore as any,
    async (taskId: string) => {
      await enqueueExistingTask(taskId, depsRef.value as TaskDeps);
    },
    silentLogger
  );
  const deps: TaskDeps = {
    agentStore,
    sessionStore: sessionStore as unknown as TaskDeps["sessionStore"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore: taskStore as any,
    orchestrator,
    queue,
    policy: new PolicyEngine({ serverMaxDepth: 10, serverMaxToolLoops: 10 }),
    hooks,
    selfUrl: undefined,
    inProcessDescriptors: [],
    inProcessHandler: async () => {
      throw new Error("no in-process tools registered in this test");
    },
    db,
    dagEngine,
    config: config(),
    logger: silentLogger,
  };
  depsRef.value = deps;
  return { deps, sessionStore, taskStore, queue, startups, received };
}

/** A dispatching parent: a recorded task plus the execution context a delegated call carries. */
function parentContext(env: IEnv, family: Family): ExecutionContext {
  const taskId = generateId();
  const sessionId = env.sessionStore.create({ agentName: `m2-${family}`, agentDefinition: definitionFor(family) }).id;
  env.taskStore.create({ id: taskId, sessionId, prompt: "parent" });
  return {
    taskId,
    sessionId,
    agentName: `m2-${family}`,
    agentDefinition: definitionFor(family),
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
}

const isWholeMs = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;

afterEach(() => {
  vi.restoreAllMocks();
  skew = 0;
});

describe.each(FAMILIES)("R10 M2 [%s]: the dispatching tool stamps sessionMs and queueWaitMs", (family) => {
  it(`R10 M2 AC1 [${family}]: a sync ephemeral child's task:startup carries both as integers >= 0, within the dispatch's own wall time (AC2)`, async () => {
    installVirtualClock();
    const env = makeEnv(family);
    const parent = parentContext(env, family);
    const t0 = performance.now();
    const out = await taskTool({ agent_name: `m2-${family}`, prompt: "go" }, env.deps, parent);
    const wall = performance.now() - t0;
    expect(out.status).toBe("completed");
    const p = env.startups.get(out.task_id);
    expect(isWholeMs(p?.sessionMs), `sessionMs=${p?.sessionMs}`).toBe(true);
    expect(isWholeMs(p?.queueWaitMs), `queueWaitMs=${p?.queueWaitMs}`).toBe(true);
    expect((p?.sessionMs ?? 0) + (p?.queueWaitMs ?? 0)).toBeLessThanOrEqual(wall + 1);
  });

  it(`R10 M2 AC1 [${family}]: a sync session child (session_id) is stamped too`, async () => {
    installVirtualClock();
    const env = makeEnv(family);
    const parent = parentContext(env, family);
    const sessionId = env.sessionStore.create({ agentName: `m2-${family}`, agentDefinition: definitionFor(family) }).id;
    const out = await taskTool({ session_id: sessionId, prompt: "go", background: false }, env.deps, parent);
    expect(out.status).toBe("completed");
    const p = env.startups.get(out.task_id);
    expect(isWholeMs(p?.sessionMs)).toBe(true);
    expect(isWholeMs(p?.queueWaitMs)).toBe(true);
  });

  it(`R10 M2 AC3 [${family}]: a delayed sessionStore.create raises sessionMs by at least the delay (ephemeral path)`, async () => {
    installVirtualClock();
    const DELAY = 5_000;
    const baseline = makeEnv(family);
    const base = await taskTool({ agent_name: `m2-${family}`, prompt: "go" }, baseline.deps, parentContext(baseline, family));
    const baselineMs = baseline.startups.get(base.task_id)?.sessionMs as number;
    expect(baselineMs).toBeLessThan(DELAY);

    const env = makeEnv(family);
    const parent = parentContext(env, family);
    const create = env.sessionStore.create.bind(env.sessionStore);
    vi.spyOn(env.sessionStore, "create").mockImplementation((...args: Parameters<typeof create>) => {
      skew += DELAY; // the "slow create": the virtual clock moves while create is in flight
      return create(...args);
    });
    const out = await taskTool({ agent_name: `m2-${family}`, prompt: "go" }, env.deps, parent);
    const delayed = env.startups.get(out.task_id)?.sessionMs as number;
    expect(delayed).toBeGreaterThanOrEqual(DELAY);
    // Variance fix (qa-variance 2026-10-14): the old `delayed - baselineMs >= DELAY - 1` compared two REAL-time
    // measurements; the baseline run is the cold first run in the process, so a baseline slower than the delayed
    // run by >1 ms (load, JIT) failed it (one same-sha fail in test-metrics.jsonl). The virtual delay is exact, so
    // the stamp must be the delay plus a small real remainder: bound the remainder instead of subtracting a noisy baseline.
    expect(delayed - DELAY, "real remainder beyond the virtual delay").toBeLessThan(DELAY);
  });

  it(`R10 M2 AC3 [${family}]: a delayed session read raises sessionMs by at least the delay (session path)`, async () => {
    installVirtualClock();
    const DELAY = 4_000;
    const env = makeEnv(family);
    const parent = parentContext(env, family);
    const sessionId = env.sessionStore.create({ agentName: `m2-${family}`, agentDefinition: definitionFor(family) }).id;
    const read = env.sessionStore.read.bind(env.sessionStore);
    vi.spyOn(env.sessionStore, "read").mockImplementation((id: string) => {
      skew += DELAY;
      return read(id);
    });
    const out = await taskTool({ session_id: sessionId, prompt: "go", background: false }, env.deps, parent);
    expect(env.startups.get(out.task_id)?.sessionMs as number).toBeGreaterThanOrEqual(DELAY);
  });

  it(`R10 M2 AC3 [${family}]: a background child held in the queue reports at least the hold as queueWaitMs (ephemeral and session)`, async () => {
    installVirtualClock();
    const HOLD = 3_000;
    const env = makeEnv(family);
    const parent = parentContext(env, family);
    const sessionId = env.sessionStore.create({ agentName: `m2-${family}`, agentDefinition: definitionFor(family) }).id;

    // concurrency is 1: this blocker occupies the only slot until the latch is released
    let release!: () => void;
    const latch = new Promise<void>((r) => (release = r));
    env.queue.enqueue("blocker", () => latch);

    const eph = await taskTool({ agent_name: `m2-${family}`, prompt: "go", background: true }, env.deps, parent);
    const ses = await taskTool({ session_id: sessionId, prompt: "go", background: true }, env.deps, parent);
    expect(env.startups.size, "neither child started while the slot is held").toBe(0);
    skew += HOLD; // time passes while they wait
    release();
    await env.queue.onIdle();

    for (const id of [eph.task_id, ses.task_id]) {
      const q = env.startups.get(id)?.queueWaitMs as number;
      expect(q, id).toBeGreaterThanOrEqual(HOLD);
      expect(Number.isInteger(q)).toBe(true);
    }
  });

  it(`R10 M2 AC1/AC4 [${family}]: a DAG redispatch (enqueueExistingTask) is stamped when its row has a parent, and absent when it has none`, async () => {
    installVirtualClock();
    const env = makeEnv(family);
    const parent = parentContext(env, family);
    const sessionId = env.sessionStore.create({ agentName: `m2-${family}`, agentDefinition: definitionFor(family) }).id;
    const withParent = generateId();
    const orphan = generateId();
    env.taskStore.create({ id: withParent, sessionId, prompt: "child", parentTaskId: parent.taskId });
    env.taskStore.create({ id: orphan, sessionId, prompt: "no parent" });
    await enqueueExistingTask(withParent, env.deps);
    await enqueueExistingTask(orphan, env.deps);
    await env.queue.onIdle();

    const stamped = env.startups.get(withParent);
    expect(isWholeMs(stamped?.sessionMs)).toBe(true);
    expect(isWholeMs(stamped?.queueWaitMs)).toBe(true);
    const bare = env.startups.get(orphan);
    expect(bare, "the orphan really started").toBeDefined();
    expect("sessionMs" in (bare ?? {})).toBe(false);
    expect("queueWaitMs" in (bare ?? {})).toBe(false);
  });

  it(`R10 M2 AC4 [${family}]: a direct call with no dispatching parent leaves both keys absent (ephemeral and session)`, async () => {
    installVirtualClock();
    const env = makeEnv(family);
    const sessionId = env.sessionStore.create({ agentName: `m2-${family}`, agentDefinition: definitionFor(family) }).id;
    const eph = await taskTool({ agent_name: `m2-${family}`, prompt: "go" }, env.deps);
    const ses = await taskTool({ session_id: sessionId, prompt: "go", background: false }, env.deps);
    for (const id of [eph.task_id, ses.task_id]) {
      const p = env.startups.get(id);
      expect(p, "the task really started").toBeDefined();
      expect("sessionMs" in (p ?? {}), "sessionMs key").toBe(false);
      expect("queueWaitMs" in (p ?? {}), "queueWaitMs key").toBe(false);
      expect(env.received.get(id), "run() was handed no stamps").toBeUndefined();
    }
  });

  it(`R10 M2 AC3 [${family}] mutants: a build that drops the stamp leaves the keys absent (not 0); a build that stamps 0 is caught by the delay test`, async () => {
    installVirtualClock();
    const dropped = makeEnv(family, "drop");
    const out = await taskTool({ agent_name: `m2-${family}`, prompt: "go" }, dropped.deps, parentContext(dropped, family));
    const p = dropped.startups.get(out.task_id);
    expect("sessionMs" in (p ?? {})).toBe(false);
    expect("queueWaitMs" in (p ?? {})).toBe(false);

    // the zero mutant satisfies "integer >= 0" but not "raised by the delay": the AC3 delay assertion is what has teeth
    const zero = makeEnv(family, "zero");
    const parent = parentContext(zero, family);
    const create = zero.sessionStore.create.bind(zero.sessionStore);
    vi.spyOn(zero.sessionStore, "create").mockImplementation((...args: Parameters<typeof create>) => {
      skew += 5_000;
      return create(...args);
    });
    const z = await taskTool({ agent_name: `m2-${family}`, prompt: "go" }, zero.deps, parent);
    expect(zero.startups.get(z.task_id)?.sessionMs).toBe(0);
    expect(zero.startups.get(z.task_id)?.sessionMs as number).toBeLessThan(5_000);
  });
});

describe("R10 M2 AC5: claudecli takes the same run path", () => {
  it("R10 M2 AC5: a claudecli-typed child gets the same stamps from the same Orchestrator.run call (the bridge's `task` call lands in taskTool with a callerContext)", async () => {
    installVirtualClock();
    const env = makeEnv("claudecli");
    const out = await taskTool({ agent_name: "m2-claudecli", prompt: "go" }, env.deps, parentContext(env, "claudecli"));
    const stamps = env.received.get(out.task_id);
    expect(stamps && isWholeMs(stamps.sessionMs) && isWholeMs(stamps.queueWaitMs)).toBe(true);
  });
});
