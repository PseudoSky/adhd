/**
 * R9-hist S6 -- the whole provider-echo chain through REAL components, offline.
 *
 * What is real: `taskTool` -> `buildProviderForSelection` -> the real `AnthropicProvider` on the real
 * `@anthropic-ai/sdk` stream parser -> the real Orchestrator tool loop (self-referential in-process client) -> the real
 * SessionStore / TaskStore on an on-disk better-sqlite3 file built by the SHIPPED drizzle migrations (entrypoint/agent-mcp
 * /drizzle, incl. 0017), reopened on a fresh connection wherever persistence is claimed -> the real sanitize plugin where
 * a veto is claimed. What is faked: ONLY the external boundary, the Anthropic HTTP API, by the S1 contract fake
 * (`fixtures/anthropic-contract-fake.ts`, injected through `EngineConfig.wire.fetch`), which validates every request
 * body against the documented history rules (V1-V5) and answers 400 exactly as the API does. Nothing is mocked inside the
 * system under test: no `vi.mock`, no stubbed provider, no spied store.
 *
 * No network, no provider call, no subprocess, no sleep. Time is the injected `EngineConfig.now` backed by
 * `vi.useFakeTimers({ toFake: ["Date"] })`, so message timestamps and the idle-TTL clock agree and advance by assignment.
 * One fake instance serves a whole scenario (its thinking registry is what makes a replayed signature "genuine").
 *
 * Location: this package (not entrypoint/agent-mcp as spec-v2 section 4 sketched). agent-mcp resolves the orchestrator from
 * its built `dist/`, so a product-code mutation never reaches a test there without a rebuild; here `@adhd/*` resolves to
 * source and every negative control in this file's report flips a test directly. The migrations are the same shipped folder
 * agent-mcp runs; its `runMigrationsOn` wrapper only adds a concurrent-opener retry around the same drizzle `migrate`.
 *
 * Acceptance ids (each test title carries `R9-hist S6 AC<n>`):
 *   AC1 two-task session: thinking (signature byte-for-byte), server pairs and canonical tool names reach request 2; V1-V5 clean
 *   AC2 persistence: store reopened between tasks; idle past the TTL strips tier S only (tier T stays, no 400)
 *   AC3 pause: 2 pauses then end_turn = ONE assistant message, 3 model calls, echo metrics; 5 pauses = failed, 5 requests
 *   AC4 degrade self-heal: a signature-style 400 => one legacy retry, one event, echo rows gone, next task clean;
 *       a context-length 400 is the same failure as without echo (no retry, echo rows kept, not degraded)
 *   AC5 sanitize veto: delegationOnly:false => tier S never stored, in-run replay unchanged, tier T stored
 *   AC6 privacy: signature / page text / encrypted_content only in message_provider_echo (with a teeth check)
 *   AC7 failure isolation: echo table dropped / corrupt mid-session => tasks complete on legacy history, one WARN
 *   AC8 compaction: the summariser request carries no echoed blocks; compacted ids are not replayed
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
import type { AgentDefinition, HookEvent, HookEventMap, Plugin } from "@adhd/agent-base-types";
// The sanitize plugin is exercised as shipped; it is not a dependency of this package (test-only reach by path).
// eslint-disable-next-line @nx/enforce-module-boundaries
import createSanitizePlugin from "../../../agent-plugin-sanitize/src/index.js";

import { Orchestrator, resetEchoFailureWarningForTests } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { BackgroundQueue } from "../engine/queue.js";
import { DagEngine } from "../engine/dag-engine.js";
import { PolicyEngine } from "../engine/policy.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import { enqueueExistingTask, taskTool } from "../tools/task.js";
import type { TaskDeps } from "../tools/task.js";
import type { AgentStore } from "../tools/agent-crud.js";
import type { SessionStoreForTool } from "../tools/session.js";
import { usageQueryByGrain } from "../tools/usage.js";
import type { EchoCaps } from "../providers/anthropic-echo.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { nowIso } from "../utils/timestamps.js";
import {
  makeContractFake,
  webFetchResultBlock,
  type FakeScript,
  type FakeStep,
  type IApiBlock,
  type IApiMessage,
  type IContractFake,
  type IContractFakeOptions,
  type IMessagesRequestBody,
} from "./fixtures/anthropic-contract-fake.js";
import type { ISseBlock } from "./fixtures/anthropic-sse.js";
import { REAL_MIGRATIONS_FOLDER } from "./fixtures/real-schema-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const SCRATCH_ROOT = join(REPO_ROOT, "tmp/agent-engine-orchestrator");

// -- clock -----------------------------------------------------------------------------------------------------------
const NOW0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const TTL = 10 * MIN;
const setMinute = (m: number): void => {
  vi.setSystemTime(new Date(NOW0 + m * MIN));
};
const CAPS: EchoCaps = { maxMessageBytes: 131_072, maxSessionBytes: 4_194_304, serverResultTtlMs: TTL };

// -- sentinels: every one must NEVER appear outside the echo table ----------------------------------------------------
const MODEL = "claude-haiku-5-5";
const SELF_URL = "http://self.test/mcp";
const SIG = "SIGSENTINEL" + "Q".repeat(60);
const PAGE = "PAGE-BODY-SENTINEL-third-party-text";
const ENC = "ENCSENTINEL" + "Z".repeat(60);
const FETCH_URL = "https://example.test/docs";

// -- scripted model turns --------------------------------------------------------------------------------------------
const thinking = (signature: string): ISseBlock => ({ type: "thinking", thinking: "", signature });
const fetchPair = (n: number): ISseBlock[] => [
  { type: "server_tool_use", id: `srvtoolu_s6_f${n}`, name: "web_fetch", input: { url: FETCH_URL } },
  webFetchResultBlock(`srvtoolu_s6_f${n}`, FETCH_URL, PAGE),
];
const searchPair = (n: number): ISseBlock[] => [
  { type: "server_tool_use", id: `srvtoolu_s6_s${n}`, name: "web_search", input: { query: "docs" } },
  {
    type: "web_search_tool_result",
    tool_use_id: `srvtoolu_s6_s${n}`,
    content: [{ type: "web_search_result", url: `${FETCH_URL}/s`, title: "docs", encrypted_content: ENC, page_age: null }],
  },
];
/** thinking + web_fetch pair + web_search pair + text + a client tool_use of the in-process `calc__lookup` tool. */
const toolTurn = (n: number, sig = SIG, usage?: { input_tokens: number; output_tokens: number }): FakeStep => ({
  blocks: [
    thinking(sig),
    ...fetchPair(n),
    ...searchPair(n),
    { type: "text", text: `fetched the page, now looking up (${n})` },
    { type: "tool_use", id: `toolu_s6_${n}`, name: "calc__lookup", input: {} },
  ],
  stopReason: "tool_use",
  ...(usage ? { usage } : {}),
});
/** A closing turn: optional thinking, optional fetch pair, then plain text. */
const answer = (text: string, opts: { sig?: string; fetch?: number } = {}): FakeStep => ({
  blocks: [...(opts.sig ? [thinking(opts.sig)] : []), ...(opts.fetch !== undefined ? fetchPair(opts.fetch) : []), { type: "text", text }],
  stopReason: "end_turn",
});
const pause = (i: number, sig?: string): FakeStep => ({
  blocks: [
    ...(sig ? [thinking(sig)] : []),
    { type: "server_tool_use", id: `srvtoolu_s6_p${i}`, name: "web_fetch", input: { url: `${FETCH_URL}/${i}` } },
    { type: "text", text: `part-${i}` },
  ],
  stopReason: "pause_turn",
});
const rejection = (status: number, message: string): FakeStep => ({ error: { status, type: "invalid_request_error", message } });
const SIGNATURE_400 = "messages.1.content.0: Invalid `signature` in `thinking` block";
// Names a replayed block type on purpose: only the context-length exclusion keeps this from reading as an echo rejection.
const CONTEXT_400 = "prompt is too long: 250000 tokens > 200000 maximum (including web_fetch_tool_result content)";

