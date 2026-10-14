/**
 * 020307a5: a tool whose input schema has a top-level oneOf/anyOf/allOf made the Anthropic API reject
 * the WHOLE request with HTTP 400 (parity run R11, group C: `tools.43` = `backlog__batch_action`, a
 * 32-branch top-level `oneOf`). The shared normaliser (`providers/tool-schema.ts`) is applied at the
 * provider boundary by every adapter that needs it.
 *
 * Acceptance ids (stored on the item):
 *  - AC1 a tool with a top-level combinator is sent without it, the constraint kept as an appended
 *    "Input constraint: ..." line, the registered definitions and the other tools untouched.
 *  - AC2 a schema that cannot be normalised fails naming `tools.<n>` and the tool, not a bare HTTP 400.
 *  - AC3 the same fix on the OpenAI-compatible adapter (and the claudecli bridge, in
 *    `tool-schema-normalization.e2e.test.ts`), each with a negative control.
 *
 * Real `AnthropicProvider` / `OpenAIProvider` and their real SDKs through the engine's `wire.fetch`
 * seam: no socket, no network. The fake API answers 400 exactly as the API does (see
 * `fixtures/root-combinator-api.ts`), so a request that still carries a root combinator FAILS here.
 *
 * Golden fixtures: `fixtures/tool-schema/batch-action.raw.json` is the real `batch_action` tool as the
 * backlog MCP server published it in R11 (the 32-branch `oneOf` trimmed to 3 branches; all 32 are
 * `{required:["input"], properties:{input}}`, so the Claude CLI's output does not depend on the
 * trimmed ones), and `batch-action.cli.json` is what the Claude CLI 2.1.296 sent for it, captured
 * verbatim (wire seq of R11 B1). The normaliser must reproduce the CLI's schema and note text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import { OpenAIProvider } from "../providers/openai.js";
import { flattenRootCombinators, hasTopLevelCombinator, normalizeToolForWire } from "../providers/tool-schema.js";
import type { ToolDefinition } from "../providers/types.js";
import { ToolError } from "../validation/errors.js";
import { anthropicSseBody } from "./fixtures/anthropic-sse.js";
import { anthropicRootCombinatorRejection, openaiRootCombinatorRejection, rootCombinatorOf } from "./fixtures/root-combinator-api.js";

const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const MODEL = "claude-haiku-5-5";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/tool-schema/${name}`, import.meta.url)), "utf8")) as T;
interface IGoldenTool { name: string; description: string; inputSchema: Record<string, unknown> }
interface ICliTool { name: string; description: string; input_schema: Record<string, unknown> }

const batchAction = (): ToolDefinition => {
  const raw = fixture<IGoldenTool>("batch-action.raw.json");
  return { name: `backlog__${raw.name}`, description: raw.description, inputSchema: raw.inputSchema };
};
const plain = (): ToolDefinition => ({
  name: "fs__read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
});

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
}

describe("020307a5 AC1: the normaliser flattens a top-level combinator and keeps the constraint in the description", () => {
  it("020307a5 AC1: golden parity: the real R11 batch_action comes out as the Claude CLI sent it (schema deep-equal AND same key order, same note text)", () => {
    const cli = fixture<ICliTool>("batch-action.cli.json");
    const wire = normalizeToolForWire(batchAction(), 0);

    expect(wire.inputSchema).toEqual(cli.input_schema);
    expect(JSON.stringify(wire.inputSchema)).toBe(JSON.stringify(cli.input_schema));
    expect(hasTopLevelCombinator(wire.inputSchema)).toBe(false);

    // The CLI puts the note FIRST; AC1 appends it. Same text, compared without position.
    const cliNote = cli.description.split("\n\n")[0]!;
    expect(cliNote).toBe("Input constraint: Provide parameters for exactly one of: (input).");
    const original = batchAction().description;
    expect(wire.description).toBe(`${original}\n\n${cliNote}`);
  });

  it("020307a5 AC1: a tool WITHOUT a combinator is returned untouched (same schema object, same description): every other request is byte-identical", () => {
    const tool = plain();
    const wire = normalizeToolForWire(tool, 3);
    expect(wire.inputSchema).toBe(tool.inputSchema);
    expect(wire.description).toBe("Read a file");
  });

  it("020307a5 AC1: never mutates the registered definition (deep-frozen input) and is idempotent", () => {
    const tool = deepFreeze(batchAction());
    const once = normalizeToolForWire(tool, 0);
    expect(rootCombinatorOf(tool.inputSchema)).toBe("oneOf"); // the registered schema still has its oneOf
    const again = normalizeToolForWire({ ...tool, description: once.description, inputSchema: once.inputSchema }, 0);
    expect(again.inputSchema).toBe(once.inputSchema);
    expect(again.description).toBe(once.description); // no second note
    expect(once.description.match(/Input constraint:/g)).toHaveLength(1);
  });

  it("020307a5 AC1: a missing description gets the note alone; a missing schema becomes the empty object schema", () => {
    const noDesc = normalizeToolForWire({ name: "s__t", description: "", inputSchema: { oneOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }] } }, 0);
    expect(noDesc.description).toBe("Input constraint: Provide parameters for exactly one of: (a).");
    const noSchema = normalizeToolForWire({ name: "s__t", description: "d" } as unknown as ToolDefinition, 0);
    expect(noSchema.inputSchema).toEqual({ type: "object", properties: {} });
  });

  it("020307a5 AC1: oneOf/anyOf: properties from every branch (first definition wins), only the ROOT required survives, branch groups are listed", () => {
    const { schema, note } = flattenRootCombinators({
      type: "object",
      properties: { shared: { type: "string", description: "root" } },
      required: ["shared"],
      anyOf: [
        { type: "object", properties: { shared: { type: "number" }, a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
      ],
    });
    expect(schema["properties"]).toEqual({ shared: { type: "string", description: "root" }, a: { type: "string" }, b: { type: "string" } });
    expect(schema["required"]).toEqual(["shared"]);
    expect(schema["additionalProperties"]).toBe(true);
    expect(note).toBe("Input constraint: Provide parameters for at least one of: (a) or (b).");
  });

  it("020307a5 AC1: allOf: required of every branch holds together; the note says the parameters apply together", () => {
    const { schema, note } = flattenRootCombinators({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "string" }, c: { type: "string" } }, required: ["b", "ghost"] },
      ],
    });
    expect(Object.keys(schema["properties"] as object)).toEqual(["a", "b", "c"]);
    expect(schema["required"]).toEqual(["a", "b"]); // "ghost" names no surviving property
    expect(note).toBe("Input constraint: all listed parameters apply together (flattened from a JSON Schema allOf).");
  });

  it("020307a5 AC1: a branch that is a local $ref into definitions/$defs is resolved; defs and the schema's own additionalProperties are carried", () => {
    const { schema } = flattenRootCombinators({
      oneOf: [{ $ref: "#/definitions/A" }, { $ref: "#/$defs/B" }, { $ref: "#/definitions/missing" }],
      definitions: { A: { type: "object", properties: { fromA: { type: "string" } }, required: ["fromA"] } },
      $defs: { B: { type: "object", properties: { fromB: { type: "string" } } } },
      additionalProperties: false,
    });
    expect(Object.keys(schema["properties"] as object)).toEqual(["fromA", "fromB"]);
    expect(schema["definitions"]).toBeDefined();
    expect(schema["$defs"]).toBeDefined();
    expect(schema["additionalProperties"]).toBe(false);
  });

  it("020307a5 AC1: property names the API would refuse and non-object property schemas are dropped", () => {
    const { schema } = flattenRootCombinators({
      anyOf: [{ properties: { ok_name: { type: "string" }, "bad name": { type: "string" }, ["x".repeat(65)]: { type: "string" }, flag: true } }],
    });
    expect(Object.keys(schema["properties"] as object)).toEqual(["ok_name"]);
  });

  it("020307a5 AC1: the output is deterministic (same bytes every call) so the cached prompt prefix is stable", () => {
    const a = JSON.stringify(normalizeToolForWire(batchAction(), 0));
    const b = JSON.stringify(normalizeToolForWire(batchAction(), 0));
    expect(a).toBe(b);
  });
});

describe("020307a5 AC2: a schema that cannot be normalised fails naming tools.<n> and the tool", () => {
  const bad = (): ToolDefinition => ({ name: "srv__broken", description: "d", inputSchema: { type: "object", oneOf: "not-an-array" } });

  it("020307a5 AC2: the error is a PROVIDER_INVALID_REQUEST ToolError naming tools.<index>, the tool and the combinator", () => {
    let caught: unknown;
    try {
      normalizeToolForWire(bad(), 7);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ToolError);
    const err = caught as ToolError;
    expect(err.code).toBe("PROVIDER_INVALID_REQUEST");
    expect(err.message).toContain("tools.7");
    expect(err.message).toContain("srv__broken");
    expect(err.message).toContain("oneOf");
    expect(err.data).toEqual({ kind: "tool_schema_unnormalizable", toolIndex: 7, toolName: "srv__broken", combinators: ["oneOf"] });
  });

  it("020307a5 AC2: a root declared as a non-object type with a combinator is refused too", () => {
    expect(() => normalizeToolForWire({ name: "s__t", description: "", inputSchema: { type: "string", anyOf: [{ type: "string" }] } }, 0)).toThrow(/tools\.0 \(s__t\)/);
  });
});

// ─────────────────────────────── adapters: the request body that reaches the wire ───────────────────────────────

interface IAnthropicBody { tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown>; cache_control?: unknown }> }

function anthropicWith(capture: IAnthropicBody[], rejects = true) {
  const fetchSeam: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body)) as IAnthropicBody;
    capture.push(body);
    const rejection = rejects ? anthropicRootCombinatorRejection(body) : undefined;
    if (rejection) return new Response(JSON.stringify(rejection.body), { status: rejection.status, headers: { "content-type": "application/json" } });
    return new Response(anthropicSseBody({ model: MODEL, text: "ok", usage: { input_tokens: 10, output_tokens: 5 } }), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-ant-api-test", model: MODEL }),
  } as unknown as EngineConfig;
  return new AnthropicProvider({ type: "anthropic", model: MODEL }, engineConfig, logger);
}

const ask = { messages: [{ role: "user", content: "hi" }] as never };

describe("020307a5 AC1: anthropic adapter", () => {
  it("020307a5 AC1: a request carrying a root-oneOf tool is accepted by the (fake) API and the tool goes out flattened with the note appended; neighbours and the registered tools are untouched", async () => {
    const tools = [plain(), batchAction(), { ...plain(), name: "fs__stat" }];
    const before = JSON.stringify(tools);
    const bodies: IAnthropicBody[] = [];

    const res = await anthropicWith(bodies).chat({ ...ask, tools });

    expect(res.message.content).toBe("ok"); // the fake answers 400 when ANY tool still has a root combinator
    expect(bodies).toHaveLength(1);
    const wire = bodies[0]!.tools!;
    expect(wire.map((t) => t.name)).toEqual(["fs__read_file", "backlog__batch_action", "fs__stat"]);
    expect(rootCombinatorOf(wire[1]!.input_schema)).toBeUndefined();
    expect(wire[1]!.input_schema).toEqual(fixture<ICliTool>("batch-action.cli.json").input_schema);
    expect(wire[1]!.description.endsWith("\n\nInput constraint: Provide parameters for exactly one of: (input).")).toBe(true);
    // the neighbours are byte-for-byte what they were before the fix
    expect(wire[0]).toMatchObject({ name: "fs__read_file", description: "Read a file", input_schema: plain().inputSchema });
    expect(wire[2]!.input_schema).toEqual(plain().inputSchema);
    // the caller's definitions were not rewritten
    expect(JSON.stringify(tools)).toBe(before);
  });

  it("020307a5 AC1: negative control: the fake API really rejects the unnormalised definition (the premise of every test above)", () => {
    const unnormalised = [{ name: "b", description: "d", input_schema: batchAction().inputSchema }];
    expect(anthropicRootCombinatorRejection({ tools: unnormalised })).toMatchObject({
      status: 400,
      body: { error: { message: "tools.0.custom.input_schema: input_schema does not support oneOf, allOf, or anyOf at the top level" } },
    });
  });

  it("020307a5 AC2: an un-normalisable schema fails BEFORE any request: error names tools.<n> and the tool, the API is never called (so it is not retried either)", async () => {
    const bodies: IAnthropicBody[] = [];
    const broken: ToolDefinition = { name: "srv__broken", description: "d", inputSchema: { type: "object", anyOf: 5 } };

    const err = await anthropicWith(bodies).chat({ ...ask, tools: [plain(), broken] }).then(
      () => undefined,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe("PROVIDER_INVALID_REQUEST");
    expect((err as ToolError).message).toMatch(/tools\.1 \(srv__broken\)/);
    expect(bodies).toHaveLength(0);
  });
});

interface IOpenAIBody { tools?: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }> }

function openaiWith(capture: IOpenAIBody[], providerExtra: Record<string, unknown> = {}) {
  const fetchSeam: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body)) as IOpenAIBody;
    capture.push(body);
    const rejection = openaiRootCombinatorRejection(body);
    if (rejection) return new Response(JSON.stringify(rejection.body), { status: rejection.status, headers: { "content-type": "application/json" } });
    return new Response(
      JSON.stringify({
        id: "x", object: "chat.completion", created: 0, model: "m",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const engineConfig = {
    server: { contextLimit: 0, defaultMaxTokens: 8192 },
    wire: { fetch: fetchSeam },
    getProviderConfig: () => ({ secret: "sk-test", model: "m", baseURL: "http://localhost:1/v1" }),
  } as unknown as EngineConfig;
  return new OpenAIProvider({ type: "openai", model: "m", ...providerExtra } as never, engineConfig);
}

describe("020307a5 AC3: openai-compatible adapter (OpenAI, DeepSeek)", () => {
  it("020307a5 AC3: the root-oneOf tool goes out as flat function.parameters with the note appended, neighbours and the registered tools untouched", async () => {
    const tools = [plain(), batchAction()];
    const before = JSON.stringify(tools);
    const bodies: IOpenAIBody[] = [];

    const res = await openaiWith(bodies).chat({ ...ask, tools });

    expect(res.message.content).toBe("ok");
    const wire = bodies[0]!.tools!;
    expect(rootCombinatorOf(wire[1]!.function.parameters)).toBeUndefined();
    expect(wire[1]!.function.parameters).toEqual(fixture<ICliTool>("batch-action.cli.json").input_schema);
    expect(wire[1]!.function.description.endsWith("\n\nInput constraint: Provide parameters for exactly one of: (input).")).toBe(true);
    expect(wire[0]!.function).toEqual({ name: "fs__read_file", description: "Read a file", parameters: plain().inputSchema });
    expect(JSON.stringify(tools)).toBe(before);
  });

  it("020307a5 AC3: an un-normalisable schema fails naming tools.<n> and the tool, with zero API calls even when retries are configured", async () => {
    const bodies: IOpenAIBody[] = [];
    const broken: ToolDefinition = { name: "srv__broken", description: "d", inputSchema: { allOf: "no" } };

    const err = await openaiWith(bodies, { retryConfig: { retries: 3, minTimeout: 1, maxTimeout: 1, factor: 1 } })
      .chat({ ...ask, tools: [broken] })
      .then(() => undefined, (e: unknown) => e);

    expect((err as ToolError).code).toBe("PROVIDER_INVALID_REQUEST");
    expect((err as ToolError).message).toMatch(/tools\.0 \(srv__broken\)/);
    expect(bodies).toHaveLength(0);
  });
});
