/**
 * R10 S4 x adapter: the corrections reach every provider adapter's WIRE intact.
 *
 * The notes are added by the host (`tool-result-notes.ts`) to the messages handed to `provider.chat`, so the
 * adapter encodes them like any other tool-result text. Proven here with the REAL `AnthropicProvider` and the REAL
 * `OpenAIProvider` (DeepSeek and every OpenAI-compatible endpoint use the latter) and the real SDKs, through the
 * engine's `wire.fetch` seam: the bytes a server would receive. The whole loop is real (`Orchestrator`, host
 * hooks, `TaskStore`, native-tooling resolver); only the model's replies and the MCP tool results are scripted.
 *
 * AC1/AC2 (adapter): the write note is in the model-visible tool result on the Anthropic request (tool_result block)
 *   and on the OpenAI request (`role:"tool"` message content, a plain string); stored history, `post:tool_call`,
 *   `message:appended`, the observational `pre:model_request` payload and `TOOL_RESULT` stay unchanged in both.
 * AC3 (adapter): the shell rejection (server text + recovery line) reaches both wires intact.
 * AC4 (adapter): the delegation description is the same string in `tools[].function.description` (OpenAI) and
 *   `tools[].description` (Anthropic).
 * AC5 (adapter): `thinking` is Anthropic-only: an `openai` or `claudecli` provider config with `thinking` is
 *   rejected by the strict input schema (S0), so it cannot reach the OpenAI adapter.
 *
 * claudecli: its tools run inside the CLI's own loop, which never passes through `pre:model_request`, so it gets
 * no note (see the adapter table in the segment report); not driven here because that needs the `claude` binary.
 *
 * guards: an R10 S4 correction (fs write/edit note, shell rejection recovery line, delegation description, `thinking` rejection)
 *   is lost or mangled in the bytes the real Anthropic or OpenAI-compatible adapter puts on the wire.
 * tier: S (in-process real Orchestrator, adapters and sqlite store over a capturing wire.fetch; no process, no network)
 * cites: R10 S4 AC1-AC5, R10 W1 AC3 (this file names no backlog uid).
 */
import { rmSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Message } from "@adhd/agent-base-types";
import {
  AnthropicProvider,
  HookRegistry,
  OpenAIProvider,
  agentCreateInputSchema,
  type LLMProvider,
} from "@adhd/agent-engine-orchestrator";
import { SessionStore, TaskStore } from "@adhd/agent-store-runtime";

import { DELEGATION_DECISION_RULE } from "../delegation-text.js";
import { createServer, type ServerDeps } from "../server.js";
import { AgentStore } from "../store/agent-store.js";
import { FS_EDIT_NOTE, FS_WRITE_NOTE } from "../tool-result-notes.js";
import { openDb, type ITestDb } from "./pricing-fixtures.js";
import { openDbs, runCall, scratch } from "./r10-s4-harness.js";

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
let testDbs: ITestDb[] = [];
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  for (const d of testDbs) d.sqlite.close();
  for (const db of openDbs.splice(0)) db.close();
  testDbs = [];
  closers = [];
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// -- scripted model replies, per adapter -----------------------------------------------------------------------

type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>> };

/** A real OpenAIProvider (the DeepSeek / OpenAI-compatible adapter) over a capturing fetch. */
function openaiFactory(bodies: Body[], call: { name: string; args: unknown }) {
  return (): LLMProvider => {
    const fetchSeam: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const first = bodies.length === 1;
      return json(200, {
        id: "x",
        object: "chat.completion",
        created: 0,
        model: "deepseek-flash",
        choices: [
          {
            index: 0,
            finish_reason: first ? "tool_calls" : "stop",
            message: first
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: "call_1", type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }],
                }
              : { role: "assistant", content: "done" },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const config = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: { fetch: fetchSeam },
      getProviderConfig: () => ({ secret: "sk-test", model: "deepseek-flash", baseURL: "http://localhost:1/v1" }),
    };
    return new OpenAIProvider({ type: "openai", model: "deepseek-flash" } as never, config as never);
  };
}

const sse = (events: Array<[string, unknown]>): Response =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const msgStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };

/** A real AnthropicProvider over a capturing fetch that answers with streamed SSE. */
function anthropicFactory(bodies: Body[], call: { name: string; args: unknown }) {
  return (): LLMProvider => {
    const fetchSeam: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      if (bodies.length === 1) {
        return sse([
          ["message_start", msgStart],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: call.name, input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }],
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

type Adapter = "anthropic" | "openai (DeepSeek-compatible)";
const ADAPTERS: Array<[Adapter, (b: Body[], c: { name: string; args: unknown }) => () => LLMProvider]> = [
  ["anthropic", anthropicFactory],
  ["openai (DeepSeek-compatible)", openaiFactory],
];

/** The text the model reads for the tool result on the SECOND request of a run, as that adapter encodes it. */
function wireToolResult(adapter: Adapter, bodies: Body[]): { shape: string; text: string } {
  expect(bodies).toHaveLength(2);
  const msgs = bodies[1].messages;
  if (adapter === "anthropic") {
    const turn = msgs[msgs.length - 1].content as Array<Record<string, unknown>>;
    const block = turn.find((b) => b["type"] === "tool_result")!;
    const c = block["content"];
    return { shape: typeof c === "string" ? "string" : "blocks", text: typeof c === "string" ? c : JSON.stringify(c) };
  }
  const tool = msgs.find((m) => m["role"] === "tool")!;
  return { shape: typeof tool["content"] === "string" ? "string" : "other", text: String(tool["content"]) };
}

const WROTE = [{ type: "text", text: "Successfully wrote to /w/a.txt" }];
const DIFF = [{ type: "text", text: "```diff\n--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n```" }];

describe.each(ADAPTERS)("R10 S4 adapter wire: %s", (adapter, factory) => {
  it(`R10 S4 AC1 adapter: ${adapter}: the write note is in the model-visible tool result as a plain string, after the server's own text`, async () => {
    const bodies: Body[] = [];
    const args = { path: "/w/a.txt", content: "x" };
    await runCall({ server: "fs", tool: "write_file", args, returns: WROTE, makeProvider: factory(bodies, { name: "fs__write_file", args }) });
    const seen = wireToolResult(adapter, bodies);
    expect(seen.shape).toBe("string");
    expect(seen.text).toBe(`Successfully wrote to /w/a.txt\n${FS_WRITE_NOTE}`);
  });

  it(`R10 S4 AC1 adapter: ${adapter}: an edit carries the edit note; a dryRun edit carries the server's diff and nothing else`, async () => {
    const applied: Body[] = [];
    const a1 = { path: "/w/a.txt", edits: [] };
    await runCall({ server: "fs", tool: "edit_file", args: a1, returns: DIFF, makeProvider: factory(applied, { name: "fs__edit_file", args: a1 }) });
    expect(wireToolResult(adapter, applied).text).toBe(`${DIFF[0].text}\n${FS_EDIT_NOTE}`);

    const dry: Body[] = [];
    const a2 = { path: "/w/a.txt", edits: [], dryRun: true };
    await runCall({ server: "fs", tool: "edit_file", args: a2, returns: DIFF, makeProvider: factory(dry, { name: "fs__edit_file", args: a2 }) });
    expect(wireToolResult(adapter, dry).text).toBe(DIFF[0].text);
  });

  it(`R10 S4 AC2 adapter: ${adapter}: stored history and embedder hook payloads keep the server's exact text while the wire carries the note`, async () => {
    const bodies: Body[] = [];
    const args = { path: "/w/a.txt", content: "x" };
    const run = await runCall({ server: "fs", tool: "write_file", args, returns: WROTE, makeProvider: factory(bodies, { name: "fs__write_file", args }) });
    expect(wireToolResult(adapter, bodies).text).toContain(FS_WRITE_NOTE); // teeth: the note really is on this wire
    const toolMsg = run.stored.map((s) => JSON.parse(s) as Message).find((m) => m.role === "tool");
    expect(toolMsg?.toolResults?.[0]?.result).toEqual(WROTE);
    for (const s of [...run.stored, ...run.appended, run.observedRequest, run.toolResultEvent]) expect(s).not.toContain("[Note:");
    expect(run.postPayloads[0].result).toEqual(WROTE);
    expect(run.postPayloads[0].noteAppended).toBe(true);
  });

  it(`R10 S4 AC3 adapter: ${adapter}: the shell rejection reaches the wire intact: the server's text, then the recovery line`, async () => {
    const rejection =
      "Tool 'shell_execute' on server 'shell' returned an error: [{\"type\":\"text\",\"text\":\"Command rejected by default security policy: node\"}]";
    const bodies: Body[] = [];
    const args = { command: ["node", "-e", "1"] };
    const run = await runCall({ server: "shell", tool: "shell_execute", args, returns: rejection, throws: true, makeProvider: factory(bodies, { name: "shell__shell_execute", args }) });
    const seen = wireToolResult(adapter, bodies);
    expect(seen.text.startsWith(rejection)).toBe(true);
    expect(seen.text).toContain("[Note: \"node\" is rejected by the shell server's default security policy");
    expect(seen.text).toContain("fs__edit_file");
    expect(seen.text).not.toMatch(/make test|npm test|node -e\b(?!"|\])/);
    for (const s of run.stored) expect(s).not.toContain("[Note:");
  });
});

const SHELL_ORDERING_SENTENCE =
  "Shell calls in one turn run one after another; to overlap independent long commands use one command that does it (e.g. `make -j2 test lint`) or a tasks_batch.";

/** The description the model reads for `tool` on the FIRST request of a run, as that adapter puts it on the wire. */
function wireToolDescription(adapter: Adapter, bodies: Body[], tool: string): string | undefined {
  const tools = bodies[0].tools ?? [];
  if (adapter === "anthropic") return tools.find((t) => t["name"] === tool)?.["description"] as string | undefined;
  return (tools.find((t) => (t["function"] as { name: string }).name === tool)?.["function"] as { description?: string } | undefined)?.description;
}

describe.each(ADAPTERS)("R10 W1 adapter wire: %s", (adapter, factory) => {
  it(`R10 W1 AC3 adapter: ${adapter}: the shell ordering sentence is in the shell tool's description on the wire, and only there`, async () => {
    const shellBodies: Body[] = [];
    const shellArgs = { command: ["ls"] };
    await runCall({ server: "shell", tool: "shell_execute", args: shellArgs, returns: [{ type: "text", text: "ok" }], makeProvider: factory(shellBodies, { name: "shell__shell_execute", args: shellArgs }) });
    const shell = wireToolDescription(adapter, shellBodies, "shell__shell_execute");
    expect(shell, "shell tool is offered").toBeDefined();
    expect(shell).toContain(SHELL_ORDERING_SENTENCE);

    // control: the sentence is shell guidance, not a blanket note on every tool
    const fsBodies: Body[] = [];
    const fsArgs = { path: "/w/a.txt", content: "x" };
    await runCall({ server: "fs", tool: "write_file", args: fsArgs, returns: WROTE, makeProvider: factory(fsBodies, { name: "fs__write_file", args: fsArgs }) });
    const fsDesc = wireToolDescription(adapter, fsBodies, "fs__write_file");
    expect(fsDesc, "fs tool is offered").toBeDefined();
    expect(fsDesc).not.toContain(SHELL_ORDERING_SENTENCE);
  });
});

describe("R10 S4 AC4 adapter: the delegation description is the same string on both wires", () => {
  it("R10 S4 AC4 adapter: task / tasks_batch / result descriptions are identical in OpenAI tools[].function.description and Anthropic tools[].description", async () => {
    const o = openDb();
    testDbs.push(o);
    const hooks = new HookRegistry();
    const server = createServer({
      agentStore: new AgentStore(o.db, hooks),
      sessionStore: new SessionStore(o.db, hooks),
      taskStore: new TaskStore(o.db),
      hooks,
      db: o.db,
    } as ServerDeps);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-host", version: "0.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    closers.push(() => client.close(), () => server.close());
    const hostTools = (await client.listTools()).tools.filter((t) => ["task", "tasks_batch", "result"].includes(t.name));
    expect(hostTools).toHaveLength(3);
    const defs = hostTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const user: Message[] = [{ id: "u", sessionId: "s", role: "user", content: "hi", createdAt: "t" }];

    const oai: Body[] = [];
    const oaiProvider = openaiFactory(oai, { name: "task", args: {} })();
    await oaiProvider.chat({ messages: user, tools: defs as never });
    const ant: Body[] = [];
    const antProvider = anthropicFactory(ant, { name: "task", args: {} })();
    await antProvider.chat({ messages: user, tools: defs as never });

    const oaiDesc = new Map((oai[0].tools ?? []).map((t) => [(t["function"] as { name: string }).name, (t["function"] as { description: string }).description]));
    const antDesc = new Map((ant[0].tools ?? []).map((t) => [t["name"] as string, t["description"] as string]));
    for (const d of defs) {
      expect(oaiDesc.get(d.name), `openai ${d.name}`).toBe(d.description);
      expect(antDesc.get(d.name), `anthropic ${d.name}`).toBe(d.description);
      expect(oaiDesc.get(d.name)?.startsWith(DELEGATION_DECISION_RULE), d.name).toBe(true);
      expect(antDesc.get(d.name)?.startsWith(DELEGATION_DECISION_RULE), d.name).toBe(true);
    }
  });
});

describe("R10 S4 AC5 adapter: `thinking` is Anthropic-only", () => {
  const base = { name: "a", systemPrompt: "p", mcpServers: {}, permissions: {} };
  it("R10 S4 AC5 adapter: an openai (DeepSeek-compatible) or claudecli provider config with `thinking` is rejected by the strict input schema, naming the key", () => {
    for (const type of ["openai", "claudecli"]) {
      const r = agentCreateInputSchema.safeParse({ ...base, provider: { type, thinking: { type: "adaptive" } } });
      expect(r.success, type).toBe(false);
      expect(!r.success && r.error.issues.some((i) => i.path.includes("thinking") || i.message.includes("thinking")), type).toBe(true);
    }
    expect(agentCreateInputSchema.safeParse({ ...base, provider: { type: "anthropic", thinking: { type: "adaptive" } } }).success).toBe(true);
  });
});