/** A function script answering request `index` with `steps[index]`; an unscripted request is a fault the test sees. */
const byIndex =
  (steps: readonly FakeStep[]): FakeScript =>
  (ctx) =>
    steps[ctx.index] ?? rejection(500, `S6 script exhausted at request ${ctx.index}`);

// -- reading request bodies ------------------------------------------------------------------------------------------
const blocksOf = (m: IApiMessage): IApiBlock[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const assistantBlocks = (body: IMessagesRequestBody): IApiBlock[] => body.messages.filter((m) => m.role === "assistant").flatMap(blocksOf);
const typesOnWire = (body: IMessagesRequestBody): string[] => assistantBlocks(body).map((b) => b.type);
const signaturesOnWire = (body: IMessagesRequestBody): string[] =>
  assistantBlocks(body)
    .filter((b) => b.type === "thinking")
    .map((b) => String(b["signature"]));
const SERVER_TYPES = ["server_tool_use", "web_fetch_tool_result", "web_search_tool_result"];
const hasServerBlocks = (body: IMessagesRequestBody): boolean => typesOnWire(body).some((t) => SERVER_TYPES.includes(t));
const advertised = (body: IMessagesRequestBody): string[] => (body.tools ?? []).map((t) => String((t as { name?: string }).name));
const isSummariser = (body: IMessagesRequestBody): boolean => JSON.stringify(body.system ?? "").includes("Summarise the following conversation excerpt");

// -- recording hooks / logger ----------------------------------------------------------------------------------------
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

// -- the world: one fake + one DB file + hooks/log shared across reopened connections --------------------------------
function agentDef(): AgentDefinition {
  return {
    name: "echo-agent",
    version: 1,
    provider: { type: "anthropic", model: MODEL } as AgentDefinition["provider"],
    systemPrompt: "You are a test agent.",
    mcpServers: { calc: { transport: "http", url: SELF_URL } } as AgentDefinition["mcpServers"],
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

interface IWorld {
  fake: IContractFake;
  file: string;
  hooks: RecordingHooks;
  log: ReturnType<typeof recordingLogger>;
  caps: EchoCaps | undefined;
}
interface IEnv {
  world: IWorld;
  sqlite: Database.Database;
  store: SessionStore;
  taskStore: TaskStore;
  deps: TaskDeps;
  sessionId: string;
}

let scratch: string;
const openConns: Database.Database[] = [];
let worldCount = 0;

function makeWorld(script: FakeScript, opts: { fake?: IContractFakeOptions; echo?: EchoCaps | null } = {}): IWorld {
  worldCount += 1;
  return {
    fake: makeContractFake(script, opts.fake),
    file: join(scratch, `db-${worldCount}.sqlite`),
    hooks: new RecordingHooks(),
    log: recordingLogger(),
    caps: opts.echo === null ? undefined : (opts.echo ?? CAPS),
  };
}

function engineConfig(world: IWorld): EngineConfig {
  return {
    server: { contextLimit: 0, defaultMaxTokens: 1024 },
    queue: { concurrency: 5 },
    sse: { baseUrl: "http://localhost:0" },
    plugins: { entries: [] },
    // The ONLY seam substituted: the HTTP boundary the real SDK talks through.
    wire: { fetch: world.fake.fetch, withContext: (_ctx: unknown, fn: () => unknown) => fn() } as unknown as EngineConfig["wire"],
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
    subprocessEnv: () => ({}),
    isEnvNameAllowed: () => true,
    resolveEnvName: (() => undefined) as unknown as EngineConfig["resolveEnvName"],
    ...(world.caps !== undefined ? { echo: world.caps } : {}),
    now: () => Date.now(),
  };
}

/** Open the world's DB file (migrating it) and wire the real engine on it. `sessionId` omitted => a new session. */
function openEnv(world: IWorld, sessionId?: string, StoreCtor: typeof SessionStore = SessionStore): IEnv {
  const sqlite = new Database(world.file);
  openConns.push(sqlite);
  sqlite.pragma("foreign_keys = OFF");
  migrate(drizzle(sqlite), { migrationsFolder: REAL_MIGRATIONS_FOLDER });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const store = new StoreCtor(db, world.hooks);
  const taskStore = new TaskStore(db);
  const definition = agentDef();
  const agentStore: AgentStore = {
    create: () => definition,
    read: () => definition,
    update: () => definition,
    delete: () => undefined,
    list: () => [definition],
  };
  const queue = new BackgroundQueue(5, world.log.logger);
  const policy = new PolicyEngine({ serverMaxDepth: 5, serverMaxToolLoops: 5 });
  const depsRef: { value?: TaskDeps } = {};
  const dagEngine = new DagEngine(db, queue, taskStore as never, async (taskId: string) => {
    if (!depsRef.value) throw new Error("dispatchFn before init");
    await enqueueExistingTask(taskId, depsRef.value);
  }, world.log.logger);
  const deps: TaskDeps = {
    agentStore,
    sessionStore: store as unknown as SessionStoreForTool,
    taskStore,
    orchestrator: new Orchestrator(),
    queue,
    policy,
    hooks: world.hooks,
    selfUrl: SELF_URL,
    inProcessDescriptors: [{ name: "lookup", description: "look something up", inputSchema: { type: "object", properties: {} } }],
    inProcessHandler: async () => "lookup-result",
    db,
    dagEngine,
    config: engineConfig(world),
    logger: world.log.logger,
  };
  depsRef.value = deps;
  const id = sessionId ?? store.create({ agentName: definition.name, agentDefinition: definition }).id;
  return { world, sqlite, store, taskStore, deps, sessionId: id };
}

/** Close the connection and open a brand-new one on the same file (a process restart as far as the store can tell). */
function reopen(env: IEnv, StoreCtor: typeof SessionStore = SessionStore): IEnv {
  env.sqlite.close();
  return openEnv(env.world, env.sessionId, StoreCtor);
}

const runTask = (env: IEnv, prompt: string) => taskTool({ session_id: env.sessionId, prompt, background: false }, env.deps);
const taskError = (env: IEnv, taskId: string): string => env.taskStore.read(taskId).error ?? "";

interface IEchoRow {
  message_id: string;
  session_id: string;
  blocks: string;
  bytes: number;
  server_bytes: number;
}
const echoRows = (conn: Database.Database): IEchoRow[] =>
  conn.prepare("SELECT message_id, session_id, blocks, bytes, server_bytes FROM message_provider_echo ORDER BY created_at, message_id").all() as IEchoRow[];
const rowTypes = (row: IEchoRow | undefined): string[] => (row ? (JSON.parse(row.blocks) as Array<{ type: string }>).map((b) => b.type) : []);
const taskEvents = (conn: Database.Database, type?: string) =>
  (conn.prepare("SELECT task_id, type, payload FROM task_events ORDER BY created_at, rowid").all() as Array<{ task_id: string; type: string; payload: string | null }>)
    .filter((e) => type === undefined || e.type === type)
    .map((e) => ({ ...e, parsed: e.payload ? (JSON.parse(e.payload) as Record<string, unknown>) : {} }));
const assistantMessages = (conn: Database.Database): Array<{ id: string; content: string | null }> =>
  conn.prepare("SELECT id, content FROM messages WHERE role = 'assistant' ORDER BY rowid").all() as Array<{ id: string; content: string | null }>;

/** A scenario that must be clean: the fake saw no fault and no history-rule violation. */
const noFaults = (w: IWorld): void => {
  expect(w.fake.faults).toEqual([]);
  expect(w.fake.rejections()).toEqual([]);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setMinute(0);
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  scratch = mkdtempSync(join(SCRATCH_ROOT, "echo-session-"));
  resetEchoFailureWarningForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const c of openConns.splice(0)) if (c.open) c.close();
  rmSync(scratch, { recursive: true, force: true });
});

// ================================================================================================================
describe("R9-hist S6 AC1: a two-task session replays the model's own blocks", () => {
  it("R9-hist S6 AC1: thinking (signature byte-for-byte), both server pairs and canonical tool names reach the next task's request; V1-V5 hold", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two")]));
    const env = openEnv(w);

    const first = await runTask(env, "first");
    expect(first.status).toBe("completed");
    expect(first.result).toBe("answer one");
    setMinute(3);
    const second = await runTask(env, "second");
    expect(second.status).toBe("completed");
    expect(second.result).toBe("answer two");

    const bodies = w.fake.bodies();
    expect(bodies).toHaveLength(3);
    // In-run replay (tool loop of task 1) and cross-task replay (task 2) carry the same turn: types in captured order.
    const expected = ["thinking", "server_tool_use", "web_fetch_tool_result", "server_tool_use", "web_search_tool_result", "text", "tool_use"];
    expect(typesOnWire(bodies[1] as IMessagesRequestBody).slice(0, expected.length)).toEqual(expected);
    const wire = bodies[2] as IMessagesRequestBody;
    expect(typesOnWire(wire).slice(0, expected.length)).toEqual(expected);
    // Thinking is replayed unchanged: the signature AND the whole block equal what the model emitted.
    expect(signaturesOnWire(wire)).toEqual([SIG]);
    const emittedThinking = w.fake.emittedTurns[0]?.thinking ?? [];
    const wireThinking = assistantBlocks(wire).filter((b) => b.type === "thinking");
    expect(wireThinking).toEqual(emittedThinking);
    expect(JSON.stringify(wireThinking[0]?.["signature"])).toBe(JSON.stringify(SIG));
    // The page really is in context: no refetch is needed.
    expect(JSON.stringify(wire.messages)).toContain(PAGE);
    // Canonical `server__tool` names: every replayed client tool_use is a member of the advertised tool list.
    const toolUses = assistantBlocks(wire).filter((b) => b.type === "tool_use");
    expect(toolUses.map((b) => b["name"])).toEqual(["calc__lookup"]);
    expect(advertised(wire)).toContain("calc__lookup");
    noFaults(w); // V1-V5: no violation recorded for any of the 3 requests
  });
});

