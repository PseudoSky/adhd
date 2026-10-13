/**
 * Shared harness for the R10 S4 tests: drives ONE tool call through the real `Orchestrator` with the real host
 * hooks (`createHostHooks`), a real `TaskStore` on a migrated sqlite, and the real native-tooling resolver for the
 * agent's `fs` / `shell` server configs. Only the LLM boundary (the provider; optionally a REAL provider over a
 * capturing `wire.fetch`) and the MCP client boundary (what `fs` / `shell` return) are scripted. Not a test file.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import type { ExecutionContext, McpServerConfig, Message } from "@adhd/agent-base-types";
import { resolveNativeToolingMap } from "@adhd/agent-core-native-tooling";
import { HookRegistry, Orchestrator, type LLMProvider } from "@adhd/agent-engine-orchestrator";
import * as schema from "@adhd/agent-store-runtime";
import { TaskStore, taskEventsTable } from "@adhd/agent-store-runtime";
import type { LogChannel } from "@adhd/agent-plugin-tracing";

import { createHostHooks } from "../host-hooks.js";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const opsChannel = { logEvent: () => undefined } as unknown as LogChannel;
export const scratch = mkdtempSync(join(tmpdir(), "r10-s4-"));
export const openDbs: Database.Database[] = [];

export const catalogServers = (): Record<string, McpServerConfig> =>
  resolveNativeToolingMap({ fs: true, shell: true, dispatch: false }, { cwd: scratch, sandbox: false });
export const sandboxedServers = (): Record<string, McpServerConfig> =>
  resolveNativeToolingMap({ fs: true, shell: true, dispatch: false }, { cwd: scratch, sandbox: true });
export const customFs: McpServerConfig = { transport: "stdio", command: "node", args: ["/opt/my-own-fs-server.js", scratch] } as McpServerConfig;

export interface IRun {
  /** What the provider received on its second call (the request after the tool turn). */
  secondRequest: Message[];
  /** Messages the session store persisted, serialized at append time. */
  stored: string[];
  postPayloads: Array<{ result: unknown; noteAppended?: boolean; isError: boolean }>;
  appended: string[];
  observedRequest: string;
  toolResultEvent: string;
}

/** Drive one tool call through the real orchestrator with the host hooks (or a bare registry). */
export async function runCall(opts: {
  server: string;
  tool: string;
  args: unknown;
  /** What the scripted MCP client returns; a string makes it throw an Error with that message (a tool error). */
  returns: unknown;
  throws?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  hostHooks?: boolean;
  /** Build a provider instead of the scripted one (e.g. a real adapter over a capturing wire.fetch). */
  makeProvider?: (info: { sessionId: string }) => LLMProvider;
}): Promise<IRun> {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  openDbs.push(sqlite);
  migrate(drizzle(sqlite), { migrationsFolder: MIGRATIONS });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = drizzle(sqlite, { schema }) as any;
  const taskStore = new TaskStore(db);
  const taskId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  taskStore.create({ sessionId, prompt: "p", id: taskId });
  const ctx = {
    taskId,
    sessionId,
    agentName: "notes-agent",
    agentDefinition: {
      name: "notes-agent",
      version: 1,
      systemPrompt: "",
      mcpServers: opts.mcpServers ?? catalogServers(),
      permissions: {},
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    selection: { providerType: "openai", modelRef: "notes-test-model" },
    wireModel: "notes-test-model",
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;

  const hooks = opts.hostHooks === false ? new HookRegistry() : createHostHooks(taskStore, opsChannel);
  const postPayloads: IRun["postPayloads"] = [];
  const appended: string[] = [];
  let observedRequest = "";
  hooks.register("post:tool_call", (p) => {
    postPayloads.push({ result: p.result, noteAppended: p.noteAppended, isError: p.isError });
  });
  hooks.register("message:appended", (p) => {
    appended.push(JSON.stringify(p.message));
  });
  hooks.register("pre:model_request", (p) => {
    observedRequest = JSON.stringify(p.messages);
  });

  const requests: Message[][] = [];
  const stored: string[] = [];
  let calls = 0;
  const provider: LLMProvider = opts.makeProvider?.({ sessionId }) ?? ({
    chat: async (req: { messages: Message[] }) => {
      calls += 1;
      requests.push([...req.messages]);
      return calls === 1
        ? ({
            message: {
              id: crypto.randomUUID(),
              sessionId,
              role: "assistant",
              toolCalls: [{ id: "call-1", server: opts.server, tool: opts.tool, arguments: opts.args }],
              createdAt: new Date().toISOString(),
            },
            stopReason: "tool_calls",
          } as never)
        : ({
            message: { id: crypto.randomUUID(), sessionId, role: "assistant", content: "done", createdAt: new Date().toISOString() },
            stopReason: "completed",
          } as never);
    },
  } as unknown as LLMProvider);
  const registry = {
    listAllTools: async () => [
      { name: `${opts.server}__${opts.tool}`, description: "", inputSchema: { type: "object", properties: {} } },
    ],
    getClient: async () => ({
      callTool: async () => {
        if (opts.throws) throw new Error(String(opts.returns));
        return opts.returns;
      },
    }),
    closeAll: async () => undefined,
  };
  await new Orchestrator().run({
    executionContext: ctx,
    messages: [{ id: crypto.randomUUID(), sessionId, role: "user", content: "go", createdAt: new Date().toISOString() }],
    registry: registry as never,
    provider,
    policy: { check: () => undefined } as never,
    taskStore: taskStore as never,
    sessionStore: {
      appendMessage: async (_sid: string, m: Message) => {
        stored.push(JSON.stringify(m));
      },
      close: () => undefined,
    } as never,
    signal: new AbortController().signal,
    taskId,
    hooks,
  });
  const ev = db
    .select()
    .from(taskEventsTable)
    .where(eq(taskEventsTable.taskId, taskId))
    .all()
    .filter((r: { type: string }) => r.type === "TOOL_RESULT")
    .map((r: { payload: string | null }) => r.payload ?? "")
    .join("\n");
  return { secondRequest: requests[1], stored, postPayloads, appended, observedRequest, toolResultEvent: ev };
}

