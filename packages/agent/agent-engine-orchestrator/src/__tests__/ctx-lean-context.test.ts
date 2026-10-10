/**
 * 9ed453c1 CTX — lean per-turn context for dispatched agents.
 *
 * Real Orchestrator + real TaskStore (migrated SQLite) + real HookRegistry; only the LLM provider
 * and the MCP registry client are scripted. No sockets, no subprocess.
 *
 *  - AC1: the tool list the provider is handed carries no schema-redundant `pattern` (a uuid /
 *    date-time property keeps its `format`), and the real Zod-generated dispatch-shaped schema stays
 *    under a serialized-size budget. Negative control: the uncompacted schema is over that budget.
 *  - AC2: a result returned through the claudecli bridge seam (`executeTool`) is bounded by the same
 *    BK1 head+tail cap the API path applies. Negative control: with the cap disabled the full result
 *    reaches the CLI (this is what held B at 10.6k tokens of context per turn before).
 */
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import * as schema from "@adhd/agent-store-runtime";
import { TaskStore } from "@adhd/agent-store-runtime";
import type { AgentDefinition, ExecutionContext, Message } from "@adhd/agent-base-types";

import { Orchestrator } from "../engine/orchestrator.js";
import type { OrchestratorSessionStore, OrchestratorTaskStore } from "../engine/orchestrator.js";
import { HookRegistry } from "../engine/hooks.js";
import type { PolicyEngine } from "../engine/policy.js";
import { compactToolDefinitions } from "../engine/tool-schema-compact.js";
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from "../engine/tool-result-cap.js";
import type { EngineConfig } from "../interfaces.js";
import type { LLMProvider, ProviderChatRequest, ProviderChatResponse, ToolDefinition } from "../providers/types.js";
import type { McpClientRegistry } from "../clients/registry.js";
import { generateId } from "../utils/ids.js";
import { nowIso } from "../utils/timestamps.js";
import { createMigratedSqlite } from "./fixtures/real-schema-db.js";

/** A dispatch-shaped Zod 4 schema: uuid + date-time properties, exactly like `task` / `usage_query`. */
const dispatchLikeSchema = z.object({
  session_id: z.string().uuid().optional(),
  depends_on: z.array(z.string().uuid()).optional(),
  task_id: z.string().uuid().optional(),
  since: z.iso.datetime().optional(),
  prompt: z.string().min(1),
});

function dispatchLikeTool(name: string): ToolDefinition {
  const { $schema: _drop, ...rest } = z.toJSONSchema(dispatchLikeSchema) as Record<string, unknown>;
  return { name, description: "dispatch-like tool", inputSchema: rest as ToolDefinition["inputSchema"] };
}

/** Hand-written pattern WITHOUT a known format must survive compaction untouched. */
const KEEP_PATTERN = "^[a-z]{3}-\\d+$";