// ================================================================================================================
describe("R9-hist S6 AC2: persistence across a store reopen and the session-idle TTL", () => {
  it("R9-hist S6 AC2: the store is closed and reopened (new connection, new SessionStore) between the tasks and replay still happens", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two")]));
    let env = openEnv(w);
    expect((await runTask(env, "first")).status).toBe("completed");
    const firstRows = echoRows(env.sqlite);
    expect(firstRows.length).toBeGreaterThan(0);

    const connBefore = env.sqlite;
    env = reopen(env);
    expect(env.sqlite).not.toBe(connBefore);
    expect(connBefore.open).toBe(false);
    expect(echoRows(env.sqlite)).toEqual(firstRows); // the rows survived the reopen

    setMinute(5); // within the 10 minute TTL
    expect((await runTask(env, "second")).status).toBe("completed");
    const wire = w.fake.bodies()[2] as IMessagesRequestBody;
    expect(signaturesOnWire(wire)).toEqual([SIG]);
    expect(typesOnWire(wire)).toEqual(expect.arrayContaining(SERVER_TYPES));
    noFaults(w);
  });

  it("R9-hist S6 AC2: with the fake clock past the 10 minute idle TTL tier S is absent from the wire, tier T is present, and there is no 400", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two")]));
    let env = openEnv(w);
    await runTask(env, "first");
    env = reopen(env);

    setMinute(11); // idle 11 min > TTL 10 min; no sweeper involved: the strip happens at read
    expect((await runTask(env, "second")).status).toBe("completed");

    const wire = w.fake.bodies()[2] as IMessagesRequestBody;
    expect(hasServerBlocks(wire)).toBe(false);
    expect(JSON.stringify(wire.messages)).not.toContain(PAGE);
    expect(signaturesOnWire(wire)).toEqual([SIG]); // tier T survives the TTL
    expect(typesOnWire(wire)).toEqual(expect.arrayContaining(["thinking", "text", "tool_use"]));
    expect(w.fake.requests.map((r) => r.status)).toEqual([200, 200, 200]); // no 400
    // Tier T is still stored after the idle task start (the reclaim sweep strips tier S only).
    expect(echoRows(env.sqlite).flatMap(rowTypes)).toEqual(expect.arrayContaining(["thinking", "tool_use"]));
    noFaults(w);
  });

  it("R9-hist S6 AC2: when the reclaim sweep cannot run (a trigger rejects its UPDATE) the READ still strips tier S past the idle TTL", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two")]));
    let env = openEnv(w);
    await runTask(env, "first");
    env = reopen(env); // a new SessionStore: its first task runs the throttled sweep, which the trigger now makes fail
    env.sqlite.exec(
      "CREATE TRIGGER s6_block_sweep BEFORE UPDATE ON message_provider_echo BEGIN SELECT RAISE(ABORT, 'sweep blocked'); END;"
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    setMinute(11);
    expect((await runTask(env, "second")).status).toBe("completed");
    expect(echoRows(env.sqlite).some((r) => r.server_bytes > 0)).toBe(true); // the sweep really did not strip it
    const wire = w.fake.bodies()[2] as IMessagesRequestBody;
    expect(hasServerBlocks(wire)).toBe(false); // ...so the absence on the wire is the reader's doing
    expect(signaturesOnWire(wire)).toEqual([SIG]);
    noFaults(w);
  });

  it("R9-hist S6 AC2: a session kept alive (tasks at minute 0, 9, 15) still replays the minute-0 server blocks", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("one"), answer("two"), answer("three")]));
    let env = openEnv(w);
    await runTask(env, "first");
    setMinute(9);
    await runTask(env, "second");
    env = reopen(env);
    setMinute(15); // 6 minutes after the last activity: still warm although the minute-0 rows are 15 minutes old
    expect((await runTask(env, "third")).status).toBe("completed");
    const wire = w.fake.bodies()[3] as IMessagesRequestBody;
    expect(typesOnWire(wire)).toEqual(expect.arrayContaining(SERVER_TYPES));
    noFaults(w);
  });
});

