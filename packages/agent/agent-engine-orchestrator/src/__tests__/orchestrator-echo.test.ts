/**
 * R9-hist S5a -- orchestrator side of provider-echo fidelity (spec-v2 sections 1, 2, 6: AC10, AC14-AC20).
 *
 * What is real: the Orchestrator, `taskTool` / `enqueueExistingTask`, HookRegistry, the sanitize-style veto
 * handlers, the SessionStore / TaskStore on an on-disk better-sqlite3 file built through the SHIPPED migrations
 * (entrypoint/agent-mcp/drizzle, incl. 0017), reopened on a fresh connection wherever persistence is claimed.
 * What is scripted: only the LLM provider (a fake honouring the S0 contract: `echoes`, `beforeContinuation`,
 * `echo`, `echoDegraded`, `echoReplay`). No network, no real provider call, no sleep: time is an injected
 * clock (`vi.useFakeTimers({ toFake: ['Date'] })`, so message timestamps and `config.now` agree).
 *
 * Every test title cites `R9-hist S5a AC<n>`; the numbers follow the task's acceptance list:
 *   AC1 load+replay, AC2 store+reopen, AC3 sticky veto, AC4 failure isolation, AC5 degrade, AC6 pause,
 *   AC7 compaction, AC8 metrics, AC9 privacy.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, HookEvent, HookEventMap, IProviderEcho } from "@adhd/agent-base-types";

import { Orchestrator, resetEchoFailureWarningForTests } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { PolicyEngine } from "../engine/policy.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import { decideCompaction } from "../engine/context-window.js";
import { buildModelResponsePayload, sourceFromResponse } from "../engine/model-response-payload.js";
import { enqueueExistingTask, loadSessionEchoes, taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import type { SessionStoreForTool } from "../tools/session.js";
import { usageQueryByGrain } from "../tools/usage.js";
import { PauseTurnCapError } from "../providers/anthropic-pause.js";
import type { EchoCaps } from "../providers/anthropic-echo.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { ToolError } from "../validation/errors.js";
import type { Message } from "../validation/index.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { REAL_MIGRATIONS_FOLDER } from "./fixtures/real-schema-db.js";

// taskTool builds its provider through this seam; the scripted fake is the ONLY thing substituted.
const hoisted = vi.hoisted(() => ({ provider: undefined as LLMProvider | undefined }));
vi.mock("../providers/construct.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/construct.js")>();
  return { ...actual, buildProviderForSelection: () => hoisted.provider };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-engine-orchestrator");

// ── Fake clock ─────────────────────────────────────────────────────────────────────────────────────────────────
const NOW0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const TTL = 10 * MIN;
const setMinute = (m: number): void => {
  vi.setSystemTime(new Date(NOW0 + m * MIN));
};

const CAPS: EchoCaps = { maxMessageBytes: 131_072, maxSessionBytes: 4_194_304, serverResultTtlMs: TTL };

// ── Echo fixtures: every sentinel is a string that must NEVER appear outside the echo table ─────────────────────
const SIG = "SIGSENTINEL" + "Q".repeat(60);
const PAGE = "PAGE-BODY-SENTINEL-third-party-text";
const ENC = "ENCSENTINEL" + "Z".repeat(60);
const THINKING = { type: "thinking", thinking: "weigh the page", signature: SIG };
const TEXT = { type: "text", text: "fetching" };
const SERVER_USE = { type: "server_tool_use", id: "srvtoolu_1", name: "web_fetch", input: { url: "https://example.test" } };
const SERVER_RESULT = {
  type: "web_fetch_tool_result",
  tool_use_id: "srvtoolu_1",
  content: { type: "web_fetch_result", url: "https://example.test", text: PAGE },
};
const SEARCH_USE = { type: "server_tool_use", id: "srvtoolu_2", name: "web_search", input: { query: "q" } };
const SEARCH_RESULT = {
  type: "web_search_tool_result",
  tool_use_id: "srvtoolu_2",
  content: [{ type: "web_search_result", url: "https://example.test/s", title: "t", encrypted_content: ENC }],
};
const echoOf = (blocks: Array<Record<string, unknown>>): IProviderEcho => ({ provider: "anthropic", model: "claude-haiku-5-5", blocks });
const MIXED = echoOf([THINKING, SERVER_USE, SERVER_RESULT, SEARCH_USE, SEARCH_RESULT, TEXT]);
const T_TYPES = ["thinking", "text"];
const S_TYPES = ["server_tool_use", "web_fetch_tool_result", "web_search_tool_result"];
const typesOf = (echo: { blocks: ReadonlyArray<Record<string, unknown>> } | undefined): string[] =>
  (echo?.blocks ?? []).map((b) => String(b["type"]));

// ── The scripted provider (S0 contract) ─────────────────────────────────────────────────────────────────────────
interface ICall {
  req: ProviderChatRequest;
  /** Snapshot of `req.echoes` taken AT call time (the engine may mutate its own map afterwards). */
  echoes: Map<string, IProviderEcho> | undefined;
  hasBeforeContinuation: boolean;
  isSummariser: boolean;
}
type Step = (call: ICall) => ProviderChatResponse | Promise<ProviderChatResponse>;

