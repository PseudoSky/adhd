/**
 * cafe9a17 AC1 (residual): the shell policy-rejection note a model reads names only commands the agent's EFFECTIVE
 * shell server allows, on every adapter the host tool-result path reaches.
 *
 * Adapter table (the note is applied by an enforcement handler on `pre:model_request`, so it can only reach an
 * adapter whose request is built from the engine's history; a2a9c6db AC2 / `tool-result-notes.ts` module header):
 *
 *   anthropic                       reached     real `AnthropicProvider` over a capturing `wire.fetch`
 *   openai-compatible (DeepSeek)    reached     real `OpenAIProvider` over a capturing `wire.fetch`
 *   claudecli                       NOT reached the CLI runs its own loop; bridged `executeTool` calls get no note
 *                                               and `noteAppended` stays unset (driven below, asserting absence)
 *
 * Real: `Orchestrator`, the host hook registry (`createHostHooks`), the real native-tooling resolver that
 * produces the agent's `mcpServers`, a migrated sqlite `TaskStore`. Scripted: the model's replies and the MCP
 * result (a policy rejection). No network, no process.
 *
 * guards: the shell policy-rejection note tells the model to use a runner the agent's effective shell server would itself
 *   reject (default catalog, overridden or empty allowlist, custom shell, unreadable config), or a claudecli bridge call
 *   receives a note at all.
 * tier: S (in-process real Orchestrator, providers and sqlite store over a capturing wire.fetch; no process, no network)
 * cites: cafe9a17 AC1.
 */
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig, NativeToolingConfig } from "@adhd/agent-base-types";
import { resolveNativeToolingMap } from "@adhd/agent-core-native-tooling";
import {
  AnthropicProvider,
  OpenAIProvider,
  type LLMProvider,
  type ProviderChatRequest,
} from "@adhd/agent-engine-orchestrator";

import { openDbs, runCall, scratch } from "../helpers/r10-s4-harness.js";

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const REJECTION =
  "Tool 'shell_execute' on server 'shell' returned an error: [{\"type\":\"text\",\"text\":\"Command rejected by default security policy: node\"}]";
const ARGS = { command: ["node", "-e", "1"] };
const ALL_RUNNERS = ["npm", "pnpm", "npx", "nx", "make", "uv"];
type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>> };

const servers = (cfg: NativeToolingConfig): Record<string, McpServerConfig> =>
  resolveNativeToolingMap({ fs: true, shell: true, dispatch: false, ...cfg }, { cwd: scratch, sandbox: false });
const customShell = {
  transport: "stdio",
  command: "my-own-shell-server",
  args: ["--serve"],
  env: { ALLOW_COMMANDS: "npm,pnpm,make" },
} as McpServerConfig;

const sse = (events: Array<[string, unknown]>): Response =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const msgStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };

/** Real AnthropicProvider; turn 1 calls shell__shell_execute, turn 2 answers. */
function anthropicTwoTurns(bodies: Body[]): () => LLMProvider {
  return () => {
    const fetchSeam: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      if (bodies.length === 1) {
        return sse([
          ["message_start", msgStart],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "shell__shell_execute", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(ARGS) } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      }
      return sse([
        ["message_start", msgStart],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
    };
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: { fetch: fetchSeam },
      getProviderConfig: () => ({ secret: "sk-ant-api-test", model: "claude-haiku-5-5" }),
    };
    return new AnthropicProvider({ type: "anthropic", model: "claude-haiku-5-5" } as never, config as never, logger as never);
  };
}

/** Real OpenAIProvider (DeepSeek and every OpenAI-compatible endpoint); turn 1 calls shell__shell_execute, turn 2 answers. */
function openaiTwoTurns(bodies: Body[]): () => LLMProvider {
  return () => {
    const fetchSeam: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const first = bodies.length === 1;
      const message = first
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell__shell_execute", arguments: JSON.stringify(ARGS) } }] }
        : { role: "assistant", content: "done" };
      return new Response(
        JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "deepseek-flash", choices: [{ index: 0, finish_reason: first ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: { fetch: fetchSeam },
      getProviderConfig: () => ({ secret: "sk-test", model: "deepseek-flash", baseURL: "http://localhost:1/v1" }),
    };
    return new OpenAIProvider({ type: "openai", model: "deepseek-flash" } as never, config as never);
  };
}

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b) => (b !== null && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : JSON.stringify(b)))
    .join("\n");
}

/** The tool-result text the model reads in one request body. */
function wireResult(adapter: "anthropic" | "openai", body: Body): string {
  const parts =
    adapter === "openai"
      ? body.messages.filter((m) => m["role"] === "tool").map((m) => flatten(m["content"]))
      : body.messages.flatMap((m) =>
          Array.isArray(m["content"])
            ? (m["content"] as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool_result").map((b) => flatten(b["content"]))
            : []
        );
  expect(parts, "exactly one tool result on the wire").toHaveLength(1);
  return parts[0];
}

/** The runner list the model is told about, or `null` when the note names none. */
const runnersIn = (text: string): string[] | null => {
  const m = /allowed runner \(([^)]*)\)/.exec(text);
  return m ? m[1].split(", ") : null;
};