// ================================================================================================================
describe("R9-hist S6 AC3: pause_turn", () => {
  const usageOf = (env: IEnv) => usageQueryByGrain(env.deps.db, { include_incomplete: true, limit: 50, grain: "task" });

  it("R9-hist S6 AC3: 2 pauses then end_turn complete as ONE assistant message, 3 model calls, with echo metrics on MODEL_RESPONSE", async () => {
    const w = makeWorld(byIndex([answer("earlier", { sig: "SIG-EARLIER" }), pause(0, "SIG-PAUSED"), pause(1), answer("final")]));
    const env = openEnv(w);
    new UsagePlugin(env.deps.db).install(w.hooks);
    expect((await runTask(env, "first")).status).toBe("completed");

    const out = await runTask(env, "second");
    expect(out.status).toBe("completed");
    expect(out.result).toBe("part-0\npart-1\nfinal");
    expect(w.fake.requests).toHaveLength(4); // 1 for task one + exactly 3 for the paused turn
    const assistants = assistantMessages(env.sqlite);
    expect(assistants.map((m) => m.content)).toEqual(["earlier", "part-0\npart-1\nfinal"]); // ONE message for the whole paused turn

    const [, paused] = taskEvents(env.sqlite, "MODEL_RESPONSE");
    expect(paused?.parsed["modelCalls"]).toBe(3);
    expect(paused?.parsed["echoBlocks"]).toBe(8); // thinking, 2x(server_tool_use + result + text), final text: every block of all three calls
    expect(paused?.parsed["echoBytes"]).toBeGreaterThan(0);
    expect(paused?.parsed["echoReplayedMessages"]).toBe(1); // task one's assistant message
    expect(paused?.parsed["echoReplayedBytes"]).toBeGreaterThan(0);
    expect(taskEvents(env.sqlite, "provider:pause_continued").map((e) => e.parsed["n"])).toEqual([1, 2]);
    // usage_query (task grain): the paused task reports three model calls (a turn-grain row is always one MODEL_RESPONSE).
    const rows = usageOf(env).rows as unknown as Array<{ task_id: string; model_calls: number }>;
    expect(rows.find((r) => r.task_id === out.task_id)?.model_calls).toBe(3);
    noFaults(w);
  });

  it("R9-hist S6 AC3: 5 consecutive pauses fail the task with PROVIDER_ERROR (never completed) after exactly 5 requests", async () => {
    const w = makeWorld(byIndex([answer("earlier", { sig: "SIG-EARLIER" }), pause(0), pause(1), pause(2), pause(3), pause(4)]));
    const env = openEnv(w);
    await runTask(env, "first");

    const out = await runTask(env, "second");
    expect(out.status).toBe("failed");
    expect(out.status).not.toBe("completed");
    expect(w.fake.requests).toHaveLength(1 + 5); // task one + exactly five for the capped turn
    const error = taskError(env, out.task_id);
    expect(error).toContain("[PROVIDER_ERROR]");
    expect(error).toContain("paused the turn 5 times");
    expect(assistantMessages(env.sqlite).map((m) => m.content)).toEqual(["earlier"]); // no partial content was persisted
    expect(taskEvents(env.sqlite, "provider:pause_continued").map((e) => e.parsed["n"])).toEqual([1, 2, 3, 4]);
    noFaults(w);
  });
});

