/**
 * a2a9c6db AC2: the host's tool-result notes reach the MODEL REQUEST and nothing else, on EVERY turn.
 *
 * The first request after a tool call is the only one where "no observer sees the note" holds even when the
 * enforcement handler mutates the engine's live history, because the note is applied after the observers ran.
 * From the next turn that history is what tracing, the ops log and the compaction summariser are handed, so a
 * note applied in place shows up there (and in `toolResultBytesIn`). These tests therefore run THREE model
 * turns: write (turn 1), write again (turn 2), answer (turn 3), and assert on turn 3's observational
 * `pre:model_request` payload and on `post:model_response.toolResultBytesIn`.
 *
 * Real: `Orchestrator`, the host hook registry (`createHostHooks`), the real `AnthropicProvider` and
 * `OpenAIProvider` (DeepSeek and every OpenAI-compatible endpoint use the latter) over a capturing
 * `wire.fetch`, a migrated sqlite `TaskStore`, the native-tooling resolver. Scripted: the model's replies and
 * the MCP tool results. claudecli is the engine's bridge path (a provider that calls `executeTool` as the
 * loopback bridge does; no `claude` process).
 */
import { rmSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  HookRegistry,
  OpenAIProvider,
  type LLMProvider,
  type ProviderChatRequest,
} from "@adhd/agent-engine-orchestrator";

import type { ExecutionContext, IHookRegistry, PostToolCallPayload } from "@adhd/agent-base-types";

import { registerToolResultNotes, FS_WRITE_NOTE } from "../tool-result-notes.js";
import { catalogServers, openDbs, runCall, scratch } from "./r10-s4-harness.js";

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const WROTE_TEXT = "Successfully wrote to /w/a.txt";
const WROTE = [{ type: "text", text: WROTE_TEXT }];
const ARGS = [
  { path: "/w/a.txt", content: "one" },
  { path: "/w/a.txt", content: "two" },
];
type Body = Record<string, unknown> & { messages: Array<Record<string, unknown>> };

const sse = (events: Array<[string, unknown]>): Response =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const msgStart = { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } };

/** Real AnthropicProvider; turns 1 and 2 each call fs__write_file, turn 3 answers. */
function anthropicThreeTurns(bodies: Body[]): () => LLMProvider {
  return () => {
    const fetchSeam: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const turn = bodies.length;
      if (turn <= 2) {
        return sse([
          ["message_start", msgStart],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${turn}`, name: "fs__write_file", input: {} } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(ARGS[turn - 1]) } }],
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

/** Real OpenAIProvider (DeepSeek-compatible); turns 1 and 2 each call fs__write_file, turn 3 answers. */
function openaiThreeTurns(bodies: Body[]): () => LLMProvider {
  return () => {
    const fetchSeam: typeof fetch = async (_u, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Body);
      const turn = bodies.length;
      const message =
        turn <= 2
          ? { role: "assistant", content: null, tool_calls: [{ id: `call_${turn}`, type: "function", function: { name: "fs__write_file", arguments: JSON.stringify(ARGS[turn - 1]) } }] }
          : { role: "assistant", content: "done" };
      return new Response(
        JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "deepseek-flash", choices: [{ index: 0, finish_reason: turn <= 2 ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
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

/** The tool-result texts the model reads in one request body, in wire order. */
function wireResults(adapter: "anthropic" | "openai", body: Body): string[] {
  if (adapter === "openai") return body.messages.filter((m) => m["role"] === "tool").map((m) => String(m["content"]));
  return body.messages.flatMap((m) =>
    Array.isArray(m["content"])
      ? (m["content"] as Array<Record<string, unknown>>).filter((b) => b["type"] === "tool_result").map((b) => (typeof b["content"] === "string" ? b["content"] : JSON.stringify(b["content"])))
      : []
  );
}

describe.each([
  ["anthropic", anthropicThreeTurns],
  ["openai", openaiThreeTurns],
] as const)("a2a9c6db AC2 [%s]: a note reaches the model request on every turn and never the history or an observer", (adapter, factory) => {
  it(`a2a9c6db AC2 [${adapter}]: both requests after the writes carry the note; turn 3's observers, the stored history and toolResultBytesIn carry none`, async () => {
    const bodies: Body[] = [];
    const run = await runCall({
      server: "fs",
      tool: "write_file",
      args: ARGS[0],
      returns: WROTE,
      providerType: adapter,
      makeProvider: factory(bodies),
    });
    expect(bodies).toHaveLength(3);

    // The model request: turn 2 carries the first note, turn 3 carries BOTH (the prefix is stable across turns).
    const noted = (text: string) => text.includes(FS_WRITE_NOTE);
    expect(wireResults(adapter, bodies[1]).map(noted)).toEqual([true]);
    expect(wireResults(adapter, bodies[2]).map(noted)).toEqual([true, true]);

    // Observers: the observational pre:model_request payload of every turn, notably turn 3 whose history holds
    // the turn-1 and turn-2 tool results; the session store; message:appended; the TOOL_RESULT events.
    expect(run.observedRequests).toHaveLength(3);
    for (const [i, s] of run.observedRequests.entries()) expect(s, `observed request of turn ${i + 1}`).not.toContain("[Note:");
    for (const s of [...run.stored, ...run.appended, run.toolResultEvent]) expect(s).not.toContain("[Note:");
    expect(run.observedRequests[2]).toContain(WROTE_TEXT); // teeth: the history really does hold the tool results

    // The engine's own byte figure counts the tool results as the tools returned them, not the notes.
    const toolBytes = 2 * Buffer.byteLength(WROTE_TEXT);
    expect(run.toolResultBytesIn).toEqual([0, Buffer.byteLength(WROTE_TEXT), toolBytes]);

    // The trace decision is still made: both calls were noted.
    expect(run.postPayloads.map((p) => p.noteAppended)).toEqual([true, true]);
    expect(run.postPayloads.map((p) => p.result)).toEqual([WROTE, WROTE]);
  });
});

describe("a2a9c6db AC2 [claudecli]: a bridged call gets no note and is never reported as noted", () => {
  it("a2a9c6db AC2 [claudecli]: executeTool returns the server's result unchanged, noteAppended stays unset, history and observers hold no note", async () => {
    const returned: Array<{ result: unknown; isError: boolean }> = [];
    const run = await runCall({
      server: "fs",
      tool: "write_file",
      args: ARGS[0],
      returns: WROTE,
      providerType: "claudecli",
      makeProvider: ({ sessionId }) =>
        ({
          chat: async (req: ProviderChatRequest) => {
            for (const args of ARGS) returned.push(await req.executeTool!("fs", "write_file", args));
            return {
              message: { id: crypto.randomUUID(), sessionId, role: "assistant", content: "done", createdAt: new Date().toISOString() },
              stopReason: "completed",
            } as never;
          },
        }) as unknown as LLMProvider,
    });
    expect(returned).toHaveLength(2);
    for (const r of returned) expect(JSON.stringify(r.result)).not.toContain("[Note:");
    expect(run.postPayloads).toHaveLength(2);
    expect(run.postPayloads.map((p) => p.noteAppended)).toEqual([undefined, undefined]);
    for (const s of [...run.stored, ...run.appended, ...run.observedRequests, run.toolResultEvent]) expect(s).not.toContain("[Note:");
  });
});

describe("noteAppended delivery depends on hook registration order (a2a9c6db AC2 partial; deferred clause: 78875362)", () => {
  const ctx = {
    taskId: "t",
    sessionId: "s",
    agentName: "a",
    agentDefinition: { name: "a", version: 1, systemPrompt: "", mcpServers: catalogServers(), permissions: {}, createdAt: "", updatedAt: "" },
    selection: { providerType: "openai", modelRef: "m" },
    recursionDepth: 0,
    toolCallCount: 0,
  } as unknown as ExecutionContext;
  const post: PostToolCallPayload = { executionContext: ctx, toolName: "fs__write_file", callId: "c1", toolInput: { path: "/w/a" }, result: WROTE, isError: false, estResultTokens: 1 };
  const observe = (hooks: IHookRegistry, into: Array<boolean | undefined>) => hooks.register("post:tool_call", (p) => void into.push(p.noteAppended));

  it("a2a9c6db AC2 (shipped order only): the shipped order (host hooks first, plugins after, as main() does) hands a plugin noteAppended = true", async () => {
    const hooks = new HookRegistry();
    registerToolResultNotes(hooks);
    const seen: Array<boolean | undefined> = [];
    observe(hooks, seen); // the tracing plugin registers here, via loadDefaultPlugins, after createHostHooks
    await hooks.emit("post:tool_call", { ...post });
    expect(seen).toEqual([true]);
  });

  it("78875362: the registry has no handler priority, so an observer registered BEFORE the notes hook cannot see the flag (pinned limitation; the registration-order clause of a2a9c6db AC2 is deferred to 78875362)", async () => {
    const hooks = new HookRegistry();
    const seen: Array<boolean | undefined> = [];
    observe(hooks, seen);
    registerToolResultNotes(hooks);
    await hooks.emit("post:tool_call", { ...post });
    expect(seen).toEqual([undefined]);
  });
});