class ScriptedProvider implements LLMProvider {
  readonly calls: ICall[] = [];
  /** Non-summariser calls only. */
  get mainCalls(): ICall[] {
    return this.calls.filter((c) => !c.isSummariser);
  }
  private index = 0;
  constructor(private readonly script: Step[]) {}
  async chat(req: ProviderChatRequest): Promise<ProviderChatResponse> {
    const isSummariser = req.messages[0]?.content?.startsWith("Summarise the following conversation") === true;
    const call: ICall = {
      req,
      echoes: req.echoes === undefined ? undefined : new Map(req.echoes),
      hasBeforeContinuation: req.beforeContinuation !== undefined,
      isSummariser,
    };
    this.calls.push(call);
    if (isSummariser) {
      return { message: msg("assistant", "summary"), stopReason: "completed", usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (step === undefined) throw new Error("ScriptedProvider has an empty script");
    return step(call);
  }
}

function msg(role: Message["role"], content: string): Message {
  return { id: generateId(), sessionId: "s", role, content, createdAt: nowIso() };
}

interface ITurn {
  content?: string;
  tool?: boolean;
  echo?: IProviderEcho;
  echoDegraded?: { apiMessage: string; echoedMessages: number };
  echoReplay?: { messages: number; bytes: number };
  inputTokens?: number;
  modelCalls?: number;
}
function turn(t: ITurn = {}): Step {
  return () => ({
    message: {
      id: generateId(),
      sessionId: "s",
      role: "assistant",
      ...(t.tool === true
        ? { toolCalls: [{ id: generateId(), server: "s", tool: "echo", arguments: {} }] }
        : { content: t.content ?? "done" }),
      createdAt: nowIso(),
    },
    stopReason: t.tool === true ? "tool_calls" : "completed",
    usage: { inputTokens: t.inputTokens ?? 10, outputTokens: 1, uncachedInputTokens: t.inputTokens ?? 10 },
    ...(t.echo !== undefined ? { echo: t.echo } : {}),
    ...(t.echoDegraded !== undefined ? { echoDegraded: t.echoDegraded } : {}),
    ...(t.echoReplay !== undefined ? { echoReplay: t.echoReplay } : {}),
    ...(t.modelCalls !== undefined ? { reportedModelCalls: t.modelCalls } : {}),
  });
}

// ── Recording hooks / logger ────────────────────────────────────────────────────────────────────────────────────
class RecordingHooks extends HookRegistry {
  readonly emitted: Array<{ event: string; json: string }> = [];
  override async emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
    let json: string;
    try {
      json = JSON.stringify(payload);
    } catch {
      json = "[unserialisable]";
    }
    this.emitted.push({ event, json });
    return super.emit(event, payload);
  }
  count(event: string): number {
    return this.emitted.filter((e) => e.event === event).length;
  }
}

interface ILog {
  level: string;
  json: string;
}
function recordingLogger(): { logger: EngineLogger; logs: ILog[]; warnsAbout: (needle: string) => number } {
  const logs: ILog[] = [];
  const rec =
    (level: string) =>
    (...args: unknown[]): void => {
      let json: string;
      try {
        json = JSON.stringify(args);
      } catch {
        json = "[unserialisable]";
      }
      logs.push({ level, json });
    };
  return {
    logger: { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } as EngineLogger,
    logs,
    warnsAbout: (needle) => logs.filter((l) => l.level === "warn" && l.json.includes(needle)).length,
  };
}
const ECHO_WARN = "provider echo persistence failed";

// ── Environment ─────────────────────────────────────────────────────────────────────────────────────────────────
function agentDef(): AgentDefinition {
  return {
    name: "echo-agent",
    version: 1,
    provider: { type: "openai", model: "gpt-4o-mini" } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function engineConfig(echo: EchoCaps | undefined): EngineConfig {
  return {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 5 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    getProviderConfig: () => ({ secret: "test-secret", baseURL: "http://localhost:0/v1", model: "gpt-4o-mini" }),
    subprocessEnv: () => ({}),
    isEnvNameAllowed: () => true,
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
    ...(echo !== undefined ? { echo } : {}),
    now: () => Date.now(),
  };
}

function openMigrated(file: string): Database.Database {
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = OFF");
  migrate(drizzle(sqlite), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  return sqlite;
}

interface IEnv {
  file: string;
  sqlite: Database.Database;
  store: SessionStore;
  taskStore: TaskStore;
  hooks: RecordingHooks;
  deps: TaskDeps;
  sessionId: string;
  log: ReturnType<typeof recordingLogger>;
  queue: BackgroundQueue;
}

let scratch: string;
const openConns: Database.Database[] = [];

function makeEnv(opts: { echo?: EchoCaps | null; hooks?: RecordingHooks } = {}): IEnv {
  const file = join(scratch, `db-${openConns.length}.sqlite`);
  const sqlite = openMigrated(file);
  openConns.push(sqlite);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const hooks = opts.hooks ?? new RecordingHooks();
  const store = new SessionStore(db, hooks);
  const taskStore = new TaskStore(db);
  const definition = agentDef();
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const log = recordingLogger();
  const queue = new BackgroundQueue(5, log.logger);
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: 5 });
  const depsRef: { value?: TaskDeps } = {};
  const dagEngine = new DagEngine(db, queue, taskStore as never, async (taskId: string) => {
    if (!depsRef.value) throw new Error("dispatchFn before init");
    await enqueueExistingTask(taskId, depsRef.value);
  }, log.logger);
  const deps: TaskDeps = {
    agentStore,
    sessionStore: store as unknown as SessionStoreForTool,
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
    config: engineConfig(opts.echo === null ? undefined : opts.echo ?? CAPS),
    logger: log.logger,
  };
  depsRef.value = deps;
  const sessionId = store.create({ agentName: definition.name, agentDefinition: definition }).id;
  return { file, sqlite, store, taskStore, hooks, deps, sessionId, log, queue };
}

const runTask = (env: IEnv, prompt: string) => taskTool({ session_id: env.sessionId, prompt, background: false }, env.deps);

const echoRows = (conn: Database.Database) =>
  conn.prepare("SELECT message_id, session_id, blocks, bytes, server_bytes FROM message_provider_echo ORDER BY created_at, message_id").all() as Array<{
    message_id: string;
    session_id: string;
    blocks: string;
    bytes: number;
    server_bytes: number;
  }>;
const assistantIds = (env: IEnv): string[] => env.store.getMessages(env.sessionId).filter((m) => m.role === "assistant").map((m) => m.id);
const taskEvents = (conn: Database.Database, type?: string) =>
  (conn.prepare("SELECT task_id, type, payload FROM task_events ORDER BY created_at, rowid").all() as Array<{ task_id: string; type: string; payload: string | null }>)
    .filter((e) => type === undefined || e.type === type)
    .map((e) => ({ ...e, parsed: e.payload ? (JSON.parse(e.payload) as Record<string, unknown>) : {} }));

// ── Direct orchestrator runs (tool loops, compaction, pause) ────────────────────────────────────────────────────
const toolRegistry = {
  listAllTools: async () => [{ name: "s__echo", description: "", inputSchema: { type: "object", properties: {} } }],
  getClient: async () => ({ callTool: async () => "ok" }),
  closeAll: async () => undefined,
} as unknown as McpClientRegistry;

interface IDirectRun {
  taskId: string;
  status: string;
  error: string | undefined;
  thrown: unknown;
}

async function runDirect(
  env: IEnv,
  provider: LLMProvider,
  extra: {
    messages?: Message[];
    echoes?: ReadonlyMap<string, IProviderEcho>;
    signal?: AbortSignal;
    sessionStore?: OrchestratorSessionStore;
    config?: EngineConfig;
  } = {}
): Promise<IDirectRun> {
  const taskId = generateId();
  env.taskStore.create({ sessionId: env.sessionId, prompt: "p", id: taskId });
  const executionContext = {
    taskId,
    sessionId: env.sessionId,
    agentName: "echo-agent",
    agentDefinition: agentDef(),
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const user: Message = { id: generateId(), sessionId: env.sessionId, role: "user", content: "go", createdAt: nowIso() };
  let thrown: unknown;
  try {
    await new Orchestrator().run({
      executionContext,
      messages: extra.messages ?? [user],
      registry: toolRegistry,
      provider,
      policy: { check: () => undefined } as unknown as PolicyEngine,
      taskStore: env.taskStore as unknown as OrchestratorTaskStore,
      sessionStore: extra.sessionStore ?? (env.store as unknown as OrchestratorSessionStore),
      signal: extra.signal ?? new AbortController().signal,
      taskId,
      hooks: env.hooks,
      logger: env.log.logger,
      config: extra.config ?? env.deps.config,
      ...(extra.echoes !== undefined ? { echoes: extra.echoes } : {}),
    });
  } catch (err) {
    thrown = err;
  }
  const row = env.taskStore.read(taskId);
  return { taskId, status: row.status, error: row.error, thrown };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setMinute(0);
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "echo-"));
  resetEchoFailureWarningForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  hoisted.provider = undefined;
  for (const c of openConns.splice(0)) if (c.open) c.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC1: load and replay across tasks", () => {
  it("R9-hist S5a AC1: the second task in a session gets request.echoes for the prior assistant message, both tiers, within the TTL", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" })]);
    hoisted.provider = provider;

    expect((await runTask(env, "first")).status).toBe("completed");
    setMinute(5);
    expect((await runTask(env, "second")).status).toBe("completed");

    expect(provider.calls[0]?.echoes).toBeUndefined();
    expect("echoes" in (provider.calls[0]?.req ?? {})).toBe(false); // no echo => the request is exactly what it was
    const [firstAssistant] = assistantIds(env);
    const replayed = provider.calls[1]?.echoes;
    expect([...(replayed?.keys() ?? [])]).toEqual([firstAssistant]);
    expect(replayed?.get(firstAssistant as string)).toEqual(MIXED);
  });