// ================================================================================================================
describe("R9-hist S6 AC4: a rejected replay degrades once and heals the session", () => {
  it("R9-hist S6 AC4: a signature-style 400 => one legacy retry completes the task, one event, echo rows gone, the next task sends no echo and gets no 400", async () => {
    const w = makeWorld(
      byIndex([
        answer("answer one", { sig: SIG, fetch: 1 }),
        rejection(400, SIGNATURE_400), // task 2, echoed history
        answer("answer two"), // task 2, the single legacy retry
        answer("answer three"), // task 3
      ]),
      { fake: { allowThinkingOmission: ({ index }) => index >= 2 } } // the degrade intentionally drops thinking
    );
    const env = openEnv(w);
    expect((await runTask(env, "first")).status).toBe("completed");
    expect(echoRows(env.sqlite)).toHaveLength(1);

    setMinute(2);
    const second = await runTask(env, "second");
    expect(second.status).toBe("completed");
    expect(second.result).toBe("answer two");
    const [echoed, retry] = [w.fake.bodies()[1] as IMessagesRequestBody, w.fake.bodies()[2] as IMessagesRequestBody];
    expect(signaturesOnWire(echoed)).toEqual([SIG]);
    expect(typesOnWire(retry)).not.toContain("thinking");
    expect(hasServerBlocks(retry)).toBe(false);

    const events = taskEvents(env.sqlite, "provider:history_degraded");
    expect(events).toHaveLength(1);
    expect(events[0]?.parsed["healed"]).toBe(true);
    expect(events[0]?.parsed["echoedMessages"]).toBe(1);
    expect(echoRows(env.sqlite)).toHaveLength(0); // the session's echo rows are gone

    setMinute(3);
    expect((await runTask(env, "third")).status).toBe("completed");
    expect(w.fake.requests).toHaveLength(4); // 1 + (400 + retry) + 1: the heal means task 3 burned no failing request
    const third = w.fake.bodies()[3] as IMessagesRequestBody;
    expect(typesOnWire(third)).not.toContain("thinking");
    expect(hasServerBlocks(third)).toBe(false);
    expect(w.fake.requests.map((r) => r.status)).toEqual([200, 400, 200, 200]);
    expect(w.fake.faults).toEqual([]);
    expect(w.fake.rejections()).toEqual([]);
  });

  it("R9-hist S6 AC4: a context-length 400 with echo present is the SAME failure the no-echo path yields: not degraded, not retried, echo rows kept", async () => {
    // Twin without any echo: the first request of a fresh session meets the same 400.
    const twin = makeWorld(byIndex([rejection(400, CONTEXT_400)]));
    const twinEnv = openEnv(twin);
    const twinOut = await runTask(twinEnv, "only");
    expect(twinOut.status).toBe("failed");
    const twinError = taskError(twinEnv, twinOut.task_id);
    expect(twinError).toContain("prompt is too long");

    const w = makeWorld(byIndex([answer("answer one", { sig: SIG, fetch: 1 }), rejection(400, CONTEXT_400), answer("answer three")]));
    const env = openEnv(w);
    await runTask(env, "first");
    const before = echoRows(env.sqlite);

    setMinute(2);
    const second = await runTask(env, "second");
    expect(second.status).toBe("failed");
    expect(taskError(env, second.task_id)).toBe(twinError); // identical classification with and without echo
    expect(w.fake.requests).toHaveLength(2); // exactly one request for task 2: no legacy retry
    expect(taskEvents(env.sqlite, "provider:history_degraded")).toHaveLength(0);
    expect(echoRows(env.sqlite)).toEqual(before); // echo not disabled

    setMinute(3);
    expect((await runTask(env, "third")).status).toBe("completed");
    expect(signaturesOnWire(w.fake.bodies()[2] as IMessagesRequestBody)).toEqual([SIG]); // still echoing
    noFaults(w);
  });
});

