/**
 * cp-cache-tool-determinism.test.ts — 9ed453c1 CACHE: the serialized `tools` block (head of the
 * cached prompt prefix) must be byte-identical across tasks.
 *
 * Root cause (verified against the real `mcp-shell-server==1.1.12`): its `Allowed commands:` list is
 * rendered from a Python set, so the order follows the per-process PYTHONHASHSEED. The e2e sibling
 * (`cp-cache-tool-determinism.e2e.test.ts`) proves it on real spawned servers; this file holds the
 * pure-function contract (AC2) and the request-body proof for the anthropic provider (AC4).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { EngineConfig, EngineLogger } from "../interfaces.js";
import { AnthropicProvider } from "../providers/anthropic.js";
import type { ToolDefinition } from "../providers/types.js";
import {
  canonicalizeDescription,
  canonicalizeToolDefinitions,
  compactToolDefinitions,
} from "../engine/tool-schema-compact.js";
import { anthropicSseBody, distinctFiller } from "./fixtures/anthropic-sse.js";

const sha = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

const BASE = "Execute a shell command\n\nArgs:\n  command: argv\n";
const desc = (cmds: string[], pats: string[] = []): string =>
  `${BASE}\nAllowed commands: ${cmds.join(", ")}\nAllowed patterns: ${pats.join(", ")}\n\nReturns: result`;

const shell = (cmds: string[], pats: string[] = []): ToolDefinition => ({
  name: "shell__shell_execute",
  description: desc(cmds, pats),
  inputSchema: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] },
});

describe("9ed453c1 CACHE AC2: canonicalization is idempotent and semantics-preserving", () => {
  const orderings = [
    ["ls", "cat", "echo", "pwd"],
    ["pwd", "echo", "cat", "ls"],
    ["echo", "ls", "pwd", "cat"],
  ];

  it("9ed453c1 CACHE AC2: every ordering of the same allow-list canonicalizes to the SAME bytes", () => {
    const hashes = new Set(orderings.map((o) => sha(canonicalizeToolDefinitions([shell(o)]))));
    expect(hashes.size).toBe(1);
    // negative control: the raw (un-normalized) definitions differ
    expect(new Set(orderings.map((o) => sha([shell(o)]))).size).toBe(orderings.length);
  });

  it("9ed453c1 CACHE AC2: idempotent (fixed point)", () => {
    const once = canonicalizeToolDefinitions([shell(orderings[1]!, ["git.*", "ab"])]);
    expect(canonicalizeToolDefinitions(once)).toEqual(once);
    const d = once[0]!.description!;
    expect(canonicalizeDescription(d)).toBe(d);
  });

  it("9ed453c1 CACHE AC2: the set of allowed commands/patterns is unchanged and all other text is byte-identical", () => {
    const input = shell(orderings[2]!, ["zz.*", "aa.*"]);
    const out = canonicalizeToolDefinitions([input])[0]!;
    const items = (d: string, label: string): string[] =>
      new RegExp(`^${label}: (.*)$`, "m").exec(d)![1]!.split(", ").filter(Boolean);
    expect(new Set(items(out.description!, "Allowed commands"))).toEqual(new Set(items(input.description!, "Allowed commands")));
    expect(items(out.description!, "Allowed commands")).toEqual(["cat", "echo", "ls", "pwd"]);
    expect(items(out.description!, "Allowed patterns")).toEqual(["aa.*", "zz.*"]);
    // everything outside the two list lines is untouched
    const strip = (d: string): string => d.replace(/^Allowed (commands|patterns): .*$/gm, "");
    expect(strip(out.description!)).toBe(strip(input.description!));
    expect(out.inputSchema).toEqual(input.inputSchema);
    expect(out.name).toBe(input.name);
  });

  it("9ed453c1 CACHE AC2: never mutates its input; descriptions without allow-lists, empty lists and undefined descriptions pass through", () => {
    const input = shell(orderings[1]!);
    const snapshot = JSON.stringify(input);
    canonicalizeToolDefinitions([input]);
    expect(JSON.stringify(input)).toBe(snapshot);

    const plain: ToolDefinition = { name: "a__b", description: "Does a thing. Allowed to fail, sometimes.", inputSchema: { type: "object" } };
    expect(canonicalizeToolDefinitions([plain])).toEqual([plain]);
    expect(canonicalizeDescription("Allowed patterns: ")).toBe("Allowed patterns: ");
    expect(canonicalizeDescription("x\nAllowed commands: only")).toBe("x\nAllowed commands: only");
    // runtime-defensive: a third-party server may omit the description
    const noDesc = { name: "a__c", inputSchema: { type: "object" } } as unknown as ToolDefinition;
    expect(canonicalizeToolDefinitions([noDesc])).toEqual([noDesc]);
  });

  it("9ed453c1 CACHE AC2: composes with compactToolDefinitions in either order", () => {
    const t = [shell(orderings[0]!)];
    expect(compactToolDefinitions(canonicalizeToolDefinitions(t))).toEqual(canonicalizeToolDefinitions(compactToolDefinitions(t)));
  });
});

describe("9ed453c1 CACHE AC4: anthropic request body is identical across two tasks of the same agent", () => {
  const logger: EngineLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const HAIKU = "claude-haiku-4-5";
  interface IBody { tools?: unknown[]; system?: unknown; messages?: unknown }

  function chatOnce(bodies: IBody[], tools: ToolDefinition[]): Promise<unknown> {
    const fetchSeam: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as IBody);
      return new Response(anthropicSseBody({ model: HAIKU, text: "ok", usage: { input_tokens: 10, output_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const engineConfig = {
      server: { contextLimit: 0, defaultMaxTokens: 8192 },
      wire: { fetch: fetchSeam },
      getProviderConfig: () => ({ secret: "sk-ant-api-test", model: HAIKU }),
    } as unknown as EngineConfig;
    const provider = new AnthropicProvider({ type: "anthropic", model: HAIKU }, engineConfig, logger);
    return provider.chat({
      messages: [
        { role: "system", content: distinctFiller(1500, "sys") },
        { role: "user", content: distinctFiller(300, "usr") },
      ] as never,
      tools,
    });
  }

  // A big, stable sibling tool puts the prefix well above haiku-4-5's 4096-token minimum so the
  // breakpoints are actually placed.
  const filler: ToolDefinition = {
    name: "docs__search",
    description: distinctFiller(1800, "docs"),
    inputSchema: { type: "object", properties: {} },
  };
  const task = (cmds: string[]): ToolDefinition[] => [shell(cmds), filler];

  const cacheMarks = (b: IBody): string[] => {
    const marks: string[] = [];
    (b.tools ?? []).forEach((t, i) => "cache_control" in (t as object) && marks.push(`tools[${i}]`));
    if (Array.isArray(b.system)) b.system.forEach((s, i) => "cache_control" in (s as object) && marks.push(`system[${i}]`));
    return marks;
  };

  it("9ed453c1 CACHE AC4: two consecutive tasks (differently ordered allow-list) => identical `tools` JSON and cache_control placement", async () => {
    const bodies: IBody[] = [];
    await chatOnce(bodies, canonicalizeToolDefinitions(task(["ls", "cat", "echo", "pwd", "grep"])));
    await chatOnce(bodies, canonicalizeToolDefinitions(task(["grep", "pwd", "echo", "cat", "ls"])));
    expect(bodies).toHaveLength(2);
    expect(JSON.stringify(bodies[0]!.tools)).toBe(JSON.stringify(bodies[1]!.tools));
    expect(cacheMarks(bodies[0]!)).toEqual(cacheMarks(bodies[1]!));
    expect(cacheMarks(bodies[0]!)).toContain("tools[1]"); // breakpoint on the last tool is really placed
    expect(JSON.stringify(bodies[0]!.system)).toBe(JSON.stringify(bodies[1]!.system));
  });

  it("9ed453c1 CACHE AC4: negative control — WITHOUT canonicalization the two bodies' `tools` differ", async () => {
    const bodies: IBody[] = [];
    await chatOnce(bodies, task(["ls", "cat", "echo", "pwd", "grep"]));
    await chatOnce(bodies, task(["grep", "pwd", "echo", "cat", "ls"]));
    expect(JSON.stringify(bodies[0]!.tools)).not.toBe(JSON.stringify(bodies[1]!.tools));
  });
});