  it("R9-hist S5a AC1: past the TTL only tier T is replayed (tier S stripped at read; the sweeper is not needed)", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" })]);
    hoisted.provider = provider;
    await runTask(env, "first");
    // Neutralise the sweeper: correctness must come from the read-time strip alone.
    const sweep = vi.spyOn(env.store, "sweepEchoes").mockReturnValue({ stripped: 0, orphansDeleted: 0, corruptDeleted: 0 });
    setMinute(11);
    await runTask(env, "second");

    expect(sweep).toHaveBeenCalled(); // it ran (and did nothing) - the strip below is the reader's
    const replayed = provider.calls[1]?.echoes?.get(assistantIds(env)[0] as string);
    expect(typesOf(replayed)).toEqual(["thinking", "text"]);
    expect(echoRows(env.sqlite)[0]?.server_bytes).toBeGreaterThan(0); // still in the table, merely not replayed
  });

  it("R9-hist S5a AC1: a session with an old row but recent activity (tasks at minute 0, 9, 15) keeps the minute-0 tier S", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" }), turn({ content: "three" })]);
    hoisted.provider = provider;
    await runTask(env, "first");
    setMinute(9);
    await runTask(env, "second");
    setMinute(15);
    await runTask(env, "third");

    const replayed = provider.calls[2]?.echoes?.get(assistantIds(env)[0] as string);
    expect(typesOf(replayed)).toEqual(typesOf(MIXED)); // the 9-minute task refreshed the session, so S is intact
  });

  it("R9-hist S5a AC1: serverResultTtlMs 0 never persists tier S (tier T still does)", async () => {
    const env = makeEnv({ echo: { ...CAPS, serverResultTtlMs: 0 } });
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" })]);
    hoisted.provider = provider;
    await runTask(env, "first");
    await runTask(env, "second");

    expect(echoRows(env.sqlite)).toHaveLength(1);
    expect(echoRows(env.sqlite)[0]?.server_bytes).toBe(0);
    expect(typesOf(provider.calls[1]?.echoes?.get(assistantIds(env)[0] as string))).toEqual(["thinking", "text"]);
  });

  it("R9-hist S5a AC1: only the assistant ids of the loaded history are requested, with a numeric idle time", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" })]);
    hoisted.provider = provider;
    await runTask(env, "first");
    const get = vi.spyOn(env.store, "getMessageEchoes");
    setMinute(3);
    await runTask(env, "second");

    expect(get).toHaveBeenCalledTimes(1);
    const [sid, ids, idleMs, ttlMs] = get.mock.calls[0] ?? [];
    expect(sid).toBe(env.sessionId);
    expect(ids).toEqual(assistantIds(env).slice(0, 1)); // not the user/system ids, not "all of the session"
    expect(idleMs).toBe(3 * MIN);
    expect(ttlMs).toBe(TTL);
  });

  it("R9-hist S5a AC1: the resume path (enqueueExistingTask) loads and passes echoes too", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "resumed" })]);
    hoisted.provider = provider;
    await runTask(env, "first");
    setMinute(2);
    const pending = env.taskStore.create({ sessionId: env.sessionId, prompt: "later" });
    await enqueueExistingTask(pending.id, env.deps);
    await env.queue.onIdle();

    expect(env.taskStore.read(pending.id).status).toBe("completed");
    expect(typesOf(provider.calls[1]?.echoes?.get(assistantIds(env)[0] as string))).toEqual(typesOf(MIXED));
  });

  it("R9-hist S5a AC1: without echo caps (EngineConfig.echo absent) nothing is loaded or persisted and requests carry no echoes", async () => {
    const env = makeEnv({ echo: null });
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" })]);
    hoisted.provider = provider;
    const get = vi.spyOn(env.store, "getMessageEchoes");
    await runTask(env, "first");
    await runTask(env, "second");

    expect(get).not.toHaveBeenCalled();
    expect(echoRows(env.sqlite)).toHaveLength(0);
    expect("echoes" in (provider.calls[1]?.req ?? {})).toBe(false);
  });

  it("R9-hist S5a AC1: the live run replays the full echo to itself within the task (tool loop), uncapped", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([turn({ tool: true, echo: MIXED }), turn({ content: "done" })]);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("completed");
    const [, second] = provider.mainCalls;
    expect([...(second?.echoes?.values() ?? [])]).toEqual([MIXED]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC2: store and reopen", () => {
  it("R9-hist S5a AC2: the persisted echo survives reopening the database file on a new connection", async () => {
    const env = makeEnv();
    hoisted.provider = new ScriptedProvider([turn({ content: "one", echo: MIXED })]);
    await runTask(env, "first");
    const [assistantId] = assistantIds(env);
    env.sqlite.close();

    const fresh = openMigrated(env.file);
    openConns.push(fresh);
    const reopened = new SessionStore(drizzle(fresh, { schema }) as never);
    const got = reopened.getMessageEchoes(env.sessionId, [assistantId as string], 1 * MIN, TTL);
    expect(got.get(assistantId as string)).toEqual(MIXED);
    expect(reopened.getEchoSessionServerBytes(env.sessionId)).toBeGreaterThan(0);
  });

  it("R9-hist S5a AC2: the key is the persisted assistant Message.id and the row carries its byte accounting", async () => {
    const env = makeEnv();
    hoisted.provider = new ScriptedProvider([turn({ content: "one", echo: MIXED })]);
    await runTask(env, "first");
    const [row] = echoRows(env.sqlite);
    expect(row?.message_id).toBe(assistantIds(env)[0]);
    expect(row?.session_id).toBe(env.sessionId);
    expect(row?.bytes).toBe(Buffer.byteLength(row?.blocks ?? ""));
    expect(row?.server_bytes).toBeGreaterThan(0);
    expect(row?.server_bytes).toBeLessThan(row?.bytes ?? 0);
  });

  it("R9-hist S5a AC2: a tier S pair over maxMessageBytes is dropped whole, tier T persists, the in-run replay keeps it", async () => {
    const env = makeEnv({ echo: { ...CAPS, maxMessageBytes: 400 } });
    const provider = new ScriptedProvider([turn({ tool: true, echo: MIXED }), turn({ content: "done" })]);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("completed");
    const types = echoRows(env.sqlite).map((r) => (JSON.parse(r.blocks) as Array<{ type: string }>).map((b) => b.type));
    expect(types).toHaveLength(1);
    expect(types[0]?.some((t) => S_TYPES.includes(t))).toBe(false);
    expect(types[0]).toEqual(expect.arrayContaining(T_TYPES));
    expect(typesOf(provider.mainCalls[1]?.echoes?.values().next().value as IProviderEcho)).toEqual(typesOf(MIXED));
  });

  it("R9-hist S5a AC2: once the session tier S cap is reached new tier S is dropped and tier T still persists, with no error", async () => {
    const env = makeEnv({ echo: { ...CAPS, maxSessionBytes: 1 } });
    const provider = new ScriptedProvider([turn({ tool: true, echo: MIXED }), turn({ content: "done", echo: MIXED })]);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("completed");
    const rows = echoRows(env.sqlite);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.server_bytes === 0)).toBe(true);
    expect(rows.every((r) => typesOf({ blocks: JSON.parse(r.blocks) }).includes("thinking"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC3: the server-result persistence veto is sticky", () => {
  const persistedTypes = (env: IEnv): string[] =>
    echoRows(env.sqlite).flatMap((r) => (JSON.parse(r.blocks) as Array<{ type: string }>).map((b) => b.type));
  const veto = (value: boolean) => (p: { persist: boolean }) => {
    p.persist = value;
  };

  it("R9-hist S5a AC3: two handlers (first false, second true) => tier S is NOT written", async () => {
    const env = makeEnv();
    env.hooks.register("transform:server_result_persist", veto(false));
    env.hooks.register("transform:server_result_persist", veto(true));
    const run = await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));

    expect(run.status).toBe("completed");
    const types = persistedTypes(env);
    expect(types.filter((t) => S_TYPES.includes(t))).toEqual([]);
    expect(types).toEqual(expect.arrayContaining(T_TYPES));
    expect(echoRows(env.sqlite)[0]?.server_bytes).toBe(0);
  });

  it("R9-hist S5a AC3: a late handler can neither undo the veto by assigning true nor by Object.assign", async () => {
    const env = makeEnv();
    env.hooks.register("transform:server_result_persist", veto(false));
    env.hooks.register("transform:server_result_persist", (p) => {
      Object.assign(p, { persist: true });
    });
    await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));
    expect(persistedTypes(env).filter((t) => S_TYPES.includes(t))).toEqual([]);
  });

  it("R9-hist S5a AC3: handlers (true, false) => vetoed as well (order does not matter)", async () => {
    const env = makeEnv();
    env.hooks.register("transform:server_result_persist", veto(true));
    env.hooks.register("transform:server_result_persist", veto(false));
    await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));
    expect(persistedTypes(env).filter((t) => S_TYPES.includes(t))).toEqual([]);
  });

  it("R9-hist S5a AC3: only-true handlers => tier S is written", async () => {
    const env = makeEnv();
    env.hooks.register("transform:server_result_persist", veto(true));
    await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));
    expect(persistedTypes(env)).toEqual(typesOf(MIXED));
  });

  it("R9-hist S5a AC3: no handler => tier S is written, and the hook payload names the session, agent and tier S bytes", async () => {
    const env = makeEnv();
    await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));
    expect(persistedTypes(env)).toEqual(typesOf(MIXED));
    const emitted = env.hooks.emitted.filter((e) => e.event === "transform:server_result_persist");
    expect(emitted).toHaveLength(1);
    const payload = JSON.parse(emitted[0]?.json ?? "{}") as Record<string, unknown>;
    expect(payload["sessionId"]).toBe(env.sessionId);
    expect(payload["agentName"]).toBe("echo-agent");
    expect(payload["serverBytes"]).toBe(echoRows(env.sqlite)[0]?.server_bytes);
    expect(payload["persist"]).toBe(true);
  });

  it("R9-hist S5a AC3: an echo with no tier S does not emit the hook at all", async () => {
    const env = makeEnv();
    await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: echoOf([THINKING, TEXT]) })]));
    expect(env.hooks.count("transform:server_result_persist")).toBe(0);
    expect(echoRows(env.sqlite)).toHaveLength(1);
  });

  it("R9-hist S5a AC3: when vetoed the in-run replay still happens (the veto is about persistence only)", async () => {
    const env = makeEnv();
    env.hooks.register("transform:server_result_persist", veto(false));
    const provider = new ScriptedProvider([turn({ tool: true, echo: MIXED }), turn({ content: "done" })]);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("completed");
    expect(typesOf(provider.mainCalls[1]?.echoes?.values().next().value as IProviderEcho)).toEqual(typesOf(MIXED));
    expect(persistedTypes(env).filter((t) => S_TYPES.includes(t))).toEqual([]);
  });

  it("R9-hist S5a AC3: a throwing hook registry fails closed (tier S not written, tier T written, task completes)", async () => {
    class ThrowingHooks extends RecordingHooks {
      override async emit<E extends HookEvent>(event: E, payload: HookEventMap[E]): Promise<void> {
        if (event === "transform:server_result_persist") throw new Error("registry exploded");
        return super.emit(event, payload);
      }
    }
    const env = makeEnv({ hooks: new ThrowingHooks() });
    const run = await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));
    expect(run.status).toBe("completed");
    expect(persistedTypes(env).filter((t) => S_TYPES.includes(t))).toEqual([]);
    expect(persistedTypes(env)).toEqual(expect.arrayContaining(T_TYPES));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC4: echo storage failures never fail a task", () => {
  interface IThrowingStoreOpts {
    append?: () => never;
    bytes?: () => never;
    get?: () => never;
    sweep?: () => never;
  }
  /** A real SessionStore whose echo members throw as a broken backend would. */
  function brokenStore(env: IEnv, opts: IThrowingStoreOpts): void {
    if (opts.append) vi.spyOn(env.store, "appendMessageEcho").mockImplementation(opts.append);
    if (opts.bytes) vi.spyOn(env.store, "getEchoSessionServerBytes").mockImplementation(opts.bytes);
    if (opts.get) vi.spyOn(env.store, "getMessageEchoes").mockImplementation(opts.get);
    if (opts.sweep) vi.spyOn(env.store, "sweepEchoes").mockImplementation(opts.sweep);
  }
  const sqliteError = (message: string, code: string): never => {
    throw Object.assign(new Error(message), { code });
  };
  const failureModes: Array<[string, () => never]> = [
    ["missing table", () => sqliteError("no such table: message_provider_echo", "SQLITE_ERROR")],
    ["locked database", () => sqliteError("database is locked", "SQLITE_BUSY")],
    [
      "corrupt blocks JSON",
      () => {
        JSON.parse(`{"blocks": ${PAGE} not json`); // a real SyntaxError whose message quotes the input text
        throw new Error("unreachable");
      },
    ],
  ];

  for (const [name, fail] of failureModes) {
    it(`R9-hist S5a AC4: ${name} on append/read/sweep/bytes => both tasks complete, exactly one WARN across tasks, legacy history`, async () => {
      const env = makeEnv();
      brokenStore(env, { append: fail, bytes: fail, get: fail, sweep: fail });
      const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two", echo: MIXED }), turn({ content: "three" })]);
      hoisted.provider = provider;

      const results = [await runTask(env, "a"), await runTask(env, "b"), await runTask(env, "c")];

      expect(results.map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
      expect(env.log.warnsAbout(ECHO_WARN)).toBe(1);
      expect(provider.calls.every((c) => c.echoes === undefined)).toBe(true); // legacy history throughout
      // The WARN names the operation and error class, never the (possibly page-quoting) message.
      const warn = env.log.logs.find((l) => l.level === "warn" && l.json.includes(ECHO_WARN));
      expect(warn?.json).not.toContain(PAGE);
      expect(warn?.json).not.toContain("no such table");
    });
  }

  it("R9-hist S5a AC4: a failing append inside a tool loop does not break the loop; later messages still persist nothing", async () => {
    const env = makeEnv();
    brokenStore(env, { append: () => sqliteError("database is locked", "SQLITE_BUSY") });
    const provider = new ScriptedProvider([turn({ tool: true, echo: MIXED }), turn({ content: "done", echo: MIXED })]);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("completed");
    expect(env.log.warnsAbout(ECHO_WARN)).toBe(1);
    // The live run still replays its own echo even though nothing could be stored.
    expect(provider.mainCalls[1]?.echoes?.size).toBe(1);
  });

  it("R9-hist S5a AC4: real store, echo table dropped => tasks complete on legacy history and one echo WARN in total", async () => {
    vi.resetModules();
    const fresh = await vi.importActual<typeof schema>("@adhd/agent-store-runtime"); // a fresh module instance has a fresh once-flag
    const env = makeEnv();
    const storeWarn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = new fresh.SessionStore(drizzle(env.sqlite, { schema }) as never);
    env.deps.sessionStore = store as unknown as SessionStoreForTool;
    env.sqlite.exec("DROP TABLE message_provider_echo");
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two", echo: MIXED }), turn({ content: "three" })]);
    hoisted.provider = provider;

    const statuses = [(await runTask(env, "a")).status, (await runTask(env, "b")).status, (await runTask(env, "c")).status];
    expect(statuses).toEqual(["completed", "completed", "completed"]);
    expect(provider.calls.every((c) => c.echoes === undefined)).toBe(true);
    const echoWarns = storeWarn.mock.calls.filter((c) => String(c[0]).includes(ECHO_WARN)).length + env.log.warnsAbout(ECHO_WARN);
    expect(echoWarns).toBe(1);
  });

  it("R9-hist S5a AC4: real store, corrupt blocks JSON in the table => the next task completes without that echo, one WARN, no page text in it", async () => {
    vi.resetModules();
    const fresh = await vi.importActual<typeof schema>("@adhd/agent-store-runtime");
    const env = makeEnv();
    const storeWarn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    env.deps.sessionStore = new fresh.SessionStore(drizzle(env.sqlite, { schema }) as never) as unknown as SessionStoreForTool;
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" }), turn({ content: "three" })]);
    hoisted.provider = provider;
    await runTask(env, "a");
    env.sqlite.prepare("UPDATE message_provider_echo SET blocks = ?").run(`{not json ${PAGE}`);

    expect((await runTask(env, "b")).status).toBe("completed");
    expect((await runTask(env, "c")).status).toBe("completed");
    expect(provider.calls[1]?.echoes).toBeUndefined();
    const warns = storeWarn.mock.calls.filter((c) => String(c[0]).includes(ECHO_WARN));
    expect(warns).toHaveLength(1);
    expect(String(warns[0]?.[0])).not.toContain(PAGE);
  });

  it("R9-hist S5a AC4: real store held by another connection (BEGIN EXCLUSIVE) => loading echoes yields none, one WARN, and the task then completes", async () => {
    vi.resetModules();
    const fresh = await vi.importActual<typeof schema>("@adhd/agent-store-runtime");
    const env = makeEnv();
    const storeWarn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // timeout 0: SQLITE_BUSY immediately, so the test never waits on the wall clock.
    const reader = new Database(env.file, { timeout: 0 });
    openConns.push(reader);
    const store = new fresh.SessionStore(drizzle(reader, { schema }) as never);
    env.deps.sessionStore = store as unknown as SessionStoreForTool;
    const provider = new ScriptedProvider([turn({ content: "one", echo: MIXED }), turn({ content: "two" })]);
    hoisted.provider = provider;
    await runTask(env, "a");
    const history = store.getMessages(env.sessionId);

    const locker = new Database(env.file);
    openConns.push(locker);
    locker.exec("BEGIN EXCLUSIVE");
    let loaded: ReturnType<typeof loadSessionEchoes>;
    try {
      loaded = loadSessionEchoes(env.deps, env.sessionId, history);
    } finally {
      locker.exec("ROLLBACK");
    }
    expect(loaded).toBeUndefined();
    expect(storeWarn.mock.calls.filter((c) => String(c[0]).includes(ECHO_WARN))).toHaveLength(1);
    expect((await runTask(env, "b")).status).toBe("completed");
  });

  it("R9-hist S5a AC4: a VALIDATION_ERROR thrown by appendMessageEcho before its own try block is isolated too", async () => {
    const env = makeEnv();
    brokenStore(env, {
      append: () => {
        throw new ToolError("VALIDATION_ERROR", "Invalid echo sizes");
      },
    });
    const run = await runDirect(env, new ScriptedProvider([turn({ content: "done", echo: MIXED })]));
    expect(run.status).toBe("completed");
    expect(env.log.warnsAbout(ECHO_WARN)).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC5: a rejected replay degrades once and heals the session", () => {
  const REJECTION = `messages.1.content.0: Invalid \`signature\` in \`thinking\` block ${SIG}`;

  it("R9-hist S5a AC5: echoDegraded => one provider:history_degraded event, the session's echo rows are deleted, the next task sends no echoes", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([
      turn({ content: "one", echo: MIXED }),
      turn({ content: "two", echo: MIXED, echoDegraded: { apiMessage: REJECTION, echoedMessages: 1 } }),
      turn({ content: "three" }),
    ]);
    hoisted.provider = provider;

    await runTask(env, "a");
    expect(echoRows(env.sqlite)).toHaveLength(1);
    expect((await runTask(env, "b")).status).toBe("completed");

    const events = taskEvents(env.sqlite, "provider:history_degraded");
    expect(events).toHaveLength(1);
    expect(events[0]?.parsed["healed"]).toBe(true);
    expect(events[0]?.parsed["echoedMessages"]).toBe(1);
    expect(events[0]?.parsed["reason"]).toBe("api_rejected_replay: signature, thinking"); // a classification, not the API text
    expect(JSON.stringify(events[0]?.parsed)).not.toContain(SIG);
    expect(echoRows(env.sqlite)).toHaveLength(0); // deleted, and this response's own echo was NOT re-persisted

    expect((await runTask(env, "c")).status).toBe("completed");
    expect(provider.calls[2]?.echoes).toBeUndefined();
    expect("echoes" in (provider.calls[2]?.req ?? {})).toBe(false);
  });

  it("R9-hist S5a AC5: the degrade is sticky for the rest of the run (later calls carry no echoes, nothing is persisted, the event is not repeated)", async () => {
    const env = makeEnv();
    const provider = new ScriptedProvider([
      turn({ tool: true, echo: MIXED, echoDegraded: { apiMessage: REJECTION, echoedMessages: 2 } }),
      turn({ tool: true, echo: MIXED }),
      turn({ content: "done", echo: MIXED }),
    ]);
    const seed = new Map<string, IProviderEcho>([["seeded", MIXED]]);
    const run = await runDirect(env, provider, { echoes: seed });

    expect(run.status).toBe("completed");
    expect(provider.mainCalls.map((c) => c.echoes?.size ?? 0)).toEqual([1, 0, 0]);
    expect(taskEvents(env.sqlite, "provider:history_degraded")).toHaveLength(1);
    expect(echoRows(env.sqlite)).toHaveLength(0);
  });

  it("R9-hist S5a AC5: a failing deleteMessageEchoes during the heal is isolated (task completes, one WARN)", async () => {
    const env = makeEnv();
    vi.spyOn(env.store, "deleteMessageEchoes").mockImplementation(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    const run = await runDirect(env, new ScriptedProvider([turn({ content: "done", echoDegraded: { apiMessage: REJECTION, echoedMessages: 1 } })]));
    expect(run.status).toBe("completed");
    expect(env.log.warnsAbout(ECHO_WARN)).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC6: pause_turn continuations are vetted per continuation and a cap fails the task", () => {
  class CapReached extends Error {
    readonly isEnforcementError = true;
  }
  /** Honours the S0 contract: awaits `beforeContinuation(n)` before each continuation request. */
  class PausingProvider implements LLMProvider {
    requests = 0;
    constructor(
      private readonly pauses: number,
      private readonly onBefore?: (n: number) => void,
      private readonly wrapErrors = false
    ) {}
    async chat(req: ProviderChatRequest): Promise<ProviderChatResponse> {
      this.requests += 1; // the initial request
      try {
        for (let n = 1; n <= this.pauses; n++) {
          this.onBefore?.(n);
          await req.beforeContinuation?.(n);
          this.requests += 1;
        }
      } catch (err) {
        // A provider that re-classifies what propagates out of chat() (S2b: ProviderCallError loses identity).
        if (this.wrapErrors) throw new ToolError("PROVIDER_RATE_LIMITED", "classified by the provider wrapper");
        throw err;
      }
      return turn({ content: "done", modelCalls: 1 + this.pauses })(undefined as never) as ProviderChatResponse;
    }
  }

  it("R9-hist S5a AC6: continuations are counted in modelCalls, pre:model_request runs per continuation, and each is a provider:pause_continued event", async () => {
    const env = makeEnv();
    const provider = new PausingProvider(2);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("completed");
    expect(provider.requests).toBe(3);
    expect(env.hooks.count("pre:model_request")).toBe(3); // the turn + 2 continuations
    expect(taskEvents(env.sqlite, "provider:pause_continued").map((e) => e.parsed["n"])).toEqual([1, 2]);
    const response = env.hooks.emitted.find((e) => e.event === "post:model_response");
    expect((JSON.parse(response?.json ?? "{}") as { modelCalls?: number }).modelCalls).toBe(3);
    expect(taskEvents(env.sqlite, "MODEL_RESPONSE")[0]?.parsed["modelCalls"]).toBe(3);
  });

  it("R9-hist S5a AC6: a budget cap trips mid-loop (3rd pre:model_request) => BUDGET_EXCEEDED even through a re-classifying provider; no further request is sent", async () => {
    const env = makeEnv();
    let enforced = 0;
    env.hooks.registerEnforcement("pre:model_request", async () => {
      enforced += 1;
      if (enforced === 3) throw new CapReached("budget cap reached");
    });
    const provider = new PausingProvider(4, undefined, true);
    const run = await runDirect(env, provider);

    expect(run.status).toBe("failed");
    expect(provider.requests).toBe(2); // initial + continuation 1; continuation 2 was refused before it was sent
    expect(run.error).toContain("[BUDGET_EXCEEDED]");
    expect(taskEvents(env.sqlite, "provider:pause_continued").map((e) => e.parsed["n"])).toEqual([1]);
  });

  it("R9-hist S5a AC6: cancelling during the 3rd continuation sends no 4th request and the task ends cancelled", async () => {
    const env = makeEnv();
    const controller = new AbortController();
    const provider = new PausingProvider(5, (n) => {
      if (n === 3) controller.abort();
    });
    const run = await runDirect(env, provider, { signal: controller.signal });

    expect(run.status).toBe("cancelled");
    expect(provider.requests).toBe(3); // initial + continuations 1 and 2; none after the abort
  });

  it("R9-hist S5a AC6: a pause cap error fails the task with PROVIDER_ERROR and is never reported completed", async () => {
    const env = makeEnv();
    const capProvider: LLMProvider = {
      chat: async () => {
        throw new PauseTurnCapError(5, 5);
      },
    };
    const run = await runDirect(env, capProvider);
    expect(run.status).toBe("failed");
    expect(run.status).not.toBe("completed");
    expect(run.error).toContain("[PROVIDER_ERROR]");
    expect(run.error).toContain("paused the turn 5 times");
  });

  it("R9-hist S5a AC6: a pause cap error wrapped by a re-classifying provider (different code, marker in data.kind) still fails as PROVIDER_ERROR", async () => {
    const env = makeEnv();
    const wrapped: LLMProvider = {
      chat: async () => {
        throw Object.assign(new ToolError("PROVIDER_RATE_LIMITED", "provider call failed", { kind: "pause_turn_capped" }), {
          cause: new PauseTurnCapError(5, 5),
        });
      },
    };
    const run = await runDirect(env, wrapped);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("[PROVIDER_ERROR]");
    expect(run.error).not.toContain("PROVIDER_RATE_LIMITED");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC7: compaction and echo", () => {
  const history = (): { messages: Message[]; assistants: string[] } => {
    const sessionId = "s";
    const m = (role: Message["role"], content: string): Message => ({ id: generateId(), sessionId, role, content, createdAt: nowIso() });
    const messages: Message[] = [m("system", "sys")];
    const assistants: string[] = [];
    for (let n = 0; n < 8; n++) {
      messages.push(m("user", `q${n}`));
      const a = m("assistant", `a${n}`);
      assistants.push(a.id);
      messages.push(a);
    }
    messages.push(m("user", "go"));
    return { messages, assistants };
  };
  const small = (id: string): [string, IProviderEcho] => [id, echoOf([THINKING, TEXT])];

  it("R9-hist S5a AC7: the summariser request carries no echoes and no continuation hook, and compacted ids are not replayed afterwards", async () => {
    const env = makeEnv();
    const { messages, assistants } = history();
    const echoes = new Map(assistants.map(small));
    const provider = new ScriptedProvider([turn({ tool: true, inputTokens: 100_000 }), turn({ content: "done" })]);
    const run = await runDirect(env, provider, { messages, echoes });

    expect(run.status).toBe("completed");
    const summariser = provider.calls.filter((c) => c.isSummariser);
    expect(summariser).toHaveLength(1);
    expect(summariser[0]?.echoes).toBeUndefined();
    expect("echoes" in (summariser[0]?.req ?? {})).toBe(false);
    expect(summariser[0]?.hasBeforeContinuation).toBe(false);
    const [first, second] = provider.mainCalls;
    expect([...(first?.echoes?.keys() ?? [])]).toEqual(assistants); // before compaction every history echo is replayed
    const replayedAfter = [...(second?.echoes?.keys() ?? [])];
    // The verbatim tail (last 4 atomic units: q7, a7, go, tool turn) keeps a7 and its echo; a0..a6 were folded into the summary.
    expect(replayedAfter).toEqual([assistants[7]]);
    for (const compacted of assistants.slice(0, 7)) expect(replayedAfter).not.toContain(compacted);
  });

  it("R9-hist S5a AC7: the first-call estimate includes the echo bytes (a huge echo triggers compaction that the same history without echo does not)", async () => {
    const { messages, assistants } = history();
    const huge = new Map<string, IProviderEcho>([[assistants[0] as string, echoOf([{ type: "text", text: "x".repeat(500_000) }])]]);

    const withEcho = makeEnv();
    const p1 = new ScriptedProvider([turn({ content: "done" })]);
    await runDirect(withEcho, p1, { messages, echoes: huge });
    expect(p1.calls.filter((c) => c.isSummariser)).toHaveLength(1);
    expect(p1.mainCalls[0]?.echoes).toBeUndefined(); // the only echo belonged to a compacted message => nothing is replayed

    const without = makeEnv();
    const p2 = new ScriptedProvider([turn({ content: "done" })]);
    await runDirect(without, p2, { messages });
    expect(p2.calls.filter((c) => c.isSummariser)).toHaveLength(0);
  });

  it("R9-hist S5a AC7: once a call has reported the real prompt size, the echo estimate no longer counts (reported usage governs)", () => {
    const m = [{ id: "x", sessionId: "s", role: "user", content: "hi", createdAt: nowIso() }] as Message[];
    expect(decideCompaction(1_000, m, "gpt-4o-mini", undefined, 10_000_000).shouldCompact).toBe(false);
    expect(decideCompaction(undefined, m, "gpt-4o-mini", undefined, 10_000_000).shouldCompact).toBe(true);
    expect(decideCompaction(undefined, m, "gpt-4o-mini").shouldCompact).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC8: echo metrics on MODEL_RESPONSE", () => {
  it("R9-hist S5a AC8: MODEL_RESPONSE carries echoBlocks, echoBytes, echoReplayedMessages and echoReplayedBytes", async () => {
    const env = makeEnv();
    const run = await runDirect(
      env,
      new ScriptedProvider([turn({ tool: true, echo: MIXED, echoReplay: { messages: 2, bytes: 1234 } }), turn({ content: "done" })])
    );
    expect(run.status).toBe("completed");
    const [first, second] = taskEvents(env.sqlite, "MODEL_RESPONSE");
    expect(first?.parsed["echoBlocks"]).toBe(MIXED.blocks.length);
    expect(first?.parsed["echoBytes"]).toBe(Buffer.byteLength(JSON.stringify(MIXED.blocks)));
    expect(first?.parsed["echoReplayedMessages"]).toBe(2);
    expect(first?.parsed["echoReplayedBytes"]).toBe(1234);
    // A response with neither echo nor replay is exactly what it always was.
    for (const key of ["echoBlocks", "echoBytes", "echoReplayedMessages", "echoReplayedBytes"]) expect(second?.parsed).not.toHaveProperty(key);
  });

  it("R9-hist S5a AC8: the payload builder adds the fields only when defined (legacy payload keys unchanged)", () => {
    const legacy = buildModelResponsePayload({ stopReason: "completed", hasContent: true, toolCallCount: 0 }, 5);
    expect(Object.keys(legacy).filter((k) => k.startsWith("echo"))).toEqual([]);
    const response: ProviderChatResponse = { message: msg("assistant", "x"), stopReason: "completed", echo: MIXED, echoReplay: { messages: 1, bytes: 9 } };
    const withEcho = buildModelResponsePayload(sourceFromResponse(response, 0, true), 5);
    expect(withEcho).toMatchObject({ echoBlocks: MIXED.blocks.length, echoReplayedMessages: 1, echoReplayedBytes: 9 });
    const { echoBlocks: _b, echoBytes: _y, echoReplayedMessages: _m, echoReplayedBytes: _r, ...rest } = withEcho as Record<string, unknown>;
    expect(rest).toEqual(legacy);
  });

  it("R9-hist S5a AC8: usage_query renders a payload with echo fields identically to the same payload without them", async () => {
    const rowsFor = async (echo: boolean) => {
      const env = makeEnv();
      new UsagePlugin(env.deps.db).install(env.hooks);
      const run = await runDirect(
        env,
        new ScriptedProvider([turn({ content: "done", inputTokens: 123, ...(echo ? { echo: MIXED, echoReplay: { messages: 3, bytes: 99 } } : {}) })])
      );
      expect(run.status).toBe("completed");
      const out = usageQueryByGrain(env.deps.db, { include_incomplete: true, limit: 50, grain: "turn" });
      // Task ids differ run to run (they also appear inside context_size_at); everything else must match.
      return out.rows.map((r) => {
        const { task_id: _t, session_id: _s, created_at: _c, compute_ms: _m, started_at: _st, ended_at: _e, ...rest } = r as unknown as Record<string, unknown>;
        return JSON.parse(JSON.stringify(rest).replaceAll(run.taskId, "<task>")) as unknown;
      });
    };
    const plain = await rowsFor(false);
    const echoed = await rowsFor(true);
    expect(plain).toHaveLength(1);
    expect(echoed).toEqual(plain);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
describe("R9-hist S5a AC9: no signature, page text or encrypted_content outside the echo table", () => {
  it("R9-hist S5a AC9: after a run with signatures present, events, messages, hook payloads, logs and emitted task events carry none of them", async () => {
    const env = makeEnv();
    const emittedTaskEvents: string[] = [];
    env.deps.emitTaskEvent = (e) => emittedTaskEvents.push(JSON.stringify(e));
    const provider = new ScriptedProvider([
      turn({ tool: true, echo: MIXED }),
      turn({ content: "one", echo: MIXED, echoReplay: { messages: 1, bytes: 10 } }),
      turn({ content: "two", echo: MIXED, echoDegraded: { apiMessage: `Invalid \`signature\` ${SIG} ${PAGE}`, echoedMessages: 1 } }),
    ]);
    hoisted.provider = provider;

    // Teeth: the sentinels really are in play - the echo table holds them after the first (direct) turn.
    await runDirect(env, new ScriptedProvider([turn({ tool: true, echo: MIXED }), turn({ content: "x", echo: MIXED })]));
    const table = echoRows(env.sqlite).map((r) => r.blocks).join("\n");
    for (const needle of [SIG, PAGE, ENC]) expect(table).toContain(needle);

    await runTask(env, "a");
    await runTask(env, "b");
    await runTask(env, "c");

    const events = taskEvents(env.sqlite).map((e) => `${e.type} ${e.payload ?? ""}`);
    const messages = (env.sqlite.prepare("SELECT content, tool_calls, tool_results FROM messages").all() as unknown[]).map((r) => JSON.stringify(r));
    const hookPayloads = env.hooks.emitted.map((e) => `${e.event} ${e.json}`);
    const logs = env.log.logs.map((l) => l.json);
    const corpus = [...events, ...messages, ...hookPayloads, ...logs, ...emittedTaskEvents].join("\n");

    expect(corpus.length).toBeGreaterThan(1000);
    expect(hookPayloads.some((p) => p.startsWith("message:appended"))).toBe(true);
    expect(hookPayloads.some((p) => p.startsWith("post:model_response"))).toBe(true);
    for (const needle of [SIG, PAGE, ENC, "encrypted_content"]) expect(corpus).not.toContain(needle);
    expect(corpus).not.toMatch(/"signature"\s*:/);
    expect(corpus).not.toMatch(/"thinking"\s*:/);
  });
});