// ================================================================================================================
describe("R9-hist S6 AC5: the real sanitize plugin vetoes server-result persistence", () => {
  const install = (w: IWorld, config: Record<string, unknown>): void => {
    const plugin = createSanitizePlugin({ db: undefined as never, config });
    (plugin as Plugin).install(w.hooks);
  };

  it("R9-hist S6 AC5: delegationOnly:false => no tier S in the table, in-run replay still happens, tier T persisted, next task replays tier T only", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two")]));
    install(w, { delegationOnly: false });
    const env = openEnv(w);

    expect((await runTask(env, "first")).status).toBe("completed");
    // In-run: the tool loop's second request replays the full turn including the server pairs.
    expect(typesOnWire(w.fake.bodies()[1] as IMessagesRequestBody)).toEqual(expect.arrayContaining(SERVER_TYPES));
    // Stored: tier T only.
    const rows = echoRows(env.sqlite);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.server_bytes).toBe(0);
      expect(rowTypes(r).some((t) => SERVER_TYPES.includes(t))).toBe(false);
      expect(r.blocks).not.toContain(PAGE);
    }
    expect(rows.flatMap(rowTypes)).toEqual(expect.arrayContaining(["thinking", "text", "tool_use"]));

    setMinute(1); // well inside the TTL: the absence is the veto, not expiry
    expect((await runTask(env, "second")).status).toBe("completed");
    const wire = w.fake.bodies()[2] as IMessagesRequestBody;
    expect(hasServerBlocks(wire)).toBe(false);
    expect(signaturesOnWire(wire)).toEqual([SIG]);
    noFaults(w);
  });

  it("R9-hist S6 AC5: the default plugin config (delegationOnly:true) stores tier S as before", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one")]));
    install(w, {});
    const env = openEnv(w);
    await runTask(env, "first");
    expect(echoRows(env.sqlite).some((r) => r.server_bytes > 0 && rowTypes(r).includes("web_fetch_tool_result"))).toBe(true);
    noFaults(w);
  });
});

