/**
 * 79aebb26 (plan 9ed453c1-b113-473d-8c35-fc6dc2541306) BK8 -- explicit model resolution and pricing for
 * the claudecli provider. AC8.1 - AC8.5.
 *
 * Real ClaudeCliProvider + real Orchestrator + real HookRegistry + real UsagePlugin + a real SQLite
 * database built from the shipped drizzle migrations (`createMigratedSqlite`). The ONLY replaced boundary
 * is the `claude` process: `child_process.spawn` returns the recorded stream-json transcripts in
 * `./fixtures/claudecli-*.stream.jsonl` (real `claude -p --output-format stream-json` runs, trimmed of
 * hook/command/rate-limit noise; the `init`, `assistant`, `user` and `result` events are verbatim). No
 * live model call is made.
 *
 *  - claudecli-alias-haiku.stream.jsonl: `--model haiku`; the CLI resolved it to `claude-haiku-5-5`
 *    (init.model and result.modelUsage); CLI total_cost_usd 0.02025881.
 *  - claudecli-pinned-haiku-4-5.stream.jsonl: `--model claude-haiku-4-5`; CLI total_cost_usd 0.164319.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import { UsagePlugin } from "../plugins/usage-plugin.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

vi.mock("child_process", () => ({ spawn: vi.fn() }));

const HERE = dirname(fileURLToPath(import.meta.url));
const ALIAS_STREAM = readFileSync(join(HERE, "fixtures/claudecli-alias-haiku.stream.jsonl"), "utf8");
const PINNED_STREAM = readFileSync(join(HERE, "fixtures/claudecli-pinned-haiku-4-5.stream.jsonl"), "utf8");

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
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

type StreamEvent = Record<string, unknown> & { type: string };
const parse = (stream: string): StreamEvent[] =>
  stream.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as StreamEvent);
const serialize = (events: StreamEvent[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

/** Rewrite the terminal `result` event of a recorded stream (everything else stays verbatim). */
function withResult(stream: string, edit: (result: StreamEvent) => void): string {
  const events = parse(stream);
  const result = events.find((e) => e.type === "result");
  if (!result) throw new Error("fixture has no result event");
  edit(result);
  return serialize(events);
}

interface ITaskUsageRow {
  model: string;
  requested_model: string | null;
  response_model: string | null;
  est_cost_usd: number | null;
  priced_cost_usd: number | null;
  unpriced_tokens: number | null;
  cost_status: string | null;
  cost_basis: string | null;
  pricing_ref: string | null;
  cli_reported_cost_usd: number | null;
  model_breakdown_json: string | null;
}

