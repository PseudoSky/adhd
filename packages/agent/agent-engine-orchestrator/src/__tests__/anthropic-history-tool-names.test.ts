/**
 * P1-toolname (user request "tool names should not be inconsistent"; R8 parity root cause): the Anthropic provider
 * re-sent prior assistant `tool_use` blocks with the server prefix DROPPED (`shell_execute`) while the tool list it
 * advertised carried `server__tool` (`shell__shell_execute`). The model then saw bare names it was never offered in
 * its own history and sometimes emitted them (9 bare vs 4 qualified for the shell tool in one arm-C run).
 *
 * Acceptance ids:
 *  - P1-toolname AC1: the echoed assistant tool_use name equals the advertised `server__tool` name and is a member of
 *    the request's `tools` names (also when the model had emitted the BARE name and the engine resolved it).
 *  - P1-toolname AC2: Anthropic and OpenAI echo the identical string for the identical ToolCall.
 *  - P1-toolname AC3: server tools (web_search / web_fetch) and an advertised tool that carries no server prefix are
 *    unchanged; `resolveToolCallName` keeps tolerating bare model output (DEBT-004 safety net).
 *
 * Real AnthropicProvider / OpenAIProvider + real SDKs through the engine's `wire.fetch` seam: no socket, no network.
 *
 * guards: the provider re-sends prior assistant tool_use blocks with the server prefix dropped (shell_execute instead of the advertised shell__shell_execute), differs between Anthropic and OpenAI for the same ToolCall, or rewrites server tools and unprefixed tools.
 * tier: S
 * cites: P1-toolname AC1, AC2, AC3 (cited in the test titles).
 */
import { describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import type { ProviderChatRequest } from "../providers/types.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODEL = "claude-haiku-5-5";

interface IToolUseBlock {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
}
interface IWireBody {
  tools?: Array<{ name: string; type?: string }>;
  messages: Array<{ role: string; content: string | IToolUseBlock[] }>;
}

const USAGE = { input_tokens: 10, output_tokens: 5 };

function anthropicProvider(capture: IWireBody[], reply: { text?: string; toolUse?: { id: string; name: string; input: Record<string, unknown> } } = { text: "ok" }) {
  const fetchSeam: typeof fetch = async (_url, init) => {
    capture.push(JSON.parse(String(init?.body)) as IWireBody);
    return new Response(anthropicSseBody({ model: MODEL, usage: USAGE, ...reply }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
  } as unknown as EngineConfig;
  return new AnthropicProvider({ type: "anthropic", model: MODEL } as never, engineConfig, logger);
}

interface IOpenAiWire {
  messages: Array<{ role: string; tool_calls?: Array<{ id: string; function: { name: string } }> }>;
}

function openaiProvider(capture: IOpenAiWire[]) {
  const fetchSeam: typeof fetch = async (_url, init) => {
    capture.push(JSON.parse(String(init?.body)) as IOpenAiWire);
    return new Response(
      JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "gpt-test",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-test", model: "gpt-test" }),
  } as unknown as EngineConfig;
  return new OpenAIProvider({ type: "openai", model: "gpt-test" } as never, engineConfig);
}

const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });

/** user -> assistant(tool call) -> tool result -> (next model turn). */
function history(toolCalls: Array<{ id: string; server: string; tool: string }>): ProviderChatRequest["messages"] {
  return [
    { role: "user", content: "run it" },
    { role: "assistant", content: "", toolCalls: toolCalls.map((tc) => ({ ...tc, arguments: { command: "echo hi" } })) },
    ...toolCalls.map((tc) => ({ role: "tool", toolResults: [{ toolCallId: tc.id, result: "hi", isError: false }] })),
  ] as never;
}

const echoedNames = (body: IWireBody): string[] =>
  body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_use").map((b) => b.name as string) : []));
const advertisedNames = (body: IWireBody): string[] => (body.tools ?? []).map((t) => t.name);

describe("P1-toolname AC1: the echoed assistant tool_use name is the advertised server__tool name", () => {
  it("P1-toolname AC1: a stored {server:'shell', tool:'shell_execute'} call is echoed as 'shell__shell_execute', a member of body.tools", async () => {
    const bodies: IWireBody[] = [];
    await anthropicProvider(bodies).chat({
      messages: history([{ id: "toolu_1", server: "shell", tool: "shell_execute" }]),
      tools: [tool("shell__shell_execute"), tool("fs__read_text_file")],
    });
    expect(bodies).toHaveLength(1);
    const echoed = echoedNames(bodies[0]);
    expect(echoed).toEqual(["shell__shell_execute"]);
    expect(advertisedNames(bodies[0])).toContain(echoed[0]);
  });

  it("P1-toolname AC1: every echoed name in a multi-call history is advertised verbatim (no bare name the model was never offered)", async () => {
    const bodies: IWireBody[] = [];
    await anthropicProvider(bodies).chat({
      messages: history([
        { id: "toolu_1", server: "shell", tool: "shell_execute" },
        { id: "toolu_2", server: "fs", tool: "read_text_file" },
        { id: "toolu_3", server: "agent-mcp", tool: "task" },
      ]),
      tools: [tool("shell__shell_execute"), tool("fs__read_text_file"), tool("agent-mcp__task")],
    });
    const advertised = advertisedNames(bodies[0]);
    const echoed = echoedNames(bodies[0]);
    expect(echoed).toEqual(["shell__shell_execute", "fs__read_text_file", "agent-mcp__task"]);
    for (const name of echoed) expect(advertised, name).toContain(name);
  });

  it("P1-toolname AC1 round trip: the model emits the BARE name, the engine resolves it, and the NEXT request echoes the qualified advertised name", async () => {
    const tools = [tool("shell__shell_execute"), tool("fs__read_text_file")];
    const first: IWireBody[] = [];
    const turn1 = await anthropicProvider(first, { toolUse: { id: "toolu_bare", name: "shell_execute", input: { command: "ls" } } }).chat({
      messages: [{ role: "user", content: "list" }] as never,
      tools,
    });
    expect(turn1.message.toolCalls).toEqual([{ id: "toolu_bare", server: "shell", tool: "shell_execute", arguments: { command: "ls" } }]);

    const second: IWireBody[] = [];
    await anthropicProvider(second).chat({
      messages: [
        { role: "user", content: "list" },
        turn1.message,
        { role: "tool", toolResults: [{ toolCallId: "toolu_bare", result: "a b", isError: false }] },
      ] as never,
      tools,
    });
    const echoed = echoedNames(second[0]);
    expect(echoed).toEqual(["shell__shell_execute"]);
    expect(advertisedNames(second[0])).toContain(echoed[0]);
  });
});

describe("P1-toolname AC2: Anthropic and OpenAI echo the same name for the same ToolCall", () => {
  it("P1-toolname AC2: both providers echo `${server}__${tool}`", async () => {
    const calls = [
      { id: "call_1", server: "shell", tool: "shell_execute" },
      { id: "call_2", server: "agent-mcp", tool: "task" },
      { id: "call_3", server: "builtin", tool: "request_human_input" },
    ];
    const tools = calls.map((c) => tool(`${c.server}__${c.tool}`));
    const aBodies: IWireBody[] = [];
    await anthropicProvider(aBodies).chat({ messages: history(calls), tools });
    const oBodies: IOpenAiWire[] = [];
    await openaiProvider(oBodies).chat({ messages: history(calls), tools });

    const anthropicEchoed = echoedNames(aBodies[0]);
    const openaiEchoed = oBodies[0].messages.flatMap((m) => (m.tool_calls ?? []).map((tc) => tc.function.name));
    expect(openaiEchoed).toEqual(calls.map((c) => `${c.server}__${c.tool}`));
    expect(anthropicEchoed).toEqual(openaiEchoed);
  });
});

describe("P1-toolname AC3: server tools and non-prefixed advertised tools are unchanged", () => {
  it("P1-toolname AC3: web_search / web_fetch server tools stay bare in body.tools and the custom tool list is not rewritten", async () => {
    const bodies: IWireBody[] = [];
    await anthropicProvider(bodies).chat({
      messages: history([{ id: "toolu_1", server: "shell", tool: "shell_execute" }]),
      tools: [tool("shell__shell_execute")],
      serverSideTools: [
        { type: "web_search_20250305", name: "web_search", max_uses: 5 },
        { type: "web_fetch_20250910", name: "web_fetch", max_uses: 5 },
      ],
    } as never);
    expect(advertisedNames(bodies[0])).toEqual(["shell__shell_execute", "web_search", "web_fetch"]);
    expect(echoedNames(bodies[0])).toEqual(["shell__shell_execute"]);
  });

  it("P1-toolname AC3: an advertised tool with no server prefix is echoed unchanged (not 'plain_tool__plain_tool')", async () => {
    const bodies: IWireBody[] = [];
    await anthropicProvider(bodies).chat({
      messages: history([{ id: "toolu_1", server: "plain_tool", tool: "plain_tool" }]),
      tools: [tool("plain_tool"), tool("shell__shell_execute")],
    });
    const echoed = echoedNames(bodies[0]);
    expect(echoed).toEqual(["plain_tool"]);
    expect(advertisedNames(bodies[0])).toContain("plain_tool");
  });

  it("P1-toolname AC3: a qualified name whose server equals its tool ('echo__echo') is still echoed qualified when advertised", async () => {
    const bodies: IWireBody[] = [];
    await anthropicProvider(bodies).chat({
      messages: history([{ id: "toolu_1", server: "echo", tool: "echo" }]),
      tools: [tool("echo__echo")],
    });
    expect(echoedNames(bodies[0])).toEqual(["echo__echo"]);
  });

  it("P1-toolname AC3 safety net: resolveToolCallName still resolves a bare model name to its server (DEBT-004 tolerance kept)", async () => {
    const bodies: IWireBody[] = [];
    const res = await anthropicProvider(bodies, { toolUse: { id: "toolu_b", name: "read_text_file", input: {} } }).chat({
      messages: [{ role: "user", content: "x" }] as never,
      tools: [tool("fs__read_text_file")],
    });
    expect(res.message.toolCalls?.[0]).toMatchObject({ server: "fs", tool: "read_text_file" });
  });
});
