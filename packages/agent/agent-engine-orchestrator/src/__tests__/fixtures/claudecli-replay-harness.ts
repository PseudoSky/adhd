/**
 * Shared unit scaffold (r2-measure bucket: debd934d / afa37093 / 8333f755): replay a recorded or crafted
 * `claude -p --output-format stream-json` transcript through the REAL `ClaudeCliProvider`, `Orchestrator`,
 * `HookRegistry`, `UsagePlugin` and a real SQLite database built from the shipped drizzle migrations.
 * Only `child_process.spawn` is replaced (the calling test file must `vi.mock("child_process", ...)`);
 * no process runs and no model is called. Subprocess proofs live in the e2e lane (ADR-0009).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../../engine/orchestrator.js";
import { HookRegistry } from "../../engine/hooks.js";
import { UsagePlugin } from "../../plugins/usage-plugin.js";
import type { PolicyEngine } from "../../engine/policy.js";
import type { McpClientRegistry } from "../../clients/registry.js";
import type { EngineConfig, EngineLogger } from "../../interfaces.js";
import { TripRegistry, type RetryRuntime } from "../../providers/provider-failure.js";
import { generateId } from "../../utils/ids.js";
import { nowIso } from "../../utils/timestamps.js";
import { createMigratedSqlite } from "./real-schema-db.js";
import { FakeClock } from "./fake-clock.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const fixture = (name: string): string => readFileSync(join(HERE, name), "utf8");

export type StreamEvent = Record<string, unknown> & { type: string };
export const parseStream = (stream: string): StreamEvent[] =>
  stream.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as StreamEvent);
export const serializeStream = (events: StreamEvent[]): string =>
  events.map((e) => JSON.stringify(e)).join("\n") + "\n";

export const silentLogger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const engineConfig = {
  server: { contextLimit: 0, defaultMaxTokens: 8192 },
  queue: { concurrency: 1 },
  sse: { baseUrl: "http://localhost:0" },
  plugins: { entries: [] },
  getProviderConfig: () => ({ secret: "sk-test", model: "m" }),
  subprocessEnv: () => ({}),
  resolveEnvName: () => undefined,
  isEnvNameAllowed: () => true,
} as unknown as EngineConfig;

export interface IReplayResult {
  /** `undefined` when the run completed; the thrown error when it failed. */
  error: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  sqlite: ReturnType<typeof createMigratedSqlite>;
  taskId: string;
  taskStatus: () => string | undefined;
  modelResponseEvents: () => Array<Record<string, unknown>>;
  close: () => void;
}

/** Replay `stream` (one spawn). Never rejects: a failing run is reported in `error`. */
export async function replayStream(stream: string, configuredModel = "claude-haiku-4-5"): Promise<IReplayResult> {
  const { spawn } = await import("child_process");
  // The calling test file `vi.mock`s child_process, so `spawn` is a vitest mock fn (typed structurally: no vitest import here).
  const spawnMock = spawn as unknown as { mockReset(): void; mockImplementation(impl: () => unknown): void };
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const stdout = new Readable({ read() {} });
    queueMicrotask(() => {
      stdout.push(stream);
      stdout.push(null);
    });
    return {
      stdout,
      stdin: { write: () => true, end: () => {} },
      stderr: new Readable({ read() {} }),
      on: () => {},
      once: () => {},
      kill: () => {},
      exitCode: 0 as number | null,
      killed: false,
    };
  });

  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "r2-agent",
    version: 1,
    provider: { type: "claudecli", model: configuredModel },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = {
    taskId,
    sessionId,
    agentName: "r2-agent",
    agentDefinition,
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  new UsagePlugin(db, silentLogger).install(hooks);

  const { ClaudeCliProvider } = await import("../../providers/claudecli.js");
  const retryRuntime: RetryRuntime = { clock: new FakeClock(), rng: () => 0, registry: new TripRegistry() };
  const provider = new ClaudeCliProvider(
    { type: "claudecli", model: configuredModel }, {}, undefined, engineConfig, silentLogger, undefined, { retryRuntime }
  );
  const userMessage: Message = { id: generateId(), sessionId, role: "user", content: "hello", createdAt: nowIso() };
  const sessionStore: OrchestratorSessionStore = { appendMessage: async () => {}, close: () => {} };
  const registry = {
    listAllTools: async () => [],
    closeAll: async () => {},
    getClient: async () => {
      throw new Error("no tool calls expected");
    },
  } as unknown as McpClientRegistry;
  let error: unknown;
  try {
    await new Orchestrator().run({
      executionContext: ctx,
      messages: [userMessage],
      registry,
      provider,
      policy: { check: () => {} } as unknown as PolicyEngine,
      taskStore: taskStore as unknown as OrchestratorTaskStore,
      sessionStore,
      signal: new AbortController().signal,
      taskId,
      hooks,
    });
  } catch (e) {
    error = e;
  }
  return {
    error,
    db,
    sqlite,
    taskId,
    taskStatus: () => (sqlite.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string } | undefined)?.status,
    modelResponseEvents: () =>
      (sqlite.prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'MODEL_RESPONSE' ORDER BY created_at, rowid").all(taskId) as Array<{ payload: string | null }>)
        .map((r) => JSON.parse(r.payload ?? "{}") as Record<string, unknown>),
    close: () => sqlite.close(),
  };
}