/** Replay `stream` through the real provider, orchestrator and UsagePlugin; return the persisted row + spawn argv. */
async function replay(opts: { configuredModel: string; stream: string }) {
  const { spawn } = await import("child_process");
  const stdout = new Readable({ read() {} });
  const proc = {
    stdout,
    stdin: { write: () => true, end: () => {} },
    stderr: new Readable({ read() {} }),
    on: () => {},
    kill: () => {},
    exitCode: 0 as number | null,
    killed: false,
  };
  queueMicrotask(() => {
    stdout.push(opts.stream);
    stdout.push(null);
  });
  const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;
  spawnMock.mockReset();
  spawnMock.mockReturnValue(proc);

  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "bk8-agent",
    version: 1,
    provider: { type: "claudecli", model: opts.configuredModel },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = {
    taskId,
    sessionId,
    agentName: "bk8-agent",
    agentDefinition,
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  new UsagePlugin(db, logger).install(hooks);

  const { ClaudeCliProvider } = await import("../providers/claudecli.js");
  const provider = new ClaudeCliProvider(
    { type: "claudecli", model: opts.configuredModel },
    {},
    undefined,
    engineConfig,
    logger
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
  const row = sqlite.prepare("SELECT * FROM task_usage WHERE task_id = ?").get(taskId) as ITaskUsageRow;
  const argv = (spawnMock.mock.calls[0]?.[1] ?? []) as string[];
  sqlite.close();
  return { row, argv };
}

const HAIKU_5_5_A0_CLI_COST = 0.02025881;
const HAIKU_4_5_A1_CLI_COST = 0.164319;

describe("79aebb26 BK8 AC8.1: an alias model is resolved from what the CLI reports", () => {
  it("79aebb26 AC8.1: `--model haiku` is sent verbatim, task_usage.model is the resolved claude-haiku-5-5, the alias is kept in requested_model", async () => {
    const { row, argv } = await replay({ configuredModel: "haiku", stream: ALIAS_STREAM });
    expect(argv[argv.indexOf("--model") + 1]).toBe("haiku");
    expect(row.model).toBe("claude-haiku-5-5");
    expect(row.requested_model).toBe("haiku");
    expect(row.response_model).toBe("claude-haiku-5-5");
  });

  it("79aebb26 AC8.1 + AC8.5: the A0 run is priced against the RESOLVED haiku-5-5 card and reproduces the CLI's own total_cost_usd", async () => {
    const { row } = await replay({ configuredModel: "haiku", stream: ALIAS_STREAM });
    expect(row.cost_status).toBe("priced");
    expect(row.cost_basis).toBe("vendor-direct");
    expect(row.pricing_ref).toBe("rate-card:claude_haiku_5_5");
    // 8 digits: the rate-card figure IS the CLI figure. Priced at haiku-4-5's card this would be ~0.2, not 0.0203.
    expect(row.est_cost_usd).toBeCloseTo(HAIKU_5_5_A0_CLI_COST, 8);
    expect(row.priced_cost_usd).toBeCloseTo(HAIKU_5_5_A0_CLI_COST, 8);
    expect(row.unpriced_tokens).toBe(0);
    // The CLI figure is stored beside the estimate as an informational cross-check.
    expect(row.cli_reported_cost_usd).toBeCloseTo(HAIKU_5_5_A0_CLI_COST, 8);
  });

  it("79aebb26 AC8.1: with no modelUsage the resolved id falls back to the init event's model", async () => {
    const stream = withResult(ALIAS_STREAM, (r) => {
      delete r["modelUsage"];
    });
    const { row } = await replay({ configuredModel: "haiku", stream });
    expect(row.model).toBe("claude-haiku-5-5");
    expect(row.requested_model).toBe("haiku");
    expect(row.cost_status).toBe("priced");
    expect(row.est_cost_usd).toBeCloseTo(HAIKU_5_5_A0_CLI_COST, 8);
  });

  it("79aebb26 AC8.1: the recorded alias breakdown is persisted (model, tokens, per-model pricing)", async () => {
    const { row } = await replay({ configuredModel: "haiku", stream: ALIAS_STREAM });
    const breakdown = JSON.parse(row.model_breakdown_json ?? "[]") as Array<Record<string, unknown>>;
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]).toMatchObject({
      model: "claude-haiku-5-5",
      uncachedInputTokens: 8,
      cacheReadTokens: 290221,
      cacheCreationTokens: 85269,
      cacheCreation1hTokens: 85269,
      outputTokens: 604,
      costStatus: "priced",
    });
  });
});

describe("79aebb26 BK8 AC8.3 / AC8.4: a pinned concrete id is honoured and priced", () => {
  it("79aebb26 AC8.4: the pinned claude-haiku-4-5 stream resolves to claude-haiku-4-5 and prices at its own card (== CLI total_cost_usd)", async () => {
    const { row, argv } = await replay({ configuredModel: "claude-haiku-4-5", stream: PINNED_STREAM });
    expect(argv[argv.indexOf("--model") + 1]).toBe("claude-haiku-4-5");
    expect(row.model).toBe("claude-haiku-4-5");
    expect(row.requested_model).toBe("claude-haiku-4-5");
    expect(row.cost_status).toBe("priced");
    expect(row.pricing_ref).toBe("rate-card:claude_haiku_4_5");
    expect(row.est_cost_usd).toBeCloseTo(HAIKU_4_5_A1_CLI_COST, 6);
    expect(row.cli_reported_cost_usd).toBeCloseTo(HAIKU_4_5_A1_CLI_COST, 6);
  });

  it("79aebb26 AC8.3: A0 has more tokens than A1 yet costs ~8x less (the 'anomaly' is the haiku-5-5 price basis, not a bug)", async () => {
    const pinned = await replay({ configuredModel: "claude-haiku-4-5", stream: PINNED_STREAM });
    const alias = await replay({ configuredModel: "haiku", stream: ALIAS_STREAM });
    expect(alias.row.est_cost_usd ?? 0).toBeLessThan((pinned.row.est_cost_usd ?? 0) / 5);
  });
});