async function drive(opts: {
  tools: ToolDefinition[];
  toolResult?: string;
  engineToolResultMaxChars?: number;
}): Promise<{ advertised: ToolDefinition[]; bridgeResult: unknown }> {
  const sqlite = createMigratedSqlite();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskId = generateId();
  const sessionId = generateId();
  const agentDefinition: AgentDefinition = {
    name: "ctx-agent",
    version: 1,
    provider: { type: "claudecli", model: "claude-haiku-4-5" },
    systemPrompt: "x",
    mcpServers: {},
    permissions: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  const ctx: ExecutionContext = { taskId, sessionId, agentName: "ctx-agent", agentDefinition, recursionDepth: 0, toolCallCount: 0 };
  const taskStore = new TaskStore(db);
  taskStore.create({ sessionId, prompt: "p", id: taskId });

  let advertised: ToolDefinition[] = [];
  let bridgeResult: unknown;
  const provider: LLMProvider = {
    chat: async (req: ProviderChatRequest): Promise<ProviderChatResponse> => {
      advertised = req.tools ?? [];
      if (req.executeTool) {
        bridgeResult = (await req.executeTool("s", "big", {})).result;
      }
      return {
        message: { id: generateId(), sessionId, role: "assistant", content: "done", createdAt: nowIso() },
        stopReason: "completed",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  const registry = {
    listAllTools: async () => opts.tools.map((t) => ({ ...t })),
    getClient: async () => ({ callTool: async () => opts.toolResult ?? "ok" }),
    closeAll: async () => {},
  } as unknown as McpClientRegistry;
  const msg = (role: Message["role"], content: string): Message => ({ id: generateId(), sessionId, role, content, createdAt: nowIso() });

  await new Orchestrator().run({
    executionContext: ctx,
    messages: [msg("system", "sys"), msg("user", "go")],
    registry,
    provider,
    policy: { check: () => {} } as unknown as PolicyEngine,
    taskStore: taskStore as unknown as OrchestratorTaskStore,
    sessionStore: { appendMessage: async () => {}, close: () => {} } as OrchestratorSessionStore,
    signal: new AbortController().signal,
    taskId,
    hooks: new HookRegistry(),
    ...(opts.engineToolResultMaxChars !== undefined
      ? { config: { server: { contextLimit: 0, defaultMaxTokens: 8192 }, toolResult: { maxChars: opts.engineToolResultMaxChars } } as unknown as EngineConfig }
      : {}),
  });
  sqlite.close();
  return { advertised, bridgeResult };
}

describe("9ed453c1 CTX AC1: schema-lean tool advertisement", () => {
  it("9ed453c1 CTX AC1: Zod emits a uuid/date-time pattern next to format (the redundancy this removes)", () => {
    const raw = JSON.stringify(dispatchLikeTool("t").inputSchema);
    expect(raw).toContain('"format":"uuid"');
    expect(raw).toMatch(/"pattern":"\^\(\?:/);
  });

  it("9ed453c1 CTX AC1: compactToolDefinitions drops the pattern beside a known format, keeps format, keeps unrelated patterns, never mutates", () => {
    const tool: ToolDefinition = {
      name: "t",
      description: "d",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid", pattern: "^UUID-REGEX$" },
          at: { type: "string", format: "date-time", pattern: "^DATE-REGEX$" },
          code: { type: "string", pattern: KEEP_PATTERN },
          odd: { type: "string", format: "x-custom", pattern: "^odd$" },
        },
      },
    };
    const before = JSON.stringify(tool);
    const [out] = compactToolDefinitions([tool]);
    const props = (out?.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    expect(props["id"]).toEqual({ type: "string", format: "uuid" });
    expect(props["at"]).toEqual({ type: "string", format: "date-time" });
    expect(props["code"]).toEqual({ type: "string", pattern: KEEP_PATTERN });
    expect(props["odd"]).toEqual({ type: "string", format: "x-custom", pattern: "^odd$" });
    expect(JSON.stringify(tool)).toBe(before);
  });

  it("9ed453c1 CTX AC1: the provider is handed compacted schemas, under a size budget; the uncompacted schema is over it", async () => {
    const tools = ["task", "tasks_batch", "task_list", "task_resume", "usage_query", "result"].map(dispatchLikeTool);
    const BUDGET_CHARS = 5_500; // 6 dispatch-shaped tools; ~1.7k tokens at 3.2 chars/token
    const rawChars = JSON.stringify(tools).length;
    expect(rawChars).toBeGreaterThan(BUDGET_CHARS); // negative control: pre-CTX size fails the budget

    const { advertised } = await drive({ tools });
    const sent = advertised.filter((t) => t.name.startsWith("s__"));
    expect(sent).toHaveLength(0);
    const names = advertised.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(tools.length);
    const wire = JSON.stringify(advertised);
    expect(wire).not.toMatch(/"pattern":"\^\(\?:/);
    expect(wire).toContain('"format":"uuid"');
    expect(wire.length).toBeLessThan(BUDGET_CHARS);
    expect(wire.length).toBeLessThan(rawChars);
  });
});

describe("9ed453c1 CTX AC2: the claudecli bridge result is bounded by the BK1 cap", () => {
  const BIG = "h".repeat(5_000) + "m".repeat(75_000) + "t".repeat(4_000);

  it("9ed453c1 CTX AC2: an 84 KB result reaches the CLI as head+tail within the default cap (+ marker)", async () => {
    const { bridgeResult } = await drive({ tools: [{ name: "s__big", description: "d", inputSchema: { type: "object", properties: {} } }], toolResult: BIG });
    const s = bridgeResult as string;
    expect(typeof s).toBe("string");
    expect(s.length).toBeLessThan(DEFAULT_TOOL_RESULT_MAX_CHARS + 400);
    expect(s).toContain("[tool result truncated");
    expect(s.startsWith("h")).toBe(true);
    expect(s.endsWith("t")).toBe(true);
    expect(s).not.toContain("m".repeat(1_000));
  });

  it("9ed453c1 CTX AC2: a result under the cap is passed through untouched", async () => {
    const small = "ok-".repeat(100);
    const { bridgeResult } = await drive({ tools: [{ name: "s__big", description: "d", inputSchema: { type: "object", properties: {} } }], toolResult: small });
    expect(bridgeResult).toBe(small);
  });

  it("9ed453c1 CTX AC2 negative control: with the cap disabled (0) the full 84 KB result reaches the CLI", async () => {
    const { bridgeResult } = await drive({
      tools: [{ name: "s__big", description: "d", inputSchema: { type: "object", properties: {} } }],
      toolResult: BIG,
      engineToolResultMaxChars: 0,
    });
    expect((bridgeResult as string).length).toBe(BIG.length);
  });
});

describe("9ed453c1 CACHE: the orchestrator hands every provider a byte-stable tool block", () => {
  const shellTool = (cmds: string[]): ToolDefinition => ({
    name: "shell__shell_execute",
    description: `Execute a shell command\n\nAllowed commands: ${cmds.join(", ")}\nAllowed patterns: `,
    inputSchema: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] },
  });

  it("9ed453c1 CACHE AC4: two tasks whose server rendered the allow-list in different orders advertise identical tools JSON", async () => {
    const a = await drive({ tools: [shellTool(["ls", "cat", "echo", "pwd"])] });
    const b = await drive({ tools: [shellTool(["pwd", "echo", "cat", "ls"])] });
    expect(JSON.stringify(a.advertised)).toBe(JSON.stringify(b.advertised));
    expect(JSON.stringify(a.advertised)).toContain("Allowed commands: cat, echo, ls, pwd");
    // negative control: the raw definitions the registry returned for the two tasks differ
    expect(JSON.stringify(shellTool(["ls", "cat", "echo", "pwd"]))).not.toBe(JSON.stringify(shellTool(["pwd", "echo", "cat", "ls"])));
  });
});