// ================================================================================================================
describe("R9-hist S6 AC6: no signature, page text or encrypted_content outside the echo table", () => {
  it("R9-hist S6 AC6: after a run with sentinels, messages, task events, hook payloads and logs carry none; the echo table does (teeth)", async () => {
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), pause(0, "SIG-P2"), answer("answer two")]));
    const env = openEnv(w);
    const consoleErrors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void consoleErrors.push(JSON.stringify(args)));
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void consoleErrors.push(JSON.stringify(args)));
    const emittedTaskEvents: string[] = [];
    env.deps.emitTaskEvent = (e) => emittedTaskEvents.push(JSON.stringify(e));

    await runTask(env, "first");
    setMinute(1);
    await runTask(env, "second");

    // Teeth: the sentinels are really in play - on the wire and in the echo table - so their absence elsewhere means something.
    const table = echoRows(env.sqlite)
      .map((r) => r.blocks)
      .join("\n");
    for (const needle of [SIG, PAGE, ENC]) expect(table).toContain(needle);
    expect(JSON.stringify(w.fake.bodies())).toContain(SIG);

    const events = taskEvents(env.sqlite).map((e) => `${e.type} ${e.payload ?? ""}`);
    const messages = (env.sqlite.prepare("SELECT * FROM messages").all() as unknown[]).map((r) => JSON.stringify(r));
    const hookPayloads = w.hooks.emitted.map((e) => `${e.event} ${e.json}`);
    const logs = w.log.logs.map((l) => l.json);
    const corpus = [...events, ...messages, ...hookPayloads, ...logs, ...emittedTaskEvents, ...consoleErrors].join("\n");

    expect(corpus.length).toBeGreaterThan(2000);
    expect(hookPayloads.some((p) => p.startsWith("message:appended"))).toBe(true);
    expect(hookPayloads.some((p) => p.startsWith("post:model_response"))).toBe(true);
    for (const needle of [SIG, PAGE, ENC, "SIG-P2", "encrypted_content"]) expect(corpus).not.toContain(needle);
    expect(corpus).not.toMatch(/"signature"\s*:/);
    expect(corpus).not.toMatch(/"thinking"\s*:/);
    noFaults(w);
  });
});