describe("79aebb26 BK8 AC8.2: a resolved id with no rate card is unpriced, never priced at another model's rate", () => {
  const unknownId = "claude-haiku-9-9";
  const unknownStream = (): string =>
    withResult(ALIAS_STREAM, (r) => {
      const usage = r["modelUsage"] as Record<string, unknown>;
      r["modelUsage"] = { [unknownId]: usage["claude-haiku-5-5"] };
    });

  it("79aebb26 AC8.2: cost_status is unpriced_model, est_cost_usd is NULL, the reason is recorded and the CLI figure is kept", async () => {
    const { row } = await replay({ configuredModel: "haiku", stream: unknownStream() });
    expect(row.model).toBe(unknownId);
    expect(row.requested_model).toBe("haiku");
    expect(row.cost_status).toBe("unpriced_model");
    expect(row.est_cost_usd).toBeNull();
    expect(row.priced_cost_usd).toBe(0);
    expect(row.unpriced_tokens).toBeGreaterThan(0);
    expect(row.cli_reported_cost_usd).toBeCloseTo(HAIKU_5_5_A0_CLI_COST, 8);
    const breakdown = JSON.parse(row.model_breakdown_json ?? "[]") as Array<Record<string, unknown>>;
    expect(breakdown[0]?.["unpricedReason"]).toContain(unknownId);
  });
});

describe("79aebb26 BK8: several modelUsage keys are each priced at their own card and summed", () => {
  it("79aebb26 AC8.1: model is the key with the most tokens, all keys are recorded, cost is the per-key sum", async () => {
    const stream = withResult(ALIAS_STREAM, (r) => {
      r["modelUsage"] = {
        "claude-haiku-5-5": {
          inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 0, costUSD: 0.001,
        },
        "claude-haiku-4-5": {
          inputTokens: 100_000, outputTokens: 10_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.15,
        },
      };
      r["usage"] = { ...(r["usage"] as object), cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } };
    });
    const { row } = await replay({ configuredModel: "haiku", stream });
    expect(row.model).toBe("claude-haiku-4-5"); // 110_000 tokens vs 13_000
    const breakdown = JSON.parse(row.model_breakdown_json ?? "[]") as Array<{ model: string }>;
    expect(breakdown.map((b) => b.model).sort()).toEqual(["claude-haiku-4-5", "claude-haiku-5-5"]);
    // haiku-5-5: (1000*0.10 + 2000*0.50 + 10000*0.01)/1e6 = 0.0012 ; haiku-4-5: (100000*1 + 10000*5)/1e6 = 0.15
    expect(row.est_cost_usd).toBeCloseTo(0.0012 + 0.15, 9);
    expect(row.cost_status).toBe("priced");
  });

  it("79aebb26 AC8.2: one unpriced key among priced ones leaves est_cost_usd NULL, status partial, and still reports the priced portion", async () => {
    const stream = withResult(ALIAS_STREAM, (r) => {
      r["modelUsage"] = {
        "claude-haiku-5-5": {
          inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 10_000, cacheCreationInputTokens: 0,
        },
        "claude-mystery-1": {
          inputTokens: 500, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
        },
      };
    });
    const { row } = await replay({ configuredModel: "haiku", stream });
    expect(row.cost_status).toBe("partial");
    expect(row.est_cost_usd).toBeNull();
    expect(row.priced_cost_usd).toBeCloseTo(0.0012, 9);
    expect(row.unpriced_tokens).toBe(1000);
  });
});
