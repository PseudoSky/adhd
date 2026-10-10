/**
 * 1f1c8598 (G1) S3 — provider response-model capture and orchestrator plumbing.
 *
 * Drives the REAL OpenAIProvider / AnthropicProvider / ClaudeCliProvider and the REAL
 * Orchestrator + HookRegistry + TaskStore (in-memory better-sqlite3). The only mocked
 * boundaries are the external ones: the `openai` / `@anthropic-ai/sdk` clients (their
 * network call) and `child_process.spawn` for the claude CLI. No sockets are bound.
 *
 * The `task_usage.response_model` column (the other half of FS1-AC1) is written by
 * UsagePlugin in segment S4a; this file proves the capture and hook/event payload half.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Readable } from "stream";
import { describe, expect, it, vi } from "vitest";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message, PostModelResponsePayload } from "@adhd/agent-base-types";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import type { PolicyEngine } from "../engine/policy.js";
import type { McpClientRegistry } from "../clients/registry.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse } from "../providers/types.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";

const sdk = vi.hoisted(() => ({
  openaiResponse: undefined as unknown,
  anthropicResponse: undefined as unknown,
}));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: async () => sdk.openaiResponse } };
  }
  return { default: FakeOpenAI };
});

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { stream: () => ({ finalMessage: async () => sdk.anthropicResponse }) };
  }
  return { default: FakeAnthropic };
});

vi.mock("child_process", () => ({ spawn: vi.fn() }));

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

const request: ProviderChatRequest = {
  messages: [{ role: "user", content: "hi" } as ProviderChatRequest["messages"][number]],
};

describe("1f1c8598 FS1-AC1: providers report the response model", () => {
  it("1f1c8598 FS1-AC1: OpenAIProvider surfaces response.model as responseModel (configured model stays the alias)", async () => {
    sdk.openaiResponse = {
      model: "deepseek-v4-flash-0731",
      choices: [{ message: { content: "ok", tool_calls: undefined }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ type: "openai", model: "deepseek-flash" }, engineConfig);
    const res = await provider.chat(request);
    expect(res.responseModel).toBe("deepseek-v4-flash-0731");
  });

  it("1f1c8598 FS1-AC1: OpenAIProvider leaves responseModel undefined when the response has no model", async () => {
    sdk.openaiResponse = {
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    };
    const { OpenAIProvider } = await import("../providers/openai.js");
    const provider = new OpenAIProvider({ type: "openai", model: "deepseek-flash" }, engineConfig);
    const res = await provider.chat(request);
    expect(res.responseModel).toBeUndefined();
  });

  it("1f1c8598 FS1-AC1: AnthropicProvider surfaces Message.model as responseModel", async () => {
    sdk.anthropicResponse = {
      model: "claude-sonnet-4-6-20260101",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const { AnthropicProvider } = await import("../providers/anthropic.js");
    const provider = new AnthropicProvider({ type: "anthropic", model: "claude-sonnet-4-6" }, engineConfig, logger);
    const res = await provider.chat(request);
    expect(res.responseModel).toBe("claude-sonnet-4-6-20260101");
  });

  it("1f1c8598 FS1-AC1 / 79aebb26 AC8.1: ClaudeCliProvider surfaces the concrete id from result.modelUsage as responseModel (shape now verified by the recorded fixtures)", async () => {
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
      stdout.push(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          result: "OK",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          // Shape verified against the recorded claudecli-*.stream.jsonl fixtures (79aebb26 BK8).
          modelUsage: { "claude-haiku-4-5-20251001": { inputTokens: 1, outputTokens: 1 } },
        }) + "\n"
      );
      stdout.push(null);
    });
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(proc);
    const { ClaudeCliProvider } = await import("../providers/claudecli.js");
    const provider = new ClaudeCliProvider(
      { type: "claudecli", model: "claude-haiku-4-5" },
      {},
      undefined,
      engineConfig,
      logger
    );
    const res = await provider.chat(request);
    expect(res.message.content).toBe("OK");
    expect(res.responseModel).toBe("claude-haiku-4-5-20251001");
  });
});

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY NOT NULL, session_id TEXT, parent_task_id TEXT,
  is_ephemeral INTEGER DEFAULT 0 NOT NULL, recursion_depth INTEGER DEFAULT 0 NOT NULL,
  status TEXT DEFAULT 'pending' NOT NULL, prompt TEXT NOT NULL, result TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, cancelled_at TEXT,
  depends_on TEXT, on_upstream_failure TEXT, inputs TEXT, resume_token TEXT, cwd TEXT
);
CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, type TEXT NOT NULL,
  payload TEXT, created_at TEXT NOT NULL
);
`;

async function runOneTurn(responseModel: string | undefined) {
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_TABLES_SQL);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "rm-agent",
    version: 1,
    provider: { type: "openai", model: "deepseek-flash" },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = {
    taskId,
    sessionId,
    agentName: "rm-agent",
    agentDefinition,
    recursionDepth: 0,
    toolCallCount: 0,
  };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const hooks = new HookRegistry();
  const payloads: PostModelResponsePayload[] = [];
  hooks.register("post:model_response", (p: PostModelResponsePayload) => {
    payloads.push(p);
  });
  const provider: LLMProvider = {
    chat: async (): Promise<ProviderChatResponse> => ({
      message: { id: generateId(), sessionId, role: "assistant", content: "done", createdAt: nowIso() },
      stopReason: "completed",
      usage: { inputTokens: 10, outputTokens: 2 },
      responseModel,
    }),
  };
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
  const events = sqlite
    .prepare("SELECT payload FROM task_events WHERE task_id = ? AND type = 'MODEL_RESPONSE'")
    .all(taskId) as Array<{ payload: string }>;
  return { payloads, events: events.map((e) => JSON.parse(e.payload) as Record<string, unknown>) };
}

describe("1f1c8598 FS1-AC1: orchestrator plumbs responseModel to the hook and the MODEL_RESPONSE event", () => {
  it("1f1c8598 FS1-AC1: post:model_response payload carries responseModel while the configured model stays the alias", async () => {
    const { payloads } = await runOneTurn("deepseek-v4-flash-0731");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.responseModel).toBe("deepseek-v4-flash-0731");
    expect(payloads[0]?.executionContext?.agentDefinition?.provider?.model).toBe("deepseek-flash");
  });

  it("1f1c8598 FS1-AC1: MODEL_RESPONSE task event payload carries responseModel (turn-grain read path)", async () => {
    const { events } = await runOneTurn("deepseek-v4-flash-0731");
    expect(events).toHaveLength(1);
    expect(events[0]?.["responseModel"]).toBe("deepseek-v4-flash-0731");
  });

  it("1f1c8598 FS1-AC1: absent responseModel stays absent on both the hook and the event (no behavior change)", async () => {
    const { payloads, events } = await runOneTurn(undefined);
    expect(payloads[0]?.responseModel).toBeUndefined();
    expect(events[0]?.["responseModel"]).toBeUndefined();
  });
});