// ================================================================================================================
describe("R9-hist S6 AC7: echo storage failure never fails a task", () => {
  const expectOneWarn = (env: IEnv, consoleError: { mock: { calls: unknown[][] } }): void => {
    const storeWarns = consoleError.mock.calls.filter((c: unknown[]) => String(c[0]).includes(ECHO_WARN)).length;
    expect(storeWarns + env.world.log.warnsAbout(ECHO_WARN)).toBe(1);
  };

  it("R9-hist S6 AC7: the echo table dropped mid-session => later tasks complete on legacy history with exactly one WARN", async () => {
    vi.resetModules();
    const fresh = await vi.importActual<typeof schema>("@adhd/agent-store-runtime"); // a fresh module instance has a fresh once-flag
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two"), answer("answer three")]), {
      fake: { allowThinkingOmission: ({ index }) => index >= 2 }, // legacy history omits thinking by design
    });
    const env = openEnv(w, undefined, fresh.SessionStore);
    expect((await runTask(env, "first")).status).toBe("completed");
    expect(echoRows(env.sqlite).length).toBeGreaterThan(0);

    env.sqlite.exec("DROP TABLE message_provider_echo");
    setMinute(1);
    const second = await runTask(env, "second");
    setMinute(2);
    const third = await runTask(env, "third");
    expect([second.status, third.status]).toEqual(["completed", "completed"]);
    expect(second.result).toBe("answer two");

    for (const i of [2, 3]) {
      const wire = w.fake.bodies()[i] as IMessagesRequestBody;
      expect(typesOnWire(wire)).not.toContain("thinking"); // legacy history
      expect(hasServerBlocks(wire)).toBe(false);
    }
    expectOneWarn(env, consoleError);
    noFaults(w);
  });

  it("R9-hist S6 AC7: a corrupt blocks row mid-session => the next task completes without that echo, with one WARN that never quotes the content", async () => {
    vi.resetModules();
    const fresh = await vi.importActual<typeof schema>("@adhd/agent-store-runtime");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const w = makeWorld(byIndex([toolTurn(1), answer("answer one"), answer("answer two")]), {
      fake: { allowThinkingOmission: ({ index }) => index >= 2 },
    });
    const env = openEnv(w, undefined, fresh.SessionStore);
    await runTask(env, "first");
    env.sqlite.prepare("UPDATE message_provider_echo SET blocks = ?").run(`{"not json ${PAGE}`);

    setMinute(1);
    expect((await runTask(env, "second")).status).toBe("completed");
    expectOneWarn(env, consoleError);
    const everything = [...consoleError.mock.calls.map((c) => JSON.stringify(c)), ...w.log.logs.map((l) => l.json)].join("\n");
    expect(everything).not.toContain(PAGE);
    noFaults(w);
  });
});

// ================================================================================================================
describe("R9-hist S6 AC8: compaction", () => {
  const PRIOR = 7;
  const priorSig = (i: number): string => `SIG-PRIOR-${i}`;

  it("R9-hist S6 AC8: the summariser request carries no echoed blocks, and compacted messages are not replayed afterwards", async () => {
    let summarisers = 0;
    const mainSteps: FakeStep[] = [
      ...Array.from({ length: PRIOR }, (_, i) => answer(`prior ${i}`, { sig: priorSig(i), ...(i === 0 ? { fetch: 0 } : {}) })),
      toolTurn(9, "SIG-CURRENT", { input_tokens: 800_000, output_tokens: 5 }), // reports a nearly full 1M window (trigger 0.75) => compaction before the next call
      answer("done after compaction"),
    ];
    const script: FakeScript = (ctx) => {
      if (isSummariser(ctx.body)) {
        summarisers += 1;
        return { blocks: [{ type: "text", text: "summary of earlier turns" }], stopReason: "end_turn" };
      }
      return mainSteps[ctx.index - summarisers] ?? rejection(500, `S6 script exhausted at request ${ctx.index}`);
    };
    // The summariser and everything after it intentionally omit thinking that the fake emitted earlier.
    const w = makeWorld(script, { fake: { allowThinkingOmission: ({ index }) => index > PRIOR } });
    const env = openEnv(w);
    for (let i = 0; i < PRIOR; i++) {
      setMinute(i);
      expect((await runTask(env, `q${i}`)).status).toBe("completed");
    }
    setMinute(PRIOR);
    const last = await runTask(env, "go");
    expect(last.status).toBe("completed");
    expect(last.result).toBe("done after compaction");

    const bodies = w.fake.bodies();
    const summariserBody = bodies.find(isSummariser);
    expect(summariserBody).toBeDefined();
    const flat = JSON.stringify(summariserBody);
    for (const needle of ["signature", "thinking", "server_tool_use", "web_fetch_tool_result", "web_search_tool_result", SIG, PAGE, ENC, ...Array.from({ length: PRIOR }, (_, i) => priorSig(i))]) {
      expect(flat).not.toContain(needle);
    }
    expect(taskEvents(env.sqlite, "CONTEXT_COMPACTED")).toHaveLength(1);

    // Before compaction every prior assistant message was replayed; after it only the verbatim tail is.
    const beforeIdx = bodies.findIndex(isSummariser) - 1;
    expect(signaturesOnWire(bodies[beforeIdx] as IMessagesRequestBody)).toEqual(Array.from({ length: PRIOR }, (_, i) => priorSig(i)));
    const after = bodies[bodies.length - 1] as IMessagesRequestBody;
    expect(signaturesOnWire(after)).toEqual([priorSig(PRIOR - 1), "SIG-CURRENT"]);
    for (let i = 0; i < PRIOR - 1; i++) expect(signaturesOnWire(after)).not.toContain(priorSig(i));
    expect(w.fake.faults).toEqual([]);
    expect(w.fake.rejections()).toEqual([]);
  });
});