const FACTORIES = { anthropic: anthropicTwoTurns, openai: openaiTwoTurns } as const;

async function rejectedOn(adapter: "anthropic" | "openai", mcpServers: Record<string, McpServerConfig>) {
  const bodies: Body[] = [];
  const run = await runCall({
    server: "shell",
    tool: "shell_execute",
    args: ARGS,
    returns: REJECTION,
    throws: true,
    mcpServers,
    providerType: adapter,
    makeProvider: FACTORIES[adapter](bodies),
  });
  expect(bodies).toHaveLength(2);
  return { run, text: wireResult(adapter, bodies[1]) };
}

describe.each(["anthropic", "openai"] as const)("cafe9a17 AC1 [%s]: the rejection note names only the effective shell server's runners", (adapter) => {
  it(`cafe9a17 AC1 [${adapter}]: the default catalog shell is told every default runner (the server's own rejection text is kept)`, async () => {
    const { run, text } = await rejectedOn(adapter, servers({}));
    expect(text).toContain("Command rejected by default security policy: node");
    expect(text).toContain("[Note:");
    expect(runnersIn(text)).toEqual(ALL_RUNNERS);
    expect(run.postPayloads.map((p) => p.noteAppended)).toEqual([true]);
  });

  it(`cafe9a17 AC1 [${adapter}]: an overridden allowlist is told only the runners it contains`, async () => {
    const { text } = await rejectedOn(adapter, servers({ shell: { allowCommands: ["cat", "ls", "make"] } }));
    expect(text).toContain("[Note:");
    expect(runnersIn(text)).toEqual(["make"]);
    for (const r of ["npm", "pnpm", "npx", "nx", "uv"]) expect(text, r).not.toMatch(new RegExp(`\\b${r}\\b`));
  });

  it(`cafe9a17 AC1 [${adapter}]: an allowlist with no runner yields a note that names none`, async () => {
    const { text } = await rejectedOn(adapter, servers({ shell: { allowCommands: ["cat", "ls"] } }));
    expect(text).toContain("[Note:");
    expect(text).not.toMatch(/runner/);
    for (const r of ALL_RUNNERS) expect(text, r).not.toMatch(new RegExp(`\\b${r}\\b`));
  });

  it(`cafe9a17 AC1 [${adapter}]: fails closed for a custom shell server (even one that sets ALLOW_COMMANDS) and for an unreadable config`, async () => {
    for (const mcpServers of [{ shell: customShell }, {}] as Array<Record<string, McpServerConfig>>) {
      const { text } = await rejectedOn(adapter, mcpServers);
      expect(text).toContain("Command rejected by default security policy: node");
      expect(text, JSON.stringify(Object.keys(mcpServers))).not.toMatch(/runner/);
      for (const r of ALL_RUNNERS) expect(text, r).not.toMatch(new RegExp(`\\b${r}\\b`));
    }
  });

  it(`cafe9a17 AC1 [${adapter}]: the note stays out of history and observers (only the model request carries it)`, async () => {
    const { run } = await rejectedOn(adapter, servers({ shell: { allowCommands: ["cat", "make"] } }));
    for (const s of [...run.stored, ...run.appended, ...run.observedRequests, run.toolResultEvent]) expect(s).not.toContain("[Note:");
  });
});

describe("cafe9a17 AC1 [claudecli]: a bridged shell rejection gets no note at all, so it can name no runner", () => {
  it("cafe9a17 AC1 [claudecli]: executeTool returns the server's rejection unchanged and noteAppended stays unset, default or overridden allowlist", async () => {
    for (const mcpServers of [servers({}), servers({ shell: { allowCommands: ["cat", "make"] } })]) {
      const returned: Array<{ result: unknown; isError: boolean }> = [];
      const run = await runCall({
        server: "shell",
        tool: "shell_execute",
        args: ARGS,
        returns: REJECTION,
        throws: true,
        mcpServers,
        providerType: "claudecli",
        makeProvider: ({ sessionId }) =>
          ({
            chat: async (req: ProviderChatRequest) => {
              if (!req.executeTool) throw new Error("the engine must hand a claudecli provider an executeTool bridge");
              returned.push(await req.executeTool("shell", "shell_execute", ARGS));
              return {
                message: { id: crypto.randomUUID(), sessionId, role: "assistant", content: "done", createdAt: new Date().toISOString() },
                stopReason: "completed",
              } as never;
            },
          }) as unknown as LLMProvider,
      });
      expect(returned).toHaveLength(1);
      expect(returned[0].isError).toBe(true);
      expect(flatten(returned[0].result)).toContain("Command rejected by default security policy: node");
      expect(flatten(returned[0].result)).not.toContain("[Note:");
      expect(run.postPayloads.map((p) => p.noteAppended)).toEqual([undefined]);
      for (const s of [...run.stored, ...run.appended, ...run.observedRequests, run.toolResultEvent]) expect(s).not.toContain("[Note:");
    }
  });
});
